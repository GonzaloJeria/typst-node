import { describe, expect, it } from "vitest";
import { parseDeclarations, parseStylesheet } from "../src/css/parse.js";
import { matches, parseSelector, type SelectorElement } from "../src/css/selector.js";
import { parseColor, parseFontSize, parseLength } from "../src/css/values.js";

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
    expect(parseLength("calc(1px + 2px)", ctx)).toBeUndefined();
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
    expect(sheet.rules.map((r) => r.selectors)).toEqual([["h1", ".a > b"], ["p"]]);
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

  it.each(["a + b", "a ~ b", "a:hover", "a::before", "a:not(.b)"])("rejects unsupported %s", (sel) => {
    expect(parseSelector(sel)).toBeUndefined();
  });
});
