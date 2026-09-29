import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { htmlToTypst, type Block, type Inline } from "../src/index.js";

const binary = process.env.TYPST_PATH ?? "typst";
const hasTypst = spawnSync(binary, ["--version"]).status === 0;

function compileOk(source: string): void {
  const r = spawnSync(binary, ["compile", "--diagnostic-format", "short", "-", "-"], { input: source });
  if (r.status !== 0) throw new Error(`${r.stderr.toString()}\n--- source ---\n${source}`);
}

const body = (html: string, css = "") => htmlToTypst(`<style>${css}</style>${html}`).document.children;
const para = (html: string, css = ""): Inline[] => {
  const [p] = body(`<p>${html}</p>`, css);
  expect(p?.kind).toBe("paragraph");
  return (p as Extract<Block, { kind: "paragraph" }>).children;
};

describe("whitespace", () => {
  it("collapses whitespace across element boundaries", () => {
    expect(para("  a   <b> b </b>  c  ")).toEqual([
      { kind: "text", value: "a " },
      { kind: "strong", children: [{ kind: "text", value: "b " }] },
      { kind: "text", value: "c" },
    ]);
  });

  it("drops spaces around line breaks", () => {
    expect(para("a <br> b")).toEqual([
      { kind: "text", value: "a" },
      { kind: "linebreak" },
      { kind: "text", value: "b" },
    ]);
  });

  it("preserves pre-wrap text", () => {
    expect(para('<span style="white-space: pre-wrap">a  b\nc</span>')).toEqual([
      { kind: "text", value: "a  b" },
      { kind: "linebreak" },
      { kind: "text", value: "c" },
    ]);
  });

  it("wraps loose text between blocks in anonymous paragraphs", () => {
    const blocks = body("<div>uno<p>dos</p>tres</div>");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("ignores whitespace-only text between blocks", () => {
    expect(body("<div>\n  <p>a</p>\n  <p>b</p>\n</div>")).toHaveLength(2);
  });
});

describe("cascade", () => {
  it("applies specificity, order, inline style and !important", () => {
    const [p] = body(
      '<p id="x" class="c" style="color: blue">t</p><p class="c">u</p><p class="c" style="color: green">v</p>',
      "#x { color: red } .c { color: gray !important } p { color: black }",
    );
    expect(p).toMatchObject({ kind: "styled-block", style: { fill: "#808080" } });
  });

  it("inherits text properties and only emits differences", () => {
    const blocks = body('<div style="color: red"><p>a <span style="color: red">b</span></p></div>');
    expect(blocks).toEqual([
      { kind: "styled-block", style: { fill: "#ff0000" }, children: [{ kind: "paragraph", children: [{ kind: "text", value: "a b" }] }] },
    ]);
  });

  it("resolves em against the computed font size", () => {
    const [b] = body('<div style="font-size: 20px; padding: 1em">x</div>');
    expect(b).toMatchObject({ kind: "styled-block", style: { size: { value: 15, unit: "pt" } }, children: [{ kind: "box", style: { inset: { top: { value: 15, unit: "pt" } } } }] });
  });

  it("expands shorthands so later longhands win", () => {
    const [b] = body('<div style="padding: 4px; padding-left: 8px; border: 1px solid red; border-top: none">x</div>');
    expect(b).toMatchObject({
      kind: "box",
      style: {
        inset: { top: { value: 3 }, left: { value: 6 } },
        stroke: { right: { width: { value: 0.75 }, color: "#ff0000" } },
      },
    });
    expect((b as Extract<Block, { kind: "box" }>).style.stroke?.top).toBeUndefined();
  });

  it("skips display: none and hidden elements", () => {
    expect(body('<p>a</p><p style="display:none">b</p><script>c</script>')).toHaveLength(1);
  });
});

describe("blocks", () => {
  it("maps headings, lists and code", () => {
    const blocks = body('<h2>T</h2><ol start="3"><li>a</li><li>b</li></ol><pre><code class="language-ts">let a = 1;\n</code></pre><hr>');
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "raw-block", "rule"]);
    expect(blocks[1]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[2]).toEqual({ kind: "raw-block", value: "let a = 1;", lang: "ts" });
  });

  it("maps page breaks and break-inside", () => {
    const blocks = body('<p>a</p><div style="page-break-before: always; break-inside: avoid">b</div><p style="break-after: page">c</p>');
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "pagebreak", "box", "paragraph", "pagebreak"]);
    expect(blocks[2]).toMatchObject({ style: { breakable: false } });
  });

  it("centers boxes with auto margins", () => {
    expect(body('<div style="width: 50%; margin: 0 auto">x</div>')[0]).toMatchObject({ kind: "box", style: { width: { value: 50, unit: "%" }, align: "center" } });
  });

  it("maps flex rows and explicit grids", () => {
    const [flex] = body('<div style="display:flex; gap: 8px"><div style="flex: 1">a</div><div style="width: 100px">b</div></div>');
    expect(flex).toMatchObject({ kind: "grid", columns: [{ value: 1, unit: "fr" }, { value: 75, unit: "pt" }], gutter: { value: 6 } });
    const [grid] = body('<div style="display:grid; grid-template-columns: repeat(2, 1fr) 20mm"><p>1</p><p>2</p><p>3</p></div>');
    expect(grid).toMatchObject({ kind: "grid", columns: [{ value: 1, unit: "fr" }, { value: 1, unit: "fr" }, { value: 20, unit: "mm" }] });
  });

  it("reports unsupported CSS once per declaration site", () => {
    const { warnings } = htmlToTypst('<div style="float: left"><p>a</p><p>b</p></div><p style="clip-path: circle()">c</p>');
    expect(warnings).toEqual([
      "Unsupported CSS ignored: float: left (<div>)",
      "Unsupported CSS ignored: clip-path: circle() (<p>)",
    ]);
  });
});

describe("tables", () => {
  const table = (html: string, css = "") => body(`<table>${html}</table>`, css)[0] as Extract<Block, { kind: "table" }>;
  const shape = (t: Extract<Block, { kind: "table" }>) => t.body.map((r) => r.cells.map((c) => [c.colspan ?? 1, c.rowspan ?? 1]));

  it("normalizes rowspan/colspan and pads short rows", () => {
    const t = table(`
      <tr><td rowspan="2">a</td><td colspan="2">b</td></tr>
      <tr><td>c</td></tr>
      <tr><td>d</td></tr>`);
    expect(t.columns).toHaveLength(3);
    expect(shape(t)).toEqual([
      [[1, 2], [2, 1]],
      [[1, 1], [1, 1]],
      [[1, 1], [1, 1], [1, 1]],
    ]);
  });

  it("clamps rowspans to the section and handles rowspan=0", () => {
    const t = table(`<tr><td rowspan="0">a</td><td>b</td></tr><tr><td rowspan="9">c</td></tr>`);
    expect(shape(t)).toEqual([[[1, 2], [1, 1]], [[1, 1]]]);
  });

  it("promotes a leading row of th to a repeated header", () => {
    const t = table("<tr><th>H</th></tr><tr><td>x</td></tr>");
    expect(t.header).toHaveLength(1);
    expect(t.header![0]!.cells[0]).toMatchObject({ align: "center", children: [{ kind: "styled-block", style: { weight: "bold" } }] });
  });

  it("keeps multi-row th headers together so header rowspans survive", () => {
    const t = table(`<tr><th rowspan="2">R</th><th colspan="2">Y</th></tr><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td><td>3</td></tr>`);
    expect(t.header).toHaveLength(2);
    expect(t.header![0]!.cells[0]).toMatchObject({ rowspan: 2 });
    expect(t.body).toHaveLength(1);
    expect(t.columns).toHaveLength(3);
  });

  it("derives column widths, stroke, inset and fills", () => {
    const t = body(
      `<table style="width: 100%"><colgroup><col style="width: 30%"><col></colgroup>
       <tr><td>a</td><td class="hl" style="text-align: right">b</td></tr></table>`,
      "td { border: 1px solid #000; padding: 8px } .hl { background: #eee }",
    )[0] as Extract<Block, { kind: "table" }>;
    expect(t.columns).toEqual([{ value: 30, unit: "%" }, { value: 1, unit: "fr" }]);
    expect(t.stroke).toEqual({ width: { value: 0.75, unit: "pt" }, color: "#000000" });
    expect(t.inset).toEqual({ value: 6, unit: "pt" });
    expect(t.body[0]!.cells[1]).toMatchObject({ align: "right", fill: "#eeeeee" });
  });

  it("uses no stroke by default, like browsers", () => {
    expect(table("<tr><td>a</td></tr>").stroke).toBeNull();
  });
});

describe("document", () => {
  it("maps @page, body text defaults, lang and assets", () => {
    const r = htmlToTypst(
      '<html lang="es-CL"><style>@page { size: letter landscape; margin: 1in 2cm } body { font: 10pt serif; font-family: "Inter", sans-serif; font-size: 11pt }</style><img src="a.png"><img src="a.png"><img src="https://x/b.jpg"></html>',
    );
    expect(r.document.page).toEqual({
      paper: "us-letter",
      flipped: true,
      margin: { top: { value: 1, unit: "in" }, right: { value: 2, unit: "cm" }, bottom: { value: 1, unit: "in" }, left: { value: 2, unit: "cm" } },
    });
    expect(r.document.text).toEqual({ size: { value: 11, unit: "pt" }, font: ["Inter"] });
    expect(r.document.lang).toBe("es");
    expect(r.assets).toEqual(["a.png", "https://x/b.jpg"]);
  });
});

const INVOICE = `<!doctype html>
<html lang="es">
<head><style>
  @page { size: A4; margin: 18mm 15mm }
  body { font-family: serif; font-size: 10pt; color: #222 }
  h1 { color: #0a3d62; margin-bottom: 4px }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px }
  .box { border: 1px solid #ccc; border-radius: 4px; padding: 8px; break-inside: avoid }
  table { width: 100%; border-collapse: collapse }
  th, td { border: 0.5pt solid #999; padding: 4px }
  th { background: #f0f3f7 }
  tbody tr:nth-child(even) td { background: #fafafa }
  .num { text-align: right }
  .total { text-align: right; font-size: 12pt; font-weight: bold }
  .legal { page-break-before: always; font-size: 8pt; text-align: justify }
</style></head>
<body>
  <h1>Factura N° 2026-001 <small>(borrador)</small></h1>
  <div class="meta">
    <div class="box"><strong>Emisor</strong><br>ACME S.A. <em>#1 en "calidad"</em><br>RUT 76.000.000-0</div>
    <div class="box"><strong>Cliente</strong><br>Ada &amp; Co. &lt;ada@example.com&gt;<br>Santiago</div>
  </div>
  <table>
    <thead><tr><th style="width: 50%">Descripción</th><th>Cant.</th><th>Precio</th><th>Total</th></tr></thead>
    <tbody>
      <tr><td>Servicio *premium* con $variables$ y #hashtags</td><td class="num">1</td><td class="num">$100</td><td class="num">$100</td></tr>
      <tr><td rowspan="2">Licencias [anual]</td><td class="num">2</td><td class="num">$50</td><td class="num">$100</td></tr>
      <tr><td colspan="2" class="num">Descuento</td><td class="num">-$10</td></tr>
    </tbody>
    <tfoot><tr><td colspan="3" class="num">Total</td><td class="num"><b>$190</b></td></tr></tfoot>
  </table>
  <p class="total">Total a pagar: $190</p>
  <ul><li>Pago a 30 días</li><li>Transferencia a <a href="https://example.com/pay?a=1&b=2">example.com</a></li></ul>
  <section class="legal"><h2>Términos</h2><p>Lorem ipsum \\ dolor // sit @amet &lt;label&gt;.</p></section>
</body></html>`;

describe.skipIf(!hasTypst)("official compiler", () => {
  it("compiles a realistic invoice without warnings from the transpiler", () => {
    const r = htmlToTypst(INVOICE);
    expect(r.warnings).toEqual([]);
    compileOk(r.source);
  });

  it("matches the invoice snapshot", () => {
    expect(htmlToTypst(INVOICE).source).toMatchSnapshot();
  });
});
