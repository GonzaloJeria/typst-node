import type { Diagnostic } from "./types.js";

export class TypstError extends Error {
  override name = "TypstError";
}

/** The document failed to compile; `diagnostics` holds the parsed errors. */
export class TypstCompileError extends TypstError {
  override name = "TypstCompileError";
  constructor(
    readonly diagnostics: Diagnostic[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    const first = diagnostics.find((d) => d.severity === "error");
    super(
      first
        ? `Typst compilation failed: ${formatLocation(first)}${first.message}`
        : `Typst compilation failed (exit code ${exitCode}): ${stderr.trim() || "no output"}`,
    );
  }
}

export class TypstTimeoutError extends TypstError {
  override name = "TypstTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`Typst compilation exceeded ${timeoutMs} ms and was killed`);
  }
}

export class TypstAbortError extends TypstError {
  override name = "TypstAbortError";
  constructor() {
    super("Typst compilation was aborted");
  }
}

export class TypstBinaryError extends TypstError {
  override name = "TypstBinaryError";
}

export class TypstDisposedError extends TypstError {
  override name = "TypstDisposedError";
  constructor() {
    super("Backend has been disposed");
  }
}

function formatLocation(d: Diagnostic): string {
  if (d.file === undefined) return "";
  return d.line === undefined ? `${d.file}: ` : `${d.file}:${d.line}:${d.column ?? 0}: `;
}
