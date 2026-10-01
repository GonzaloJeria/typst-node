import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AssetError, bundledFontsDir, CliBackend, PdfRenderer, resolveSidecarBinary, SidecarBackend } from "../src/index.js";

const hasTypst = spawnSync(process.env.TYPST_PATH ?? "typst", ["--version"]).status === 0;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe.skipIf(!hasTypst)("PdfRenderer", () => {
  const base = mkdtempSync(path.join(tmpdir(), "render-"));
  writeFileSync(path.join(base, "pixel.png"), Buffer.from(PNG, "base64"));
  const renderer = new PdfRenderer({ defaults: { assets: { baseDir: base }, css: "body { color: #111 }" } });
  afterAll(() => renderer.dispose());

  it("renders HTML with local and inline images to a PDF", async () => {
    const r = await renderer.render(
      `<h1>Hola</h1><p><img src="pixel.png" width="10"> <img src="data:image/png;base64,${PNG}" width="10"></p>`,
    );
    expect(Buffer.from(r.pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(r.warnings).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(r.source).toMatch(/image\(width: 7.5pt, "\/assets\/[0-9a-f]{16}\.png"\)/);
    expect(r.source).toContain('fill: rgb("#111111")');
  });

  it("drops unresolvable images with onError: skip", async () => {
    const r = await renderer.render('<p>a <img src="missing.png"> b</p>', { assets: { onError: "skip" } });
    expect(r.warnings[0]).toMatch(/missing\.png: file not found/);
    expect(r.source).not.toContain("image(");
  });

  it("fails on unresolvable images by default", async () => {
    await expect(renderer.render('<img src="missing.png">')).rejects.toBeInstanceOf(AssetError);
  });

  it("surfaces transpiler warnings", async () => {
    const r = await renderer.render('<div style="float: right">x</div>');
    expect(r.warnings).toEqual(["Unsupported CSS ignored: float: right (<div>)"]);
  });

  it("renders page images", async () => {
    const r = await renderer.renderPages('<p>uno</p><p style="break-before: page">dos</p>', { ppi: 20 });
    expect(r.pages).toHaveLength(2);
  });

  it("does not dispose a borrowed backend", async () => {
    const borrowed = new PdfRenderer({ backend: renderer.backend });
    await borrowed.dispose();
    await expect(renderer.render("<p>still alive</p>")).resolves.toBeDefined();
  });

  it("renders sans-serif with the bundled Inter font", async () => {
    const { source, diagnostics } = await renderer.render('<p style="font-family: sans-serif">Hola</p>');
    expect(source).toContain('"Inter"');
    expect(diagnostics).toEqual([]);
  });
});

describe.skipIf(!hasTypst)("@font-face", () => {
  // Without the bundled fonts, Inter is only reachable through @font-face.
  const renderer = new PdfRenderer({ bundledFonts: false, defaults: { assets: { baseDir: bundledFontsDir } } });
  afterAll(() => renderer.dispose());
  const css = (src: string) => `<style>@font-face { font-family: Brand; src: url(${src}) format("truetype") } p { font-family: Brand }</style>`;

  it("loads the font and maps the CSS family to the name inside the file", async () => {
    const r = await renderer.render(`${css("Inter-Bold.ttf")}<p>Hola</p>`);
    expect(r.warnings).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(r.source).toContain('font: ("Inter",)');
  });

  it("warns about WOFF fonts and missing files", async () => {
    const woff = await renderer.render(`<style>@font-face { font-family: W; src: url(a.woff2) format("woff2") }</style><p>x</p>`);
    expect(woff.warnings).toContain("@font-face W ignored: only TTF and OTF fonts are supported (not WOFF/WOFF2)");
    const missing = await renderer.render(`${css("nope.ttf")}<p>x</p>`, { assets: { onError: "skip" } });
    expect(missing.warnings[0]).toMatch(/^Cannot load font Brand \(nope\.ttf\)/);
  });
});

describe("bundled fonts", () => {
  it("ships Inter in bundledFontsDir", () => {
    expect(readdirSync(bundledFontsDir)).toEqual(expect.arrayContaining(["Inter-Regular.ttf", "Inter-Bold.ttf", "OFL.txt"]));
  });
});

describe("default backend", () => {
  it("uses the installed typst-sidecar when there is one, else the CLI", async () => {
    const r = new PdfRenderer();
    try {
      expect(r.backend).toBeInstanceOf(resolveSidecarBinary() ? SidecarBackend : CliBackend);
    } finally {
      await r.dispose();
    }
  });

  it("uses the CLI when cli options are given", async () => {
    const r = new PdfRenderer({ cli: { maxConcurrency: 1 } });
    expect(r.backend).toBeInstanceOf(CliBackend);
    await r.dispose();
  });

  it("uses the sidecar when sidecar options are given", async () => {
    const r = new PdfRenderer({ sidecar: { processes: 1 } });
    expect(r.backend).toBeInstanceOf(SidecarBackend);
    await r.dispose();
  });
});
