import { htmlToTypst, mapImages, emitDocument, type TranspileOptions } from "html-to-typst";
import {
  CliBackend,
  type CliBackendOptions,
  type Diagnostic,
  type FontSource,
  type PageFormat,
  type TypstBackend,
} from "typst-compiler";
import { resolveAssets, type AssetOptions } from "./assets.js";

export interface RenderOptions extends TranspileOptions {
  assets?: AssetOptions;
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
}

export interface PagesResult extends Omit<PdfResult, "pdf"> {
  pages: Uint8Array[];
}

interface Prepared {
  source: string;
  files: Map<string, Uint8Array>;
  warnings: string[];
}

export interface PdfRendererOptions {
  /** Backend to use; defaults to a `CliBackend` owned by the renderer. */
  backend?: TypstBackend;
  /** Options for the default `CliBackend`. Ignored when `backend` is given. */
  cli?: CliBackendOptions;
  /** Defaults merged into every render call. */
  defaults?: RenderOptions;
}

/** Long-lived renderer: owns (or borrows) a backend and applies default options. */
export class PdfRenderer {
  readonly backend: TypstBackend;
  readonly #owned: boolean;
  readonly #defaults: RenderOptions;

  constructor(options: PdfRendererOptions = {}) {
    this.backend = options.backend ?? new CliBackend(options.cli);
    this.#owned = options.backend === undefined;
    this.#defaults = options.defaults ?? {};
  }

  async render(html: string, options: RenderOptions = {}): Promise<PdfResult> {
    const opts = this.#merge(options);
    const prepared = await prepare(html, opts);
    const result = await this.backend.compile({
      source: prepared.source,
      files: prepared.files,
      ...compileExtras(opts),
    });
    return { pdf: result.pdf, warnings: prepared.warnings, diagnostics: result.warnings, source: prepared.source };
  }

  async renderPages(html: string, options: RenderOptions & { format?: PageFormat; ppi?: number } = {}): Promise<PagesResult> {
    const opts = this.#merge(options);
    const prepared = await prepare(html, opts);
    const result = await this.backend.compilePages({
      source: prepared.source,
      files: prepared.files,
      format: options.format ?? "png",
      ...(options.ppi ? { ppi: options.ppi } : {}),
      ...compileExtras(opts),
    });
    return { pages: result.pages, warnings: prepared.warnings, diagnostics: result.warnings, source: prepared.source };
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

async function prepare(html: string, opts: RenderOptions): Promise<Prepared> {
  const transpiled = htmlToTypst(html, opts);
  const assets = await resolveAssets(transpiled.assets, opts.assets, opts.signal);
  mapImages(transpiled.document, (src) => {
    const mapped = assets.mapping.get(src);
    // Typst resolves "/…" against the project root, i.e. the virtual file map.
    return mapped ? `/${mapped}` : null;
  });
  return {
    source: emitDocument(transpiled.document),
    files: assets.files,
    warnings: [...transpiled.warnings, ...assets.warnings],
  };
}

function compileExtras(opts: RenderOptions) {
  return {
    ...(opts.fonts?.length ? { fonts: opts.fonts } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

let shared: PdfRenderer | undefined;

/** Converts HTML to a PDF with a process-wide default renderer. */
export function htmlToPdf(html: string, options?: RenderOptions): Promise<PdfResult> {
  shared ??= new PdfRenderer();
  return shared.render(html, options);
}

/** Renders HTML to one image per page with the process-wide default renderer. */
export function htmlToPages(html: string, options?: RenderOptions & { format?: PageFormat; ppi?: number }): Promise<PagesResult> {
  shared ??= new PdfRenderer();
  return shared.renderPages(html, options);
}

/** Disposes the process-wide default renderer (e.g. on shutdown). */
export async function disposeDefaultRenderer(): Promise<void> {
  const r = shared;
  shared = undefined;
  await r?.dispose();
}
