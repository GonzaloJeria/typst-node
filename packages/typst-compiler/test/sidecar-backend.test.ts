import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CliBackend,
  SidecarBackend,
  TypstAbortError,
  TypstBinaryError,
  TypstCompileError,
  TypstDisposedError,
  TypstTimeoutError,
} from "../src/index.js";

// Integration tests against the sidecar built from crates/typst-sidecar; skipped when absent.
const binary = process.env.TYPST_SIDECAR_PATH
  ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../crates/typst-sidecar/target/release/typst-sidecar");
const hasSidecar = existsSync(binary);

const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);
const SLOW = "#for i in range(1000000) [#i ]";
const header = (b: Uint8Array) => Buffer.from(b.subarray(0, 5)).toString("latin1");

describe.skipIf(!hasSidecar)("SidecarBackend", () => {
  const backend = new SidecarBackend({ binaryPath: binary, processes: 2, creationTimestamp: 0 });
  afterAll(() => backend.dispose());

  it("compiles to PDF with virtual files and inputs", async () => {
    const r = await backend.compile({
      source: '#image("assets/dot.png", width: 1cm)\n= Hola #sys.inputs.name',
      files: new Map([["assets/dot.png", PNG]]),
      inputs: { name: "Ada" },
    });
    expect(header(r.pdf)).toBe("%PDF-");
    expect(r.warnings).toEqual([]);
  });

  it("is byte-reproducible with a fixed creation timestamp", async () => {
    const a = await backend.compile({ source: "= Same" });
    const b = await backend.compile({ source: "= Same" });
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
  });

  it("renders pages to PNG and SVG", async () => {
    const png = await backend.compilePages({ source: "a\n#pagebreak()\nb", format: "png", ppi: 30 });
    expect(png.pages).toHaveLength(2);
    expect(Buffer.from(png.pages[0]!.subarray(1, 4)).toString()).toBe("PNG");
    const svg = await backend.compilePages({ source: "a", format: "svg" });
    expect(Buffer.from(svg.pages[0]!).toString()).toContain("<svg");
  });

  it("renders the same output as the official CLI", async () => {
    const cli = new CliBackend({ creationTimestamp: 0 });
    try {
      const source = '#set page(width: 6cm, height: auto)\n= Título\n#lorem(30)\n#raw(lang: "rust", "fn main() {}", block: true)';
      // SVG is a deterministic text rendering of the laid-out pages.
      const a = await backend.compilePages({ source, format: "svg" });
      const b = await cli.compilePages({ source, format: "svg" });
      expect(a.pages.map((p) => Buffer.from(p).toString())).toEqual(b.pages.map((p) => Buffer.from(p).toString()));
    } catch (err) {
      if ((err as Error).name === "TypstBinaryError") return; // No official CLI installed.
      throw err;
    } finally {
      await cli.dispose();
    }
  });

  it("reports errors with locations and warnings", async () => {
    const err = await backend.compile({ source: "= Ok\n#let x = \n" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypstCompileError);
    expect((err as TypstCompileError).diagnostics[0]).toMatchObject({ severity: "error", file: "<stdin>", line: 2 });
    const missing = await backend.compile({ source: '#image("nope.png")' }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(TypstCompileError);
    const warned = await backend.compile({ source: '#text(font: "No Such Font")[x]' });
    expect(warned.warnings[0]?.message).toMatch(/unknown font family/);
  });

  it("rejects paths that escape the project", async () => {
    await expect(backend.compile({ source: "x", files: new Map([["../x", PNG]]) })).rejects.toThrow(TypeError);
  });

  it("kills and replaces a process on timeout", async () => {
    await expect(backend.compile({ source: SLOW, timeoutMs: 200 })).rejects.toBeInstanceOf(TypstTimeoutError);
    const r = await backend.compile({ source: "= After" });
    expect(header(r.pdf)).toBe("%PDF-");
  });

  it("aborts queued and running work", async () => {
    const controller = new AbortController();
    const running = backend.compile({ source: SLOW, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toBeInstanceOf(TypstAbortError);
    await expect(backend.compile({ source: "x", signal: AbortSignal.abort() })).rejects.toBeInstanceOf(TypstAbortError);
  });

  it("runs requests concurrently across processes", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => backend.compile({ source: `= Doc ${i}` })));
    expect(results.every((r) => header(r.pdf) === "%PDF-")).toBe(true);
  });

  it("recycles processes after maxCompilationsPerProcess", async () => {
    const small = new SidecarBackend({ binaryPath: binary, processes: 1, maxCompilationsPerProcess: 2 });
    try {
      for (let i = 0; i < 5; i++) expect(header((await small.compile({ source: `= ${i}` })).pdf)).toBe("%PDF-");
    } finally {
      await small.dispose();
    }
  });

  it("rejects work after dispose", async () => {
    const b = new SidecarBackend({ binaryPath: binary, processes: 1 });
    await b.warmup();
    await b.dispose();
    await expect(b.compile({ source: "x" })).rejects.toBeInstanceOf(TypstDisposedError);
  });
});

describe("SidecarBackend without a binary", () => {
  it("fails with TypstBinaryError", async () => {
    const b = new SidecarBackend({ binaryPath: "/nonexistent/typst-sidecar", processes: 1 });
    await expect(b.compile({ source: "x" })).rejects.toBeInstanceOf(TypstBinaryError);
    await b.dispose();
  });
});
