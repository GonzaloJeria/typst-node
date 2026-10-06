export {
  disposeDefaultRenderer,
  htmlToPages,
  htmlToPdf,
  PdfRenderer,
  type PagesResult,
  type PdfRendererOptions,
  type PdfResult,
  type RenderInput,
  type RenderOptions,
  type RendererStats,
  type RenderTimings,
} from "./render.js";
export { bundledFontsDir } from "./render.js";
export { classCandidates, pageWidth, tailwindCss, type TailwindOptions, type TailwindResult } from "./tailwind.js";
export { AssetError, resolveAssets, sniffImage, type AssetOptions, type ResolvedAssets } from "./assets.js";
export { fontFamilyName, resolveFonts, type ResolvedFonts } from "./fonts.js";
export { isPrivateAddress } from "./net.js";
export type { ComposeInput, Layout, PageOptions, Section, TranspileOptions } from "@typdf/html-to-typst";

// Typst compiler: backends, errors and diagnostics.
export type {
  BackendStats,
  CompileRequest,
  CompileResult,
  Diagnostic,
  DiagnosticSeverity,
  FontSource,
  PageFormat,
  PagesRequest,
  PagesResult as CompilePagesResult,
  TypstBackend,
} from "./compiler/index.js";
export {
  CliBackend,
  parseDiagnostics,
  resolveSidecarBinary,
  SidecarBackend,
  TypstAbortError,
  TypstBinaryError,
  TypstCompileError,
  TypstDisposedError,
  TypstError,
  TypstQueueFullError,
  TypstTimeoutError,
} from "./compiler/index.js";
export type { CliBackendOptions, SidecarBackendOptions } from "./compiler/index.js";

// Templates: Handlebars + Tailwind from files or a database, with a live preview.
export * from "./templates/index.js";
