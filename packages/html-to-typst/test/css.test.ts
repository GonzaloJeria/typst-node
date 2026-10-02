import { describe, expect, it } from "vitest";
import { htmlToTypst } from "../src/index.js";
import { parseDeclarations, parseStylesheet } from "../src/css/parse.js";
import { matches, parseSelector, type SelectorElement } from "../src/css/selector.js";
import { parseColor, parseFontSize, parseGradient, parseLength } from "../src/css/values.js";

const ctx = { fontSize: 10, rootFontSize: 12 };

describe("values", () => {
  it.each([
    ["16px", { value: 12, unit: "pt" }],
    ["2em", { value: 20, unit: "pt" }],
    ["1.5rem", { value: 18, unit: "pt" }],
    ["10mm", { value: 10, unit: "mm" }],
    ["50%", { value: 50, unit: "%" }],
    ["0", { value: 0, unit: "pt" }],
  ])("parses length %s", (input, expected) => {
    expect(parseLength(input, ctx)).toEqual(expected);
  });

  it("rejects unitless non-zero and garbage lengths", () => {
    expect(parseLength("12", ctx)).toBeUndefined();
    expect(parseLength("calc(1px + )", ctx)).toBeUndefined();
  });

  it("keeps calc() mixing % and lengths as a relative length", () => {
    expect(parseLength("calc(10% + 2px)", ctx)).toEqual({ value: 10, unit: "%", offset: 1.5 });
    expect(parseLength("calc(100% - 2rem)", ctx)).toEqual({ value: 100, unit: "%", offset: -24 });
    expect(parseLength("min(100%, 40rem)", ctx)).toBeUndefined();
  });

  it.each([
    ["calc(10px + 2pt)", { value: 9.5, unit: "pt" }],
    ["calc(2 * 1em - 4px)", { value: 17, unit: "pt" }],
    ["calc((100% - 20%) / 2)", { value: 40, unit: "%" }],
  ])("evaluates %s", (input, expected) => {
    expect(parseLength(input, ctx)).toEqual(expected);
  });

  it.each([
    ["hsl(0, 100%, 50%)", "#ff0000"],
    ["hsl(240 100% 50% / 0.5)", "#0000ff80"],
  ])("parses color %s", (input, expected) => {
    expect(parseColor(input)).toBe(expected);
  });

  it("parses gradients", () => {
    expect(parseGradient("linear-gradient(135deg, #6c5ce7, #00cec9 80%)")).toEqual({
      kind: "linear",
      angle: 135,
      stops: [{ color: "#6c5ce7" }, { color: "#00cec9", offset: 80 }],
    });
    expect(parseGradient("linear-gradient(to right, red, blue)")).toMatchObject({ angle: 90 });
    expect(parseGradient("linear-gradient(red, rgba(0, 0, 255, .5))")).toMatchObject({ angle: 180, stops: [{}, { color: "#0000ff80" }] });
    expect(parseGradient("radial-gradient(circle at top, white, black)")).toMatchObject({ kind: "radial" });
    expect(parseGradient("linear-gradient(red)")).toBeUndefined();
    expect(parseGradient("url(x.png)")).toBeUndefined();
  });

  it.each([
    ["#abc", "#aabbcc"],
    ["#AABBCC", "#aabbcc"],
    ["red", "#ff0000"],
    ["rgb(255, 0, 0)", "#ff0000"],
    ["rgba(0 0 0 / 50%)", "#00000080"],
    ["rgba(0,0,0,1)", "#000000"],
    ["transparent", "#00000000"],
  ])("parses color %s", (input, expected) => {
    expect(parseColor(input)).toBe(expected);
  });

  it("resolves font sizes against the parent", () => {
    expect(parseFontSize("150%", 10, 12)).toBe(15);
    expect(parseFontSize("2rem", 10, 12)).toBe(24);
    expect(parseFontSize("small", 10, 12)).toBe(10);
  });
});

describe("parser", () => {
  it("parses rules, !important, @page and @media print only", () => {
    const sheet = parseStylesheet(`
      /* comment { } */
      @import url("x.css");
      h1, .a > b { color: red !important; margin: 0 }
      @page { size: A4; margin: 1cm }
      @media screen { p { color: blue } }
      @media print { p { color: green } }
      @font-face { font-family: X }
    `);
    expect(sheet.rules.map((r) => [r.selectors, r.media])).toEqual([
      [["h1", ".a > b"], undefined],
      [["p"], ["screen"]],
      [["p"], ["print"]],
    ]);
    expect(sheet.rules[0]!.declarations[0]).toEqual({ property: "color", value: "red", important: true });
    expect(sheet.page.map((d) => d.property)).toEqual(["size", "margin"]);
  });

  it("keeps semicolons inside strings and parens", () => {
    expect(parseDeclarations(`font-family: "a;b", serif; background: url(data:x;base64,AA)`)).toHaveLength(2);
  });
});

function el(tag: string, attrs: Record<string, string> = {}, parent?: SelectorElement, index = 1, count = 1): SelectorElement {
  return { tagName: tag, getAttribute: (n) => attrs[n], parent: () => parent, position: () => ({ index, count }) };
}

describe("selectors", () => {
  const table = el("table", { class: "grid striped" });
  const tr = el("tr", {}, table, 2, 3);
  const td = el("td", { id: "x", "data-kind": "money" }, tr, 3, 3);

  it.each([
    ["td", true],
    ["*", true],
    ["#x", true],
    ["table td", true],
    ["table > td", false],
    ["tr > td", true],
    [".grid.striped td", true],
    [".grid.other td", false],
    ["[data-kind]", true],
    ['[data-kind="money"]', true],
    ["[data-kind^=mo]", true],
    ["td:last-child", true],
    ["td:first-child", false],
    ["tr:nth-child(even) td", true],
    ["tr:nth-child(odd) td", false],
  ])("%s → %s", (sel, expected) => {
    expect(matches(parseSelector(sel)!, td)).toBe(expected);
  });

  it("computes specificity", () => {
    expect(parseSelector("#a .b c:first-child")!.specificity).toEqual([1, 2, 1]);
  });

  it("parses ::before/::after and :root", () => {
    expect(parseSelector("li.x::before")).toMatchObject({ pseudoElement: "before", specificity: [0, 1, 2] });
    expect(parseSelector("::after")).toMatchObject({ pseudoElement: "after" });
    expect(matches(parseSelector(":root")!, table)).toBe(true);
    expect(matches(parseSelector(":root")!, td)).toBe(false);
  });

  it.each(["a:unknown", "a:has-text(x)", "a <> b", "a::before b"])("rejects unsupported %s", (sel) => {
    expect(parseSelector(sel)).toBeUndefined();
  });

  it("never matches interactive states", () => {
    expect(matches(parseSelector("td:hover")!, td)).toBe(false);
  });
});

describe("style sharing between identical elements", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<tr><td class="c">${i}</td></tr>`).join("");
  // The color of the text run holding `text` (Typst wraps it in text(fill: …, …par("text")…)).
  const color = (source: string, text: string) => new RegExp(`text\\(fill: rgb\\("#([0-9a-f]{6})"\\), (?:block\\([^\\n]*?)?par\\("${text}"\\)`).exec(source)?.[1];

  it("still tells rows apart by position (odd/even, first/last)", () => {
    const { source } = htmlToTypst(`<style>tr:nth-child(even) td { color: #ff0000 } tr:last-child td { color: #0000ff }</style><table>${rows(4)}</table>`);
    expect(color(source, "1")).toBe("ff0000");
    expect(color(source, "0")).toBeUndefined();
    expect(color(source, "3")).toBe("0000ff");
  });

  it("still applies sibling combinators", () => {
    const { source } = htmlToTypst(`<style>.a + .a { color: #ff0000 }</style><p class="a">x1</p><p class="a">x2</p>`);
    expect(color(source, "x1")).toBeUndefined();
    expect(color(source, "x2")).toBe("ff0000");
  });

  it("still applies :empty and attribute selectors", () => {
    const { source } = htmlToTypst(`<style>p:empty { height: 9pt } p[data-k="b"] { color: #ff0000 }</style><p data-k="a">ka</p><p data-k="b">kb</p><p></p>`);
    expect(color(source, "kb")).toBe("ff0000");
    expect(color(source, "ka")).toBeUndefined();
    expect(source).toContain("height: 9pt");
  });
});
