import { composeToTypst, htmlToTypst, mapImages, emitDocument, type ComposeInput, type TranspileOptions } from "@gjeria/html-to-typst";
import {
  CliBackend,
  SidecarBackend,
  resolveSidecarBinary,
  type BackendStats,
  type CliBackendOptions,
  type SidecarBackendOptions,
  type Diagnostic,
  type FontSource,
  type PageFormat,
  type TypstBackend,
} from "@gjeria/typst-compiler";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveFonts } from "./fonts.js";
import { resolveAssets, type AssetOptions } from "./assets.js";
import { tailwindCss } from "./tailwind.js";

/**
 * Directory with the fonts shipped in this package (Inter, SIL OFL), which
 * CSS `sans-serif` and `system-ui` resolve to. Renderers that create their
 * own backend add it automatically; add `{ dir: bundledFontsDir }` to the
 * fonts of a backend you create yourself.
 */
export const bundledFontsDir = fileURLToPath(new URL("../fonts", import.meta.url));

export interface RenderOptions extends TranspileOptions {
  assets?: AssetOptions;
  /**
   * Generate Tailwind CSS v4 for the classes the HTML uses (bundled, nothing
   * to install). `<style>` blocks and `css` go through Tailwind too, so they
   * can use `@theme`, `@apply` and `@utility`. Default: false.
   */
  tailwind?: boolean;
  /** Extra fonts for this render. */
  fonts?: readonly FontSource[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PdfResult {
  pdf: Uint8Array;
  /** Transpiler and asset warnings: what was dropped or approximated. */
  warnings: string[];
  /** Warnings reported by the Typst compiler. */
  diagnostics: Diagnostic[];
  /** Generated Typst source, for debugging. */
  source: string;
  /** Where the time went, in ms, for logs and metrics. */
  timings: RenderTimings;
}

export interface RenderTimings {
  /** HTML/CSS to Typst, Tailwind included. */
  transpileMs: number;
  /** Loading images and fonts (remote downloads included). */
  assetsMs: number;
  /** Typst compilation, including the wait for a free process. */
  compileMs: number;
  totalMs: number;
}

export interface PagesResult extends Omit<PdfResult, "pdf"> {
  pages: Uint8Array[];
}

interface Prepared {
  transpileMs: number;
  assetsMs: number;
  source: string;
  files: Map<string, Uint8Array>;
  /** `@font-face` fonts loaded for this document. */
  fonts: Uint8Array[];
  warnings: string[];
}

/** A single HTML document, or sections composed over a shared layout. */
export type RenderInput = string | ComposeInput;

export interface PdfRendererOptions {
  /** Backend to use; defaults to a `CliBackend` owned by the renderer. */
  backend?: TypstBackend;
  /**
   * Use the official `typst` CLI (one process per document) with these
   * options. By default the renderer uses the prebuilt `typst-sidecar`
   * installed with the package, and falls back to the CLI without it.
   */
  cli?: CliBackendOptions;
  /** Options for the default `SidecarBackend` (long-lived Typst processes). */
  sidecar?: SidecarBackendOptions | true;
  /** Defaults merged into every render call. */
  defaults?: RenderOptions;
  /** Add the bundled fonts to the backend the renderer creates. Default: true. */
  bundledFonts?: boolean;
}

/** Long-lived renderer: owns (or borrows) a backend and applies default options. */
export class PdfRenderer {
  readonly backend: TypstBackend;
  readonly #owned: boolean;
  readonly #defaults: RenderOptions;

  constructor(options: PdfRendererOptions = {}) {
    this.backend = options.backend ?? defaultBackend(options);
    this.#owned = options.backend === undefined;
    this.#defaults = options.defaults ?? {};
  }

  async render(html: RenderInput, options: RenderOptions = {}): Promise<PdfResult> {
    const start = performance.now();
    const opts = this.#merge(options);
    const prepared = await prepare(html, opts);
    const compileStart = performance.now();
    const result = await this.backend.compile({
      source: prepared.source,
      files: prepared.files,
      ...compileExtras(opts, prepared.fonts),
    });
    return { pdf: result.pdf, warnings: prepared.warnings, diagnostics: result.warnings, source: prepared.source, timings: timings(prepared, compileStart, start) };
  }

  async renderPages(html: RenderInput, options: RenderOptions & { format?: PageFormat; ppi?: number } = {}): Promise<PagesResult> {
    const start = performance.now();
    const opts = this.#merge(options);
    const prepared = await prepare(html, opts);
    const compileStart = performance.now();
    const result = await this.backend.compilePages({
      source: prepared.source,
      files: prepared.files,
      format: options.format ?? "png",
      ...(options.ppi ? { ppi: options.ppi } : {}),
      ...compileExtras(opts, prepared.fonts),
    });
    return { pages: result.pages, warnings: prepared.warnings, diagnostics: result.warnings, source: prepared.source, timings: timings(prepared, compileStart, start) };
  }

  /** Starts the backend's processes ahead of the first render, when it supports it. */
  async warmup(): Promise<void> {
    const backend = this.backend as TypstBackend & { warmup?(): Promise<void> };
    await backend.warmup?.();
  }

  /**
   * The backend's current load (processes, running, queued, totals), for a
   * health check or metrics. Undefined for a custom backend without `stats()`.
   */
  stats(): BackendStats | undefined {
    return this.backend.stats?.();
  }

  async dispose(): Promise<void> {
    if (this.#owned) await this.backend.dispose();
  }

  #merge(options: RenderOptions): RenderOptions {
    const d = this.#defaults;
    return {
      ...d,
      ...options,
      assets: { ...d.assets, ...options.assets },
      fonts: [...(d.fonts ?? []), ...(options.fonts ?? [])],
      ...(d.css && options.css ? { css: `${d.css}\n${options.css}` } : {}),
    };
  }
}

function defaultBackend(options: PdfRendererOptions): TypstBackend {
  const withFonts = <T extends { fonts?: readonly FontSource[] }>(o: T): T =>
    options.bundledFonts === false ? o : { ...o, fonts: [...(o.fonts ?? []), { dir: bundledFontsDir }] };
  if (options.cli && !options.sidecar) return new CliBackend(withFonts(options.cli));
  const sidecar = options.sidecar === true ? {} : options.sidecar ?? {};
  if (options.sidecar || sidecar.binaryPath || resolveSidecarBinary()) return new SidecarBackend(withFonts(sidecar));
  return new CliBackend(withFonts({}));
}

const round = (ms: number) => Math.round(ms * 10) / 10;

function timings(prepared: Prepared, compileStart: number, start: number): RenderTimings {
  const end = performance.now();
  return { transpileMs: round(prepared.transpileMs), assetsMs: round(prepared.assetsMs), compileMs: round(end - compileStart), totalMs: round(end - start) };
}

async function prepare(rawInput: RenderInput, rawOpts: RenderOptions): Promise<Prepared> {
  const t0 = performance.now();
  let assetsMs = 0;
  const { input, opts, warnings: tailwindWarnings } = rawOpts.tailwind ? await withTailwind(rawInput, rawOpts) : { input: rawInput, opts: rawOpts, warnings: [] };
  const transpile = (o: RenderOptions) => (typeof input === "string" ? htmlToTypst(input, o) : composeToTypst(input, o));
  let transpiled = transpile(opts);
  let t = performance.now();
  const fonts = await resolveFonts(transpiled.fontFaces, opts.assets, opts.signal);
  assetsMs += performance.now() - t;
  // Families named differently in CSS than in the font file: convert again with aliases.
  if (Object.keys(fonts.aliases).length) transpiled = transpile({ ...opts, fontAliases: { ...fonts.aliases, ...opts.fontAliases } });
  t = performance.now();
  const assets = await resolveAssets(transpiled.assets, opts.assets, opts.signal);
  assetsMs += performance.now() - t;
  mapImages(transpiled.document, (src) => {
    const mapped = assets.mapping.get(src);
    // Typst resolves "/…" against the project root, i.e. the virtual file map.
    return mapped ? `/${mapped}` : null;
  });
  const source = emitDocument(transpiled.document);
  return {
    transpileMs: performance.now() - t0 - assetsMs,
    assetsMs,
    source,
    files: assets.files,
    fonts: fonts.fonts,
    warnings: [...tailwindWarnings, ...transpiled.warnings, ...fonts.warnings, ...assets.warnings],
  };
}

/** Moves `<style>` blocks out of the HTML, so their CSS can go through Tailwind. */
function takeStyles(html: string): { html: string; css: string[] } {
  const css: string[] = [];
  const rest = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_, body: string) => (css.push(body), ""));
  return { html: rest, css };
}

/** Compiles Tailwind into the CSS of the document, or of each section. */
async function withTailwind(input: RenderInput, opts: RenderOptions): Promise<{ input: RenderInput; opts: RenderOptions; warnings: string[] }> {
  const baseDir = opts.assets?.baseDir;
  if (typeof input === "string") {
    const { html, css } = takeStyles(input);
    const tw = await tailwindCss(html, [...css, opts.css ?? ""].join("\n"), baseDir ? { baseDir } : {});
    return { input: html, opts: { ...opts, css: tw.css }, warnings: tw.warnings };
  }
  const warnings: string[] = [];
  const sections = await Promise.all(
    input.sections.map(async (section, i) => {
      const page = { ...input.layout?.page, ...section.page };
      const { html, css } = takeStyles(section.html);
      // Header and footer HTML is placed on the section's pages: their classes count too.
      const decoration = [page.header, page.footer].filter((v): v is string => typeof v === "string").join("\n");
      const size = page.size ? `@page { size: ${page.size} }` : "";
      const source = [size, input.layout?.css ?? "", section.css ?? "", ...css, opts.css ?? ""].join("\n");
      const tw = await tailwindCss(`${html}\n${decoration}`, source, baseDir ? { baseDir } : {});
      const label = input.sections.length > 1 ? `[section ${i + 1}] ` : "";
      warnings.push(...tw.warnings.map((w) => label + w));
      return { ...section, html, css: tw.css };
    }),
  );
  const { css: _layoutCss, ...layout } = input.layout ?? {};
  const { css: _css, ...rest } = opts;
  return { input: { ...input, layout, sections }, opts: rest, warnings };
}

function compileExtras(opts: RenderOptions, documentFonts: Uint8Array[] = []) {
  const fonts = [...(opts.fonts ?? []), ...documentFonts];
  return {
    ...(fonts.length ? { fonts } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

let shared: PdfRenderer | undefined;

/** Converts HTML to a PDF with a process-wide default renderer. */
export function htmlToPdf(html: RenderInput, options?: RenderOptions): Promise<PdfResult> {
  shared ??= new PdfRenderer();
  return shared.render(html, options);
}

/** Renders HTML to one image per page with the process-wide default renderer. */
export function htmlToPages(html: RenderInput, options?: RenderOptions & { format?: PageFormat; ppi?: number }): Promise<PagesResult> {
  shared ??= new PdfRenderer();
  return shared.renderPages(html, options);
}

/** Disposes the process-wide default renderer (e.g. on shutdown). */
export async function disposeDefaultRenderer(): Promise<void> {
  const r = shared;
  shared = undefined;
  await r?.dispose();
}
