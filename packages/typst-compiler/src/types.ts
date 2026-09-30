/**
 * Backend-agnostic contract, implemented by `CliBackend` (one official
 * `typst` process per document) and `SidecarBackend` (long-lived
 * `typst-sidecar` processes), so callers never depend on how Typst runs.
 */

/** A font given either as raw bytes (TTF/OTF/TTC) or as a directory to scan. */
export type FontSource = Uint8Array | { dir: string };

export interface CompileRequest {
  /** Typst source of the main document. */
  source: string;
  /**
   * Virtual files visible to the document, keyed by project-relative POSIX path
   * (e.g. `assets/logo.png`). Reference them from Typst as `"assets/logo.png"`
   * or `"/assets/logo.png"`.
   */
  files?: ReadonlyMap<string, Uint8Array>;
  /** Extra fonts for this compilation, on top of the backend defaults. */
  fonts?: readonly FontSource[];
  /** String values exposed through `sys.inputs`. */
  inputs?: Readonly<Record<string, string>>;
  /** Overrides the backend default timeout. */
  timeoutMs?: number;
  /** Cancels the compilation (queued or running). */
  signal?: AbortSignal;
}

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** File the diagnostic points at; `<stdin>` for the main source. */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  hints: string[];
}

export interface CompileResult {
  pdf: Uint8Array;
  warnings: Diagnostic[];
  durationMs: number;
}

export type PageFormat = "png" | "svg";

export interface PagesRequest extends CompileRequest {
  format: PageFormat;
  /** Pixels per inch for PNG output. Default: 144. */
  ppi?: number;
}

export interface PagesResult {
  /** One PNG or SVG per page, in page order. */
  pages: Uint8Array[];
  warnings: Diagnostic[];
  durationMs: number;
}

export interface TypstBackend {
  /** Compiles to a PDF. */
  compile(request: CompileRequest): Promise<CompileResult>;
  /** Renders every page to an image (previews, thumbnails, visual tests). */
  compilePages(request: PagesRequest): Promise<PagesResult>;
  /** Rejects queued work, kills in-flight work and releases resources. */
  dispose(): Promise<void>;
}
