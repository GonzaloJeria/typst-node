import { describe, expect, it } from "vitest";
import { parseDiagnostics } from "../src/diagnostics.js";

describe("parseDiagnostics", () => {
  it("parses located errors, warnings and hints", () => {
    const stderr = [
      "<stdin>:1:6: error: unknown variable: x",
      "hint: if you meant to display multiple letters as is, try adding spaces",
      "assets/doc.typ:10:2: warning: unknown font family: foo",
      "",
    ].join("\n");
    expect(parseDiagnostics(stderr)).toEqual([
      {
        severity: "error",
        message: "unknown variable: x",
        file: "<stdin>",
        line: 1,
        column: 6,
        hints: ["if you meant to display multiple letters as is, try adding spaces"],
      },
      {
        severity: "warning",
        message: "unknown font family: foo",
        file: "assets/doc.typ",
        line: 10,
        column: 2,
        hints: [],
      },
    ]);
  });

  it("parses errors without location", () => {
    expect(parseDiagnostics("error: failed to write PDF file\n")).toEqual([
      { severity: "error", message: "failed to write PDF file", hints: [] },
    ]);
  });

  it("handles Windows paths with drive letters", () => {
    const [d] = parseDiagnostics("C:\\tmp\\a.typ:3:4: error: boom");
    expect(d).toMatchObject({ file: "C:\\tmp\\a.typ", line: 3, column: 4, message: "boom" });
  });
});
