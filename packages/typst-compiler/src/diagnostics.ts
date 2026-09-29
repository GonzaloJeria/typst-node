import type { Diagnostic, DiagnosticSeverity } from "./types.js";

// `--diagnostic-format short` emits one line per diagnostic:
//   <file>:<line>:<col>: error: <message>
//   error: <message>                      (no source location)
// optionally followed by `hint: <text>` lines.
const LOCATED = /^(.+?):(\d+):(\d+): (error|warning): (.*)$/;
const UNLOCATED = /^(error|warning): (.*)$/;
const HINT = /^\s*hint: (.*)$/;

export function parseDiagnostics(stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") continue;

    let m = LOCATED.exec(line);
    if (m) {
      out.push({
        severity: m[4] as DiagnosticSeverity,
        message: m[5]!,
        file: m[1]!,
        line: Number(m[2]),
        column: Number(m[3]),
        hints: [],
      });
      continue;
    }
    m = UNLOCATED.exec(line);
    if (m) {
      out.push({ severity: m[1] as DiagnosticSeverity, message: m[2]!, hints: [] });
      continue;
    }
    m = HINT.exec(line);
    const last = out.at(-1);
    if (m && last) {
      last.hints.push(m[1]!);
    } else if (last) {
      // Continuation of a multi-line message.
      last.message += `\n${line}`;
    }
  }
  return out;
}
