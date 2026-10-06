import { describe, expect, it } from "vitest";
import { composeToTypst, htmlToTypst } from "../src/index.js";

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
    expect(source).toMatch(/table\.cell\(align: center, inset: [^)]*\), stroke: \(bottom: 1\.5pt \+ rgb\("#0000ff"\)\)/);
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
    const uri = /image\(width: 30pt, height: 15pt, fit: "contain", "data:image\/svg\+xml;base64,([^"]+)"\)/.exec(source);
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

describe("headers, frames and cells (reported migrating a marketplace settlement)", () => {
  const compose = (header: string, css = "") =>
    composeToTypst({ layout: { page: { margin: "30mm 15mm", header } }, sections: [{ html: "<p>body</p>" }] }, { css }).source;

  it("lets header content align left and right, centered by default", () => {
    const source = compose('<p style="text-align:left">L</p><p class="r">R</p><p>C</p>', ".r { text-align: right }");
    // Blocks span the band, so each paragraph aligns across the page width.
    expect(source).toContain("set block(width: 100%)");
    expect(source).toContain('above: 12pt, below: 12pt, par("L"))');
    expect(source).toContain('align(right, par("R"))');
    expect(source).toContain('align(center, par("C"))');
  });

  it("places a fixed box inside a header on the whole sheet, sized by its insets", () => {
    const source = compose('<div style="position:fixed; top:4mm; right:4mm; bottom:4mm; left:4mm; border:1px solid #333"></div>');
    expect(source).toMatch(/foreground: place\(dx: 4mm, dy: 4mm, top \+ left, block\(width: 100% - 4mm - 4mm, height: 100% - 4mm - 4mm/);
    expect(source).toMatch(/block\(width: 100%, height: 100%, inset: 0\.75pt, stroke: 0\.75pt/);
  });

  it("grows a margin when the header does not fit in it", () => {
    const source = compose("<p>tall</p>");
    expect(source).toContain("let (fit-top, fit-bottom) = (calc.max(fit-m.top, measure(block(width: fit-w,");
    expect(source).toContain("set page(margin: (left: fit-m.left, right: fit-m.right, top: fit-top, bottom: fit-bottom)) if fit-top > fit-m.top or fit-bottom > fit-m.bottom");
  });

  it("draws an @page border and moves the body inside it and the padding", () => {
    const { source, warnings } = htmlToTypst("<style>@page { margin: 4mm; border: 1px solid #333; padding: 6mm }</style><p>x</p>");
    expect(warnings).toEqual([]);
    expect(source).toContain("#set page(margin: 4mm + 0.75pt + 6mm,");
    expect(source).toContain('background: place(dx: 4mm, dy: 4mm, rect(width: 100% - 4mm - 4mm, height: 100% - 4mm - 4mm, stroke: 0.75pt + rgb("#333333")))');
  });

  it("takes the page frame from page options too", () => {
    const { source } = composeToTypst({ layout: { page: { margin: "5mm", border: "2px solid black", padding: "3mm" } }, sections: [{ html: "<p>x</p>" }] });
    expect(source).toContain("rect(width: 100% - 5mm - 5mm");
  });

  it("aligns table cells vertically", () => {
    const { source, warnings } = htmlToTypst(
      '<table><tr><td style="vertical-align:top">a</td><td style="vertical-align:middle; text-align:right">b</td><td valign="bottom">c</td></tr></table>',
    );
    expect(warnings).toEqual([]);
    expect(source).toContain('table.cell(align: top, par("a"))');
    expect(source).toContain('table.cell(align: right + horizon, par("b"))');
    expect(source).toContain('table.cell(align: bottom, par("c"))');
  });

  it("skips ::before/::after that no rule gives content", () => {
    const { source, warnings } = htmlToTypst('<style>*, ::before, ::after { box-sizing: border-box; border: 0 solid } p::after { content: "!" }</style><p>a</p><div>b</div>');
    expect(warnings).toEqual([]);
    expect(source).toContain('par("a!")');
  });

  it("keeps a break-before: avoid block with the table's last rows", () => {
    const rows = Array.from({ length: 6 }, (_, i) => `<tr><td>r${i}</td></tr>`).join("");
    const { source, warnings } = htmlToTypst(
      `<table style="border:1px solid black; widows: 3"><thead><tr><th>H</th></tr></thead><tbody>${rows}</tbody><tbody><tr><td>total</td></tr></tbody></table><div style="break-before: avoid; break-inside: avoid">firma</div>`,
    );
    expect(warnings).toEqual([]);
    // Both layouts are emitted; the previous pass picks one.
    expect(source).toContain("let split = if g != none { a != g } else if c != none { t != c } else { false }");
    // Split: 6 - 3 widows - 1 last <tbody> row = 3 rows stay, the rest stick to the block.
    expect(source).toContain("block(breakable: false, sticky: true, [#metadata(none) <keep-0-g>]");
    expect(source).toContain('[#metadata(none) <keep-0-a>] + par("r2")');
    expect(source).toContain('[#metadata(none) <keep-0-t>] + par("r3")');
    // Unbreakable block: its page is where it ends.
    expect(source).toMatch(/par\("firma"\)\)\s*\[#metadata\(none\) <keep-0-c>\]/);
  });

  it("leaves a break-before: avoid block alone when the table is too short to split", () => {
    const { source } = htmlToTypst(`<table><tr><td>a</td></tr><tr><td>b</td></tr></table><p style="break-before: avoid">x</p>`);
    expect(source).not.toContain("keep-0");
    expect(source).toContain('par("x")');
  });
});

