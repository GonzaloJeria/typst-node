import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { documentText, htmlToTypst } from "html-to-typst";
import { parse } from "parse5";
import { afterAll, describe, expect, it } from "vitest";
import { PdfRenderer } from "../src/index.js";
import { checkGoldenVersion, matchGoldens } from "./visual/golden.js";

const binary = process.env.TYPST_PATH ?? "typst";
const version = spawnSync(binary, ["--version"]).status === 0
  ? /typst (\S+)/.exec(execFileSync(binary, ["--version"]).toString())?.[1]
  : undefined;

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".html")).sort();
const read = (f: string) => readFileSync(path.join(FIXTURES, f), "utf8");

// Low resolution keeps goldens small while still catching layout regressions.
const PPI = 50;

describe.skipIf(!version)("visual regression", () => {
  const renderer = new PdfRenderer({
    cli: { creationTimestamp: 0 },
    defaults: { assets: { baseDir: FIXTURES } },
  });
  afterAll(() => renderer.dispose());

  it("goldens match the installed Typst version", () => {
    const mismatch = checkGoldenVersion(version!);
    expect(mismatch, mismatch).toBeUndefined();
  });

  it.each(fixtures)("%s", async (file) => {
    const { pages, diagnostics } = await renderer.renderPages(read(file), { format: "png", ppi: PPI });
    expect(diagnostics).toEqual([]);
    const failures = matchGoldens(file.replace(/\.html$/, ""), pages);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

/** Text of <body> as a browser would read it, minus whitespace. */
function htmlText(html: string): string {
  const skip = new Set(["script", "style", "head", "template"]);
  const walk = (n: any): string =>
    n.nodeName === "#text" ? n.value : skip.has(n.nodeName) ? "" : (n.childNodes ?? []).map(walk).join("");
  return walk(parse(html)).replace(/\s+/g, "");
}

describe("content consistency (HTML text survives into the IR)", () => {
  it.each(fixtures)("%s", (file) => {
    const html = read(file);
    // Generated content (::before, quotes) may add text and text-transform may
    // change case, so the HTML text must appear, in order, within the IR text.
    const ir = documentText(htmlToTypst(html).document).replace(/\s+/g, "").toLowerCase();
    const source = htmlText(html).toLowerCase();
    let at = 0;
    for (const ch of source) {
      at = ir.indexOf(ch, at);
      expect(at, `"${ch}" from the HTML is missing in the IR text`).toBeGreaterThanOrEqual(0);
      at++;
    }
  });
});
