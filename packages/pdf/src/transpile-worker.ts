/**
 * Worker thread entry: converts HTML to the Typst IR off the main thread, so
 * a large document does not block the event loop and several documents
 * convert in parallel. See `TranspilePool`.
 */
import { parentPort } from "node:worker_threads";
import { composeToTypst, htmlToTypst, type ComposeInput, type TranspileOptions } from "@typdf/html-to-typst";

export interface TranspileJob {
  id: number;
  input: string | ComposeInput;
  options: TranspileOptions;
}

parentPort?.on("message", ({ id, input, options }: TranspileJob) => {
  try {
    const { document, warnings, assets, fontFaces } = typeof input === "string" ? htmlToTypst(input, options) : composeToTypst(input, options);
    parentPort!.postMessage({ id, ok: true, result: { document, warnings, assets, fontFaces } });
  } catch (err) {
    const e = err as Error & { warnings?: string[] };
    parentPort!.postMessage({ id, ok: false, error: { name: e.name, message: e.message, stack: e.stack, warnings: e.warnings } });
  }
});
