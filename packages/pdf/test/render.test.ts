import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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

  it("reports timings and the backend load", async () => {
    const r = await renderer.render("<p>x</p>");
    const t = r.timings;
    expect(t.totalMs).toBeGreaterThan(0);
    expect(t.compileMs).toBeGreaterThan(0);
    expect(t.transpileMs + t.assetsMs + t.compileMs).toBeLessThanOrEqual(t.totalMs + 0.5);
    expect(renderer.stats()).toMatchObject({ running: 0, queued: 0 });
    expect(renderer.stats()!.completed).toBeGreaterThan(0);
  });

  it("compiles headers with alignment and a sheet frame, page borders and cell alignment", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `<tr><td class="align-top">${i}</td><td>Fila ${i}<br>detalle</td></tr>`).join("");
    const header = '<div class="flex justify-between"><b>LOGO</b><div class="text-right">Folio 1<br>{{page}}/{{pages}}</div></div><p class="text-left">Cliente</p><div class="fixed inset-[4mm] border border-[#333]"></div>';
    const r = await renderer.render(
      { layout: { page: { size: "A4", margin: "15mm", header, border: "1px solid #999", padding: "2mm" } }, sections: [{ html: `<table class="w-full">${rows}</table>` }] },
      { tailwind: true, strict: true },
    );
    expect(Buffer.from(r.pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(r.warnings).toEqual([]);
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

// The worker runs from the built package (dist/transpile-worker.js); from source, conversion stays inline.
const hasWorker = existsSync(new URL("../dist/transpile-worker.js", import.meta.url));

describe.skipIf(!hasTypst || !hasWorker)("transpile workers", () => {
  it("converts in worker threads with the same result as inline", async () => {
    const { PdfRenderer: Built } = (await import(new URL("../dist/index.js", import.meta.url).href)) as typeof import("../src/index.js");
    const inline = new Built({ cli: {}, transpileWorkers: 0 });
    const threaded = new Built({ cli: {}, transpileWorkers: 2 });
    try {
      const html = '<table class="w-full">' + Array.from({ length: 20 }, (_, i) => `<tr><td class="p-1 align-top">${i}</td></tr>`).join("") + "</table>";
      const [a, b] = await Promise.all([inline.render(html, { tailwind: true }), threaded.render(html, { tailwind: true })]);
      expect(b.source).toBe(a.source);
      expect(threaded.stats()?.transpileWorkers).toBe(1);
      await expect(threaded.render('<div style="float:left">x</div>', { strict: true })).rejects.toMatchObject({ name: "TranspileError" });
    } finally {
      await inline.dispose();
      await threaded.dispose();
    }
  });
});
