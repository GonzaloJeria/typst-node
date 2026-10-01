import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { htmlToTypst, type Block } from "../src/index.js";

const binary = process.env.TYPST_PATH ?? "typst";
const hasTypst = spawnSync(binary, ["--version"]).status === 0;
const compileOk = (source: string) => {
  const r = spawnSync(binary, ["compile", "--diagnostic-format", "short", "-", "-"], { input: source });
  if (r.status !== 0) throw new Error(`${r.stderr.toString()}\n--- source ---\n${source}`);
};

const doc = (html: string, css = "") => htmlToTypst(`<style>${css}</style>${html}`);
const blocks = (html: string, css = "") => doc(html, css).document.children;

describe("position", () => {
  it("anchors absolute elements to the corner given by their offsets", () => {
    const [b] = blocks('<div style="position: absolute; right: 10px; bottom: 4px">x</div>');
    expect(b).toMatchObject({ kind: "place", x: "right", y: "bottom", dx: { value: 7.5 }, dy: { value: 3 } });
    expect(doc('<div style="position: absolute; right: 10px; top: 0">x</div>').source).toContain("place(dx: -7.5pt, dy: 0pt, top + right,");
  });

  it("gives positioned ancestors a block so they contain absolute children", () => {
    const [b] = blocks('<div style="position: relative"><p>a</p><span style="position: absolute; left: 0; top: 0">b</span></div>');
    expect(b).toMatchObject({ kind: "box", style: {}, children: [{ kind: "paragraph" }, { kind: "place" }] });
  });

  it("shifts relative elements without affecting layout", () => {
    expect(blocks('<div style="position: relative; top: -4px; left: 8px">x</div>')[0]).toMatchObject({
      kind: "transform",
      ops: [{ kind: "translate", dx: { value: 6 }, dy: { value: -3 } }],
    });
    const [p] = blocks('<p>a <span style="position: relative; top: -2px">b</span></p>');
    expect(p).toMatchObject({ children: [{ kind: "text" }, { kind: "move", dy: { value: -1.5 } }] });
  });

  it("warns about percentage offsets", () => {
    expect(doc('<div style="position: absolute; top: 50%">x</div>').warnings).toEqual(["Unsupported CSS value ignored: top: 50% (<div>)"]);
  });

  it("repeats fixed elements on every page", () => {
    const r = doc('<p>body</p><div style="position: fixed; top: 10mm; left: 10mm">WATERMARK</div>');
    expect(r.document.children).toHaveLength(1);
    expect(r.document.page?.foreground).toMatchObject([{ kind: "place", dx: { value: 10, unit: "mm" }, pageArea: true }]);
    // Offsets count from the page area, inside the margins, as browsers print.
    expect(r.source).toContain("foreground: context {");
    expect(r.source).toContain("place(dx: m.left + 10mm, dy: m.top + 10mm, top + left");
  });
});

describe("transform", () => {
  it("nests operations with the first function outermost", () => {
    const [b] = blocks('<div style="transform: rotate(-8deg) scale(1.5) translate(4px, 2px)">x</div>');
    expect(b).toMatchObject({
      kind: "transform",
      ops: [{ kind: "rotate", deg: -8 }, { kind: "scale", x: 1.5, y: 1.5 }, { kind: "translate", dx: { value: 3 }, dy: { value: 1.5 } }],
    });
    expect(doc('<div style="transform: rotate(0.25turn)">x</div>').source).toContain("rotate(reflow: false, 90deg,");
  });

  it("warns about unsupported transforms", () => {
    expect(doc('<div style="transform: skew(10deg)">x</div>').warnings).toEqual(["Unsupported CSS value ignored: transform: skew(10deg) (<div>)"]);
    expect(doc('<p><span style="display: inline-block; transform: rotate(5deg)">x</span></p>').warnings).toEqual([
      "Unsupported CSS ignored on inline element: transform: rotate(5deg) (<span>)",
    ]);
  });
});

describe("box-shadow", () => {
  it("parses outer shadows and stretches the box like other visible blocks", () => {
    const [b] = blocks('<div style="box-shadow: 0 4px 12px rgba(0,0,0,.1), 1px 1px #000">x</div>');
    expect(b).toMatchObject({
      kind: "box",
      style: {
        width: { value: 100, unit: "%" },
        shadows: [
          { dx: { value: 0 }, dy: { value: 3 }, blur: { value: 9 }, color: "#0000001a" },
          { dx: { value: 0.75 }, dy: { value: 0.75 }, blur: { value: 0 }, color: "#000000" },
        ],
      },
    });
  });

  it("warns about inset shadows", () => {
    expect(doc('<div style="box-shadow: inset 0 0 4px red">x</div>').warnings).toEqual([
      "Unsupported CSS value ignored: box-shadow: inset 0 0 4px red (<div>)",
    ]);
  });
});

describe("@page", () => {
  const css = `
    @page {
      size: A5; background: linear-gradient(white, #eef);
      @top-left { content: element(logo) }
      @top-right { content: "Informe \\2014  2026"; color: #636e72; font-size: 8pt }
      @bottom-center { content: "Página " counter(page) " de " counter(pages); font-weight: bold }
      @left-middle { content: "x" }
    }
    @page :first { margin: 0 }
    .logo { position: running(logo) }`;

  it("builds header and footer bands with counters and running elements", () => {
    const r = doc('<div class="logo"><b>ACME</b></div><p>body</p>', css);
    const page = r.document.page!;
    expect(page.fill).toMatchObject({ kind: "linear" });
    expect(page.header?.left?.blocks).toMatchObject([{ kind: "paragraph", children: [{ kind: "strong" }] }]);
    expect(page.header?.right).toEqual({
      inlines: [{ kind: "text", value: "Informe — 2026" }],
      style: { fill: "#636e72", size: { value: 8, unit: "pt" } },
    });
    expect(page.footer?.center?.inlines).toEqual([
      { kind: "text", value: "Página " },
      { kind: "page-counter", which: "page" },
      { kind: "text", value: " de " },
      { kind: "page-counter", which: "pages" },
    ]);
    // The running element leaves the flow.
    expect(r.document.children).toHaveLength(1);
    expect(r.warnings).toEqual(["Unsupported @page margin box ignored: @left-middle", "Unsupported @page :first property ignored: margin (only backgrounds and margin boxes)"]);
    expect(r.source).toContain("context counter(page).display()");
    expect(r.source).toContain("context str(counter(page).final().first())");
  });

  it("paints the page with the body background", () => {
    expect(doc("<p>x</p>", "body { background: #fafafa }").document.page?.fill).toBe("#fafafa");
  });

  it("keeps per-side table rules instead of a full grid", () => {
    const [t] = blocks("<table><tr><td>a</td><td>b</td></tr></table>", "td { border-bottom: 1px solid #ccc }");
    expect((t as Extract<Block, { kind: "table" }>).stroke).toEqual({ bottom: { width: { value: 0.75, unit: "pt" }, color: "#cccccc" } });
  });

  it.skipIf(!hasTypst)("compiles everything with the official compiler", () => {
    compileOk(
      doc(
        `<div class="logo">ACME</div>
         <div style="position: relative; box-shadow: 0 2px 6px rgba(0,0,0,.2); border-radius: 4px; padding: 8px">
           card <span style="position: relative; top: -2px">up</span>
           <div style="position: absolute; right: 4px; bottom: 4px; transform: rotate(-10deg) scale(1.2)">stamp</div>
         </div>
         <div style="position: fixed; top: 50%; left: 20mm; transform: rotate(-30deg)">DRAFT</div>
         <table><tr><td>a</td></tr></table>`,
        css + " td { border-bottom: 1px dashed red }",
      ).source,
    );
  });
});
