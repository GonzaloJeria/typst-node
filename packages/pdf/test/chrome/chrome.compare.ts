/**
 * Compares this library's output with Chrome's print output, page by page.
 *
 *   pnpm test:chrome                  # compare against the recorded scores
 *   UPDATE_CHROME=1 pnpm test:chrome  # record new scores
 *
 * Each fixture in fixtures/ is printed by Chromium (Playwright) and rendered
 * by the library; both are rasterized with Typst at the same resolution.
 * `<link rel="stylesheet" href="tailwind">` is replaced by Tailwind v4 CSS
 * compiled for that fixture, and `href="bootstrap"` by Bootstrap 5.
 *
 * The score is the share of matching pixels among those with content in
 * either rendering (blank paper is ignored), after a small blur so that it
 * tracks layout (positions, sizes, colors) rather than glyph rasterization. It fails
 * when a fixture scores clearly worse than recorded in chrome-scores.json.
 * Side-by-side images (Chrome | library | diff) go to __report__/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledFontsDir, PdfRenderer, tailwindCss } from "../../src/index.js";
import { decodePng, encodePng, type Image } from "../visual/png.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../../../..");
const FIXTURES = path.join(HERE, "fixtures");
const REPORT = path.join(HERE, "__report__");
const SCORES = path.join(HERE, "chrome-scores.json");
const PPI = 40;
/** A score may drop this much below the recorded one before the test fails. */
const TOLERANCE = 0.02;

const require = createRequire(import.meta.url);
const CHROMIUM = process.env.CHROMIUM_PATH ?? findChromium();
const TYPST = process.env.TYPST_PATH ?? "typst";
const updating = process.env.UPDATE_CHROME === "1";

function findChromium(): string | undefined {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const bin of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = path.join(base, dir, bin);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * Inlines the stylesheets fixtures reference by name. Tailwind is compiled
 * with the bundled compiler (`tailwind: true`), so Chrome and the library get
 * the same CSS users get.
 */
async function inlineStyles(html: string): Promise<string> {
  const tw = /<link rel="stylesheet" href="tailwind">/.test(html) ? (await tailwindCss(html)).css : "";
  return html.replace(/<link rel="stylesheet" href="(tailwind|bootstrap)">/g, (_, lib: string) => {
    const css = lib === "bootstrap" ? readFileSync(require.resolve("bootstrap/dist/css/bootstrap.css"), "utf8") : tw;
    return `<style>\n${css}\n</style>`;
  });
}

/** Makes Chromium use the library's bundled Inter wherever a sans-serif font is asked for. */
function fontconfig(): string {
  const file = path.join(REPORT, "fonts.conf");
  const sans = ["sans-serif", "sans", "Sans", "system-ui", "ui-sans-serif", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto",
    "Helvetica Neue", "Helvetica", "Arial", "Noto Sans", "Liberation Sans", "Ubuntu", "Cantarell", "Open Sans"];
  const mono = ["monospace", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New"];
  const alias = (names: string[], to: string) => names.map((n) =>
    `<match target="pattern"><test name="family"><string>${n}</string></test><edit name="family" mode="assign" binding="strong"><string>${to}</string></edit></match>`).join("\n");
  writeFileSync(file, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${bundledFontsDir}</dir>
  <dir>/usr/share/fonts/truetype/dejavu</dir>
  <cachedir>${path.join(REPORT, ".fccache")}</cachedir>
  ${alias(sans, "Inter")}
  ${alias(mono, "DejaVu Sans Mono")}
</fontconfig>`);
  return file;
}

/** Rasterizes a PDF with Typst, which can embed PDF pages as images. */
function rasterizePdf(pdf: Uint8Array, name: string): Uint8Array[] {
  const dir = path.join(REPORT, ".chrome", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "chrome.pdf"), pdf);
  const count = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  const pages = Array.from({ length: count }, (_, i) => `#page(image("chrome.pdf", page: ${i + 1}))`).join("\n");
  writeFileSync(path.join(dir, "main.typ"), `#set page(width: auto, height: auto, margin: 0pt)\n${pages}\n`);
  execFileSync(TYPST, ["compile", "--root", dir, path.join(dir, "main.typ"), path.join(dir, "p{0p}.png"), "--ppi", String(PPI)], { stdio: "pipe" });
  return readdirSync(dir).filter((f) => /^p\d+\.png$/.test(f)).sort().map((f) => readFileSync(path.join(dir, f)));
}

/** Box-blurred color comparison: the share of non-blank pixels within tolerance. */
function score(a: Image, b: Image): { score: number; diff: Image } {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const blurA = blur(a, width, height);
  const blurB = blur(b, width, height);
  const diff = new Uint8Array(width * height * 4);
  let same = 0;
  let inked = 0;
  const blank = (img: Float32Array, o: number) => img[o]! > 250 && img[o + 1]! > 250 && img[o + 2]! > 250;
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    const d = Math.max(Math.abs(blurA[o]! - blurB[o]!), Math.abs(blurA[o + 1]! - blurB[o + 1]!), Math.abs(blurA[o + 2]! - blurB[o + 2]!));
    const ok = d <= 40;
    if (!blank(blurA, o) || !blank(blurB, o)) {
      inked++;
      if (ok) same++;
    }
    const g = 255 - Math.round((255 - (blurA[o]! + blurA[o + 1]! + blurA[o + 2]!) / 3) * 0.3);
    diff.set(ok ? [g, g, g, 255] : [230, 0, 0, 255], i * 4);
  }
  return { score: inked ? same / inked : 1, diff: { width, height, data: diff } };
}

const RADIUS = 2;
function blur(img: Image, width: number, height: number): Float32Array {
  // RGB over white, padded to the common size with white.
  const src = new Float32Array(width * height * 3).fill(255);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3]! / 255;
      for (let c = 0; c < 3; c++) src[(y * width + x) * 3 + c] = img.data[i + c]! * a + 255 * (1 - a);
    }
  }
  const pass = (input: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let n = 0;
          for (let k = -RADIUS; k <= RADIUS; k++) {
            const xx = x + k * dx;
            const yy = y + k * dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            sum += input[(yy * width + xx) * 3 + c]!;
            n++;
          }
          out[(y * width + x) * 3 + c] = sum / n;
        }
      }
    }
    return out;
  };
  return pass(pass(src, 1, 0), 0, 1);
}

/** Chrome | library | diff, side by side. */
function sideBySide(images: Image[]): Image {
  const gap = 8;
  const width = images.reduce((w, i) => w + i.width, 0) + gap * (images.length - 1);
  const height = Math.max(...images.map((i) => i.height));
  const data = new Uint8Array(width * height * 4).fill(200);
  let x0 = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        const a = img.data[s + 3]! / 255;
        const d = (y * width + x0 + x) * 4;
        for (let c = 0; c < 3; c++) data[d + c] = Math.round(img.data[s + c]! * a + 255 * (1 - a));
        data[d + 3] = 255;
      }
    }
    x0 += img.width + gap;
  }
  return { width, height, data };
}

const blank = (like: Image): Image => ({ width: like.width, height: like.height, data: new Uint8Array(like.width * like.height * 4).fill(255) });

const fixtures = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort() : [];
const recorded: Record<string, number[]> = existsSync(SCORES) ? JSON.parse(readFileSync(SCORES, "utf8")) : {};
const results: Record<string, number[]> = {};

describe.skipIf(!CHROMIUM)("output compared with Chrome", () => {
  let browser: import("playwright-core").Browser;
  const renderer = new PdfRenderer({ cli: { creationTimestamp: 0 } });

  beforeAll(async () => {
    mkdirSync(REPORT, { recursive: true });
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: CHROMIUM!, env: { ...process.env, FONTCONFIG_FILE: fontconfig() } });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await renderer.dispose();
    const lines = Object.entries(results).map(([f, s]) => `  ${f.padEnd(28)} ${s.map((x) => `${(x * 100).toFixed(1)}%`).join("  ")}`);
    console.log(`Similarity to Chrome (per page):\n${lines.join("\n")}`);
    if (updating) writeFileSync(SCORES, `${JSON.stringify({ ...recorded, ...results }, null, 2)}\n`);
  });

  it.each(fixtures)("%s", async (file) => {
    const name = file.replace(/\.html$/, "");
    const html = await inlineStyles(readFileSync(path.join(FIXTURES, file), "utf8"));

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
    await page.close();
    const chrome = rasterizePdf(pdf, name).map(decodePng);

    const { pages, warnings } = await renderer.renderPages(html, { format: "png", ppi: PPI });
    const ours = pages.map(decodePng);

    const scores: number[] = [];
    const outDir = path.join(REPORT, name);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    for (let i = 0; i < Math.max(chrome.length, ours.length); i++) {
      const c = chrome[i] ?? blank(ours[i]!);
      const o = ours[i] ?? blank(c);
      const r = score(c, o);
      scores.push(Math.round(r.score * 1000) / 1000);
      writeFileSync(path.join(outDir, `page-${i + 1}.png`), encodePng(sideBySide([c, o, r.diff])));
    }
    writeFileSync(path.join(outDir, "warnings.txt"), `${warnings.join("\n")}\n`);
    writeFileSync(path.join(REPORT, `${name}.inlined.html`), html);
    results[file] = scores;

    if (!updating && recorded[file]) {
      const before = recorded[file]!;
      const worse = scores.map((s, i) => [i + 1, s, before[i] ?? 0] as const).filter(([, s, b]) => s < b - TOLERANCE);
      expect(worse.map(([p, s, b]) => `page ${p}: ${(s * 100).toFixed(1)}% < recorded ${(b * 100).toFixed(1)}%`)).toEqual([]);
      expect(scores.length, "page count differs from the recorded run").toBe(before.length);
    }
  }, 120_000);
});
