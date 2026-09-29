import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CliBackend,
  TypstAbortError,
  TypstBinaryError,
  TypstCompileError,
  TypstDisposedError,
  TypstTimeoutError,
} from "../src/index.js";

// Integration tests run against the official binary; skipped when absent.
const binary = process.env.TYPST_PATH ?? "typst";
const hasTypst = (() => {
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const pdfHeader = (pdf: Uint8Array) => Buffer.from(pdf.subarray(0, 5)).toString("latin1");
// A document that takes several seconds to lay out.
const SLOW = "#for i in range(1000000) [#i ]";

describe.skipIf(!hasTypst)("CliBackend (official typst binary)", () => {
  const tmpBase = mkdtempSync(path.join(tmpdir(), "typst-test-"));
  const backend = new CliBackend({ tmpDir: tmpBase, creationTimestamp: 0 });
  afterAll(() => backend.dispose());

  it("verifies the binary version", async () => {
    await expect(backend.verify()).resolves.toMatch(/^\d+\.\d+\.\d+$/);
    await expect(new CliBackend({ minVersion: "99.0.0" }).verify()).rejects.toBeInstanceOf(TypstBinaryError);
  });

  it("compiles a string to a PDF buffer", async () => {
    const { pdf, warnings, durationMs } = await backend.compile({ source: "= Hola\nMundo *Typst*" });
    expect(pdfHeader(pdf)).toBe("%PDF-");
    expect(warnings).toEqual([]);
    expect(durationMs).toBeGreaterThan(0);
  });

  it("is byte-reproducible with a fixed creation timestamp", async () => {
    const a = await backend.compile({ source: "Reproducible" });
    const b = await backend.compile({ source: "Reproducible" });
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
  });

  it("exposes virtual files relative to the root", async () => {
    const { pdf } = await backend.compile({
      source: '#image("assets/pixel.png", width: 1cm)\n#image("/assets/pixel.png", width: 1cm)',
      files: new Map([["assets/pixel.png", PNG]]),
    });
    expect(pdfHeader(pdf)).toBe("%PDF-");
  });

  it("passes sys.inputs", async () => {
    const ok = await backend.compile({
      source: '#assert.eq(sys.inputs.name, "Ada = Lovelace")\n#sys.inputs.name',
      inputs: { name: "Ada = Lovelace" },
    });
    expect(pdfHeader(ok.pdf)).toBe("%PDF-");
    await expect(backend.compile({ source: "", inputs: { "a=b": "x" } })).rejects.toThrow(TypeError);
  });

  it("renders pages to PNG and SVG in page order", async () => {
    const source = "#set page(width: 2cm, height: 2cm)\nuno #pagebreak() dos #pagebreak() tres";
    const png = await backend.compilePages({ source, format: "png", ppi: 72 });
    expect(png.pages).toHaveLength(3);
    for (const page of png.pages) expect(Buffer.from(page.subarray(1, 4)).toString("latin1")).toBe("PNG");
    // 2cm at 72 ppi ≈ 57 px wide (IHDR width at byte 16).
    expect(Buffer.from(png.pages[0]!).readUInt32BE(16)).toBe(57);
    const svg = await backend.compilePages({ source, format: "svg" });
    expect(svg.pages).toHaveLength(3);
    expect(Buffer.from(svg.pages[2]!).toString("utf8")).toContain("<svg");
  });

  it("reports compile errors with parsed diagnostics", async () => {
    const err = await backend.compile({ source: "ok\n#unknown_fn()" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypstCompileError);
    const { diagnostics } = err as TypstCompileError;
    expect(diagnostics[0]).toMatchObject({ severity: "error", file: "<stdin>", line: 2 });
    expect(diagnostics[0]!.column).toEqual(expect.any(Number));
    expect(diagnostics[0]!.message).toContain("unknown variable");
  });

  it("reports missing files", async () => {
    const err = (await backend.compile({ source: '#image("nope.png")' }).catch((e: unknown) => e)) as TypstCompileError;
    expect(err).toBeInstanceOf(TypstCompileError);
    expect(err.diagnostics[0]!.message).toContain("file not found");
  });

  it("returns warnings for successful compilations", async () => {
    const { warnings } = await backend.compile({ source: '#set text(font: "Definitely Not A Font")\nHi' });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.severity).toBe("warning");
  });

  it("loads fonts from memory while ignoring system fonts", async () => {
    const fontFile = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    if (!existsSync(fontFile)) return;
    const source = '#set text(font: "DejaVu Sans", fallback: false)\nHola';
    const without = await backend.compile({ source });
    expect(without.warnings.some((w) => w.message.includes("unknown font family"))).toBe(true);
    const withFont = await backend.compile({ source, fonts: [new Uint8Array(readFileSync(fontFile))] });
    expect(withFont.warnings).toEqual([]);
  });

  it("kills the process on timeout", async () => {
    const started = Date.now();
    await expect(backend.compile({ source: SLOW, timeoutMs: 300 })).rejects.toBeInstanceOf(TypstTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("aborts running and queued compilations", async () => {
    const ac = new AbortController();
    const p = backend.compile({ source: SLOW, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toBeInstanceOf(TypstAbortError);
    await expect(backend.compile({ source: "x", signal: AbortSignal.abort() })).rejects.toBeInstanceOf(TypstAbortError);
  });

  it("respects maxConcurrency under load", async () => {
    const limited = new CliBackend({ maxConcurrency: 2, tmpDir: tmpBase });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => limited.compile({ source: `Documento ${i}` })),
    );
    expect(results.every((r) => pdfHeader(r.pdf) === "%PDF-")).toBe(true);
    await limited.dispose();
  });

  it("rejects work after dispose and kills in-flight jobs", async () => {
    const b = new CliBackend({ maxConcurrency: 1, tmpDir: tmpBase });
    const running = expect(b.compile({ source: SLOW })).rejects.toBeInstanceOf(TypstDisposedError);
    const queued = expect(b.compile({ source: "x" })).rejects.toBeInstanceOf(TypstDisposedError);
    await new Promise((r) => setTimeout(r, 100));
    await b.dispose();
    await Promise.all([running, queued]);
    await expect(b.compile({ source: "x" })).rejects.toBeInstanceOf(TypstDisposedError);
  });

  it("cleans up every temporary root", async () => {
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(tmpBase)).toEqual([]);
  });
});

describe("CliBackend without binary", () => {
  it("fails with TypstBinaryError", async () => {
    const b = new CliBackend({ binaryPath: "/nonexistent/typst" });
    await expect(b.compile({ source: "x" })).rejects.toBeInstanceOf(TypstBinaryError);
    await expect(b.verify()).rejects.toBeInstanceOf(TypstBinaryError);
  });
});
