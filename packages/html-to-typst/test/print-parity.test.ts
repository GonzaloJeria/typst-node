import { describe, expect, it } from "vitest";
import { composeToTypst, htmlToTypst } from "../src/index.js";

describe("page defaults like Chrome's page.pdf()", () => {
  it("has no page margin without @page margin", () => {
    expect(htmlToTypst("<p>x</p>").source).toContain("#set page(margin: 0pt");
  });

  it("keeps room for margin boxes", () => {
    const r = htmlToTypst(`<style>@page { @bottom-center { content: counter(page) } }</style><p>x</p>`);
    expect(r.source).not.toContain("margin: 0pt");
    expect(r.warnings).toEqual([]);
  });

  it("measures vh against the page area", () => {
    const r = htmlToTypst(`<style>@page { size: A4; margin: 20mm }</style><div style="height: 100vh; background: red">x</div>`);
    // 297mm - 2 × 20mm = 257mm ≈ 728.5pt
    expect(r.source).toMatch(/height: 728\.\d+pt/);
  });
});

describe("Tailwind-style documents", () => {
  it("gives a table its explicit width", () => {
    const r = htmlToTypst(`<table style="width: 192px; border: 1px solid"><tr><td>NETO</td><td>1</td></tr></table>`);
    expect(r.source).toContain("block(width: 144pt");
    // Auto columns share the free width in proportion to their content (CSS auto layout).
    expect(r.source).toContain("let cols = if free >= 0pt and need > 0pt { (m0 + free * (m0 / need), m1 + free * (m1 / need),) }");
  });

  it("draws row borders on the row's cells", () => {
    const r = htmlToTypst(`<table><tr style="border-bottom: 1px solid #ccc"><td>1</td><td>2</td></tr></table>`);
    expect(r.source).toContain('bottom: 0.75pt + rgb("#cccccc")');
  });

  it("keeps a table row at least its height", () => {
    const r = htmlToTypst(`<table><tr style="height: 40px"><td></td></tr></table>`);
    expect(r.source).toContain("block(height: calc.max(0pt, 30pt");
  });

  it("does not break nowrap text", () => {
    const r = htmlToTypst(`<p style="white-space: nowrap">a b c</p>`);
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain('"a b c"');
  });

  it("underlines with text-decoration-line after a text-decoration shorthand", () => {
    const r = htmlToTypst(`<style>a { text-decoration: inherit } .underline { text-decoration-line: underline }</style><p><a class="underline" href="https://x.y">x</a></p>`);
    expect(r.source).toContain("underline(");
  });

  it("places absolute children against the padding box", () => {
    const r = htmlToTypst(`<div style="position: relative; padding: 20px; height: 200px"><div style="position: absolute; bottom: 0; left: 0; right: 0">f</div></div>`);
    expect(r.source).toContain("place(dx: -15pt, dy: 15pt");
  });

  it("does not make absolute children flex items", () => {
    const r = htmlToTypst(`<div style="display: flex; position: relative"><div>a</div><div style="position: absolute; top: 0">b</div></div>`);
    expect(r.source).toContain("columns: (auto,)");
  });
});

describe("composed sections", () => {
  it("does not start with a blank page", () => {
    const r = composeToTypst({ layout: { page: { size: "A4", footer: "{{page}}" } }, sections: [{ html: "<p>a</p>" }] });
    // Content before the first `set page` would push the document to page 2.
    expect(r.source).toMatch(/#\{\n\s+(\{\n\s+)?pagebreak\(weak: true\)/);
  });
});

describe("Tailwind v4 output", () => {
  it("reads gradients with an interpolation color space", () => {
    const r = htmlToTypst(`<div style="background-image: linear-gradient(to right in oklab, #4f46e5 0%, #7c3aed 100%); height: 10px"></div>`);
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain("gradient.linear(");
  });

  it("treats calc(infinity * 1px) radii as fully rounded", () => {
    const r = htmlToTypst(`<div style="border-radius: calc(infinity * 1px); background: red">x</div>`);
    expect(r.warnings).toEqual([]);
    expect(r.source).toMatch(/radius: 75000pt/);
  });

  it("maps tabular-nums, text-indent and double borders", () => {
    const r = htmlToTypst(`<p style="font-variant-numeric: tabular-nums; text-indent: calc(0.25rem * 8)">1</p><div style="border: 6px double #b45309">x</div>`);
    expect(r.warnings).toEqual([]);
    expect(r.source).toContain('number-width: "tabular"');
    expect(r.source).toContain("first-line-indent: (amount: 24pt, all: true)");
    expect(r.source).toContain('stroke: 1.5pt + rgb("#b45309")');
  });

  it("reads unitless calc() line heights", () => {
    expect(htmlToTypst(`<body style="font-size: 14px; line-height: calc(1.25 / 0.875)"><p>x</p></body>`).source).toContain("css-line-height.with(1.43)");
  });

  it("keeps headings at their CSS size and weight (Tailwind resets them)", () => {
    const r = htmlToTypst(`<style>h2 { font-size: inherit; font-weight: inherit }</style><h2>Título</h2>`);
    expect(r.source).toContain('heading(level: 2, text(size: 12pt, weight: "regular", "Título"))');
  });

  it("counts borders in the box size, like CSS", () => {
    const r = htmlToTypst(`<div style="border: 2px solid #000; padding: 4px">x</div>`);
    expect(r.source).toContain("inset: 4.5pt");
  });

  it("underlines block text", () => {
    expect(htmlToTypst(`<p style="text-decoration: underline">x</p>`).source).toContain('par(underline("x"))');
  });
});
