import { describe, expect, it } from "vitest";
import { htmlToTypst } from "../src/index.js";

describe("table borders", () => {
  it("draws the table's own border around the table only", () => {
    const { source } = htmlToTypst(`<table style="border:1px solid red"><tr><td>a</td><td>b</td></tr></table>`);
    expect(source).toContain('block(stroke: 0.75pt + rgb("#ff0000"), table(');
    expect(source).toContain("stroke: none");
  });

  it("keeps a header cell's border on that cell", () => {
    const { source } = htmlToTypst(
      `<table><tr><th style="border-bottom:2px solid blue">H</th></tr><tr><td>x</td></tr></table>`,
    );
    expect(source).toContain("stroke: none");
    expect(source).toContain('table.cell(align: center, stroke: (bottom: 1.5pt + rgb("#0000ff"))');
    expect(source).not.toMatch(/table\(columns: \(auto,\), stroke: \(/);
  });

  it("uses one table-wide stroke when every cell has the same border", () => {
    const { source } = htmlToTypst(`<style>td { border: 1px solid #000 }</style><table><tr><td>a</td><td>b</td></tr></table>`);
    expect(source).toContain('table(columns: (auto, auto), stroke: 0.75pt + rgb("#000000")');
    expect(source).not.toContain("table.cell(stroke");
  });
});

describe("inline SVG", () => {
  const svg = `<svg width="40" height="20" viewBox="0 0 40 20"><path d="M0 10 L40 10" stroke="currentColor"/></svg>`;

  it("becomes an SVG image with its size", () => {
    const { source, warnings } = htmlToTypst(`<p style="color:#ff0000">Firma: ${svg}</p>`);
    const uri = /image\(width: 30pt, height: 15pt, "data:image\/svg\+xml;base64,([^"]+)"\)/.exec(source);
    expect(uri).not.toBeNull();
    const markup = Buffer.from(uri![1]!, "base64").toString("utf8");
    expect(markup).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(markup).toContain('viewBox="0 0 40 20"');
    // currentColor resolves against the surrounding CSS color.
    expect(markup).toContain('stroke="#ff0000"');
    expect(warnings).toEqual([]);
  });
});

describe("dropped elements", () => {
  it("warns instead of dropping silently", () => {
    expect(htmlToTypst(`<p>a</p><video src="x.mp4"></video><canvas></canvas>`).warnings).toEqual([
      "<video> cannot be rendered in a PDF and was dropped",
      "<canvas> cannot be rendered in a PDF and was dropped",
    ]);
  });

  it("keeps the content of a form", () => {
    const { source, warnings } = htmlToTypst(`<form><label>Nombre: Juan</label><input value="x"></form>`);
    expect(source).toContain("Nombre: Juan");
    expect(warnings).toEqual(["<input> cannot be rendered in a PDF and was dropped"]);
  });
});

describe("@page", () => {
  it("warns when margin boxes have no margin to live in", () => {
    const { warnings } = htmlToTypst(`<style>@page { margin: 0; @bottom-right { content: counter(page) } }</style><p>x</p>`);
    expect(warnings).toEqual(["@page bottom margin boxes are not drawn: margin-bottom is 0"]);
  });

  it("supports A6 and warns about unknown sizes", () => {
    expect(htmlToTypst(`<style>@page { size: A6 }</style><p>x</p>`).source).toContain('paper: "a6"');
    expect(htmlToTypst(`<style>@page { size: A7 }</style><p>x</p>`).warnings).toEqual(["Unsupported @page size ignored: a7"]);
  });
});

describe("position: fixed", () => {
  it("is offset from the page area and spans between left and right", () => {
    const { source } = htmlToTypst(`<div style="position:fixed; left:10mm; right:10mm; bottom:5mm; background:#eee">pie</div>`);
    expect(source).toContain("let m = { let v = page.margin;");
    expect(source).toContain("place(dx: m.left + 10mm, dy: -(m.bottom + 5mm), bottom + left, block(width: 100% - m.left - m.right - 10mm - 10mm");
    // The box's background fills the span.
    expect(source).toContain('block(width: 100%, fill: rgb("#eeeeee")');
  });

  it("keeps absolute positioning relative to its container", () => {
    const { source } = htmlToTypst(`<div style="position:relative"><div style="position:absolute; top:0; left:5pt; right:5pt">x</div></div>`);
    expect(source).toContain("place(dx: 5pt, dy: 0pt, top + left, block(width: 100% - 5pt - 5pt");
    expect(source).not.toContain("page.margin");
  });
});
