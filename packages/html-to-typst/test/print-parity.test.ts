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
    expect(r.source).toContain("columns: (1fr, 1fr)");
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
