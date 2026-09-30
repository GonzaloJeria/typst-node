import { composeToTypst, htmlToTypst, mapImages, emitDocument, type ComposeInput, type TranspileOptions } from "@gjeria/html-to-typst";
import {
  CliBackend,
  SidecarBackend,
  resolveSidecarBinary,
  type CliBackendOptions,
  type SidecarBackendOptions,
  type Diagnostic,
  type FontSource,
  type PageFormat,
  type TypstBackend,
} from "@gjeria/typst-compiler";
import { fileURLToPath } from "node:url";
import { resolveAssets, type AssetOptions } from "./assets.js";

/**
 * Directory with the fonts shipped in this package (Inter, SIL OFL), which
 * CSS `sans-serif` and `system-ui` resolve to. Renderers that create their
 * own backend add it automatically; add `{ dir: bundledFontsDir }` to the
 * fonts of a backend you create yourself.
 */
export const bundledFontsDir = fileURLToPath(new URL("../fonts", import.meta.url));

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
    const opts = this.#merge(options);
    const prepared = await prepare(html, opts);
    const result = await this.backend.compile({
      source: prepared.source,
      files: prepared.files,
      ...compileExtras(opts),
    });
    return { pdf: result.pdf, warnings: prepared.warnings, diagnostics: result.warnings, source: prepared.source };
  }

  async renderPages(html: RenderInput, options: RenderOptions & { format?: PageFormat; ppi?: number } = {}): Promise<PagesResult> {
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

  /** Starts the backend's processes ahead of the first render, when it supports it. */
  async warmup(): Promise<void> {
    const backend = this.backend as TypstBackend & { warmup?(): Promise<void> };
    await backend.warmup?.();
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

async function prepare(input: RenderInput, opts: RenderOptions): Promise<Prepared> {
  const transpiled = typeof input === "string" ? htmlToTypst(input, opts) : composeToTypst(input, opts);
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
