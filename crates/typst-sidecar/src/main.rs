//! Long-lived Typst compiler for `typst-compiler`'s `SidecarBackend`.
//!
//! Loading fonts, syntax definitions and the standard library once and keeping
//! Typst's incremental caches warm removes the per-document startup cost of
//! running the official CLI for every compilation.
//!
//! Protocol: one JSON object per line on stdin (a request) and one JSON object
//! per line on stdout (the response to it). Requests are handled in order;
//! parallelism comes from running several sidecar processes.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic, Warned};
use typst::foundations::{Bytes, Datetime, Dict, Duration, IntoValue};
use typst_layout::PagedDocument;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_kit::fonts::{self as kit_fonts, FontStore};

#[cfg(target_env = "musl")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    source: String,
    #[serde(default)]
    files: HashMap<String, String>,
    #[serde(default)]
    fonts: Vec<String>,
    #[serde(default)]
    inputs: HashMap<String, String>,
    #[serde(default = "default_format")]
    format: String,
    ppi: Option<f64>,
    creation_timestamp: Option<i64>,
}

fn default_format() -> String {
    "pdf".into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: u64,
    ok: bool,
    /// PDF bytes, or one entry per page for PNG/SVG, base64-encoded.
    output: Vec<String>,
    diagnostics: Vec<Diagnostic>,
    duration_ms: f64,
}

#[derive(Serialize)]
struct Diagnostic {
    severity: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<usize>,
    hints: Vec<String>,
}

/// Fonts loaded once at startup: `--font-path` directories, then system fonts,
/// then the fonts embedded in Typst (the CLI's order).
struct BaseFonts {
    store: FontStore,
    infos: Vec<FontInfo>,
}

impl BaseFonts {
    fn load(paths: &[PathBuf], system: bool, embedded: bool) -> Self {
        let mut store = FontStore::new();
        let mut infos = Vec::new();
        let mut add = |store: &mut FontStore, entries: Vec<(Box<dyn kit_fonts::FontSource>, FontInfo)>| {
            for (source, info) in entries {
                infos.push(info.clone());
                store.push((BoxedSource(source), info));
            }
        };
        for path in paths {
            let entries = kit_fonts::scan(path).map(|(s, i)| (Box::new(s) as Box<dyn kit_fonts::FontSource>, i)).collect();
            add(&mut store, entries);
        }
        if system {
            let entries = kit_fonts::system().map(|(s, i)| (Box::new(s) as Box<dyn kit_fonts::FontSource>, i)).collect();
            add(&mut store, entries);
        }
        if embedded {
            let entries = kit_fonts::embedded().map(|(s, i)| (Box::new(s) as Box<dyn kit_fonts::FontSource>, i)).collect();
            add(&mut store, entries);
        }
        Self { store, infos }
    }
}

struct BoxedSource(Box<dyn kit_fonts::FontSource>);

impl kit_fonts::FontSource for BoxedSource {
    fn load(&self) -> Option<Font> {
        self.0.load()
    }
}

/// One compilation: the request's source and files over the shared fonts.
struct SidecarWorld<'a> {
    library: LazyHash<Library>,
    base: &'a BaseFonts,
    base_book: &'a LazyHash<FontBook>,
    /// Per-request fonts come first, so they win over installed families.
    extra: Vec<Font>,
    extra_book: Option<LazyHash<FontBook>>,
    main: FileId,
    source: Source,
    files: HashMap<FileId, Bytes>,
    now: chrono::DateTime<chrono::Utc>,
}

impl World for SidecarWorld<'_> {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.extra_book.as_ref().unwrap_or(self.base_book)
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            return Ok(self.source.clone());
        }
        let bytes = self.file(id)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| FileError::InvalidUtf8)?;
        Ok(Source::new(id, text.into()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main {
            return Ok(Bytes::from_string(self.source.text().to_string()));
        }
        self.files
            .get(&id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(PathBuf::from(id.vpath().get_with_slash())))
    }

    fn font(&self, index: usize) -> Option<Font> {
        if index < self.extra.len() {
            return Some(self.extra[index].clone());
        }
        self.base.store.font(index - self.extra.len())
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        use chrono::{Datelike, FixedOffset};
        let date = match offset {
            None => self.now.with_timezone(&chrono::Local).date_naive(),
            Some(offset) => self.now.with_timezone(&FixedOffset::east_opt(offset.seconds() as i32)?).date_naive(),
        };
        Datetime::from_ymd(date.year(), date.month().try_into().ok()?, date.day().try_into().ok()?)
    }
}

fn project_file(path: &str) -> Option<FileId> {
    let vpath = VirtualPath::new(path).ok()?;
    Some(RootedPath::new(VirtualRoot::Project, vpath).intern())
}

struct Sidecar {
    base: BaseFonts,
    base_book: LazyHash<FontBook>,
    /// Parsed request fonts by content, so repeated fonts are parsed once.
    font_cache: HashMap<String, Arc<Vec<Font>>>,
}

impl Sidecar {
    fn handle(&mut self, req: Request) -> Response {
        let start = Instant::now();
        let id = req.id;
        let result = self.compile(req);
        let (ok, output, diagnostics) = match result {
            Ok((output, diagnostics)) => (true, output, diagnostics),
            Err(diagnostics) => (false, Vec::new(), diagnostics),
        };
        // Keep memory bounded while retaining recently used cache entries.
        comemo::evict(10);
        Response { id, ok, output, diagnostics, duration_ms: start.elapsed().as_secs_f64() * 1000.0 }
    }

    fn compile(&mut self, req: Request) -> Result<(Vec<String>, Vec<Diagnostic>), Vec<Diagnostic>> {
        let fail = |message: String| vec![Diagnostic { severity: "error", message, file: None, line: None, column: None, hints: vec![] }];

        let mut extra = Vec::new();
        for encoded in &req.fonts {
            let fonts = match self.font_cache.get(encoded) {
                Some(fonts) => fonts.clone(),
                None => {
                    let data = B64.decode(encoded).map_err(|e| fail(format!("invalid font data: {e}")))?;
                    let fonts: Arc<Vec<Font>> = Arc::new(Font::iter(Bytes::new(data)).collect());
                    self.font_cache.insert(encoded.clone(), fonts.clone());
                    fonts
                }
            };
            extra.extend(fonts.iter().cloned());
        }
        let extra_book = (!extra.is_empty()).then(|| {
            let mut book = FontBook::new();
            for font in &extra {
                book.push(font.info().clone());
            }
            for info in &self.base.infos {
                book.push(info.clone());
            }
            LazyHash::new(book)
        });

        let mut files = HashMap::new();
        for (path, encoded) in &req.files {
            let file = project_file(path).ok_or_else(|| fail(format!("invalid file path: {path}")))?;
            let data = B64.decode(encoded).map_err(|e| fail(format!("invalid data for {path}: {e}")))?;
            files.insert(file, Bytes::new(data));
        }

        let mut inputs = Dict::new();
        for (key, value) in req.inputs {
            inputs.insert(key.as_str().into(), value.as_str().into_value());
        }
        let main = project_file("/main.typ").unwrap();
        let now = match req.creation_timestamp {
            Some(ts) => chrono::DateTime::from_timestamp(ts, 0).ok_or_else(|| fail("invalid creation timestamp".into()))?,
            None => chrono::Utc::now(),
        };
        let world = SidecarWorld {
            library: LazyHash::new(Library::builder().with_inputs(inputs).build()),
            base: &self.base,
            base_book: &self.base_book,
            extra,
            extra_book,
            main,
            source: Source::new(main, req.source),
            files,
            now,
        };

        let Warned { output, warnings } = typst::compile::<PagedDocument>(&world);
        let mut diagnostics: Vec<Diagnostic> = warnings.iter().map(|d| diagnostic(&world, d)).collect();
        let document = match output {
            Ok(document) => document,
            Err(errors) => {
                diagnostics.splice(0..0, errors.iter().map(|d| diagnostic(&world, d)));
                return Err(diagnostics);
            }
        };

        let output = match req.format.as_str() {
            "pdf" => {
                let timestamp = req.creation_timestamp.map(|_| {
                    use chrono::{Datelike, Timelike};
                    let t = world.now;
                    typst_pdf::Timestamp::new_utc(
                        Datetime::from_ymd_hms(t.year(), t.month() as u8, t.day() as u8, t.hour() as u8, t.minute() as u8, t.second() as u8)
                            .expect("valid datetime"),
                    )
                });
                let options = typst_pdf::PdfOptions { timestamp, ..Default::default() };
                match typst_pdf::pdf(&document, &options) {
                    Ok(pdf) => vec![B64.encode(pdf)],
                    Err(errors) => {
                        diagnostics.splice(0..0, errors.iter().map(|d| diagnostic(&world, d)));
                        return Err(diagnostics);
                    }
                }
            }
            "png" => {
                let options = typst_render::RenderOptions {
                    pixel_per_pt: (req.ppi.unwrap_or(144.0) / 72.0).into(),
                    ..Default::default()
                };
                let mut pages = Vec::new();
                for page in document.pages() {
                    let png = typst_render::render(page, &options).encode_png().map_err(|e| fail(format!("PNG encoding failed: {e}")))?;
                    pages.push(B64.encode(png));
                }
                pages
            }
            "svg" => document
                .pages()
                .iter()
                .map(|page| B64.encode(typst_svg::svg(page, &Default::default())))
                .collect(),
            other => return Err(fail(format!("unknown output format: {other}"))),
        };
        Ok((output, diagnostics))
    }
}

fn diagnostic(world: &SidecarWorld, d: &SourceDiagnostic) -> Diagnostic {
    let mut out = Diagnostic {
        severity: if d.severity == Severity::Error { "error" } else { "warning" },
        message: d.message.to_string(),
        file: None,
        line: None,
        column: None,
        hints: d.hints.iter().map(|h| h.v.to_string()).collect(),
    };
    if let (Some(id), Some(range)) = (d.span.id(), world.range(d.span)) {
        out.file = Some(if id == world.main { "<stdin>".into() } else { id.vpath().get_without_slash().into() });
        if let Ok(source) = world.source(id) {
            if let Some((line, column)) = source.lines().byte_to_line_column(range.start) {
                out.line = Some(line + 1);
                out.column = Some(column + 1);
            }
        }
    }
    out
}

fn main() {
    let mut font_paths = Vec::new();
    let mut system = true;
    let mut embedded = true;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--font-path" => font_paths.extend(args.next().map(PathBuf::from)),
            "--ignore-system-fonts" => system = false,
            "--ignore-embedded-fonts" => embedded = false,
            "--version" => {
                println!("typst-sidecar {} (typst 0.15.1)", env!("CARGO_PKG_VERSION"));
                return;
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    let base = BaseFonts::load(&font_paths, system, embedded);
    let base_book = LazyHash::new(FontBook::from_infos(base.infos.iter().cloned()));
    let fonts = base.infos.len();
    let mut sidecar = Sidecar { base, base_book, font_cache: HashMap::new() };

    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{}", serde_json::json!({ "ready": true, "typst": "0.15.1", "fonts": fonts })).ok();
    out.flush().ok();

    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(req) => sidecar.handle(req),
            Err(e) => Response {
                id: 0,
                ok: false,
                output: vec![],
                diagnostics: vec![Diagnostic { severity: "error", message: format!("invalid request: {e}"), file: None, line: None, column: None, hints: vec![] }],
                duration_ms: 0.0,
            },
        };
        if serde_json::to_writer(&mut out, &response).is_err() || writeln!(out).is_err() || out.flush().is_err() {
            break;
        }
    }
}
