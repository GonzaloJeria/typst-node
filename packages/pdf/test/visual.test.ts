import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { documentText, htmlToTypst } from "@typdf/html-to-typst";
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
const composed = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
const read = (f: string) => readFileSync(path.join(FIXTURES, f), "utf8");

// Low resolution keeps goldens small while still catching layout regressions.
const PPI = 50;

describe.skipIf(!version)("visual regression", () => {
  // VISUAL_BACKEND=sidecar checks that the sidecar matches the same goldens.
  const renderer = new PdfRenderer({
    ...(process.env.VISUAL_BACKEND === "sidecar"
      ? { sidecar: { creationTimestamp: 0, processes: 2 } }
      : { cli: { creationTimestamp: 0 } }),
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

  it.each(composed)("%s (sections)", async (file) => {
    const { pages, diagnostics } = await renderer.renderPages(JSON.parse(read(file)), { format: "png", ppi: PPI });
    expect(diagnostics).toEqual([]);
    const failures = matchGoldens(file.replace(/\.json$/, ""), pages);
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
    // Out-of-flow content (fixed, running headers) legitimately moves and
    // generated content adds text, so compare character counts, not order:
    // every character of the HTML text must still be present in the IR.
    const count = (text: string) => {
      const bag = new Map<string, number>();
      for (const ch of text.toLowerCase().replace(/\s+/g, "")) bag.set(ch, (bag.get(ch) ?? 0) + 1);
      return bag;
    };
    const ir = count(documentText(htmlToTypst(html).document));
    const missing = [...count(htmlText(html))].filter(([ch, n]) => (ir.get(ch) ?? 0) < n);
    expect(missing, "characters lost between HTML and IR").toEqual([]);
  });
});
