import { describe, expect, it } from "vitest";
import { htmlToTypst } from "../src/index.js";
import { mediaMatches, supportsCondition } from "../src/css/conditions.js";
import { matches, parseSelector, type SelectorElement } from "../src/css/selector.js";
import { parseColor, parseLength } from "../src/css/values.js";

const source = (html: string) => htmlToTypst(html).source;

describe("cascade layers", () => {
  it("lets later layers and unlayered rules win regardless of specificity", () => {
    const html = (css: string) => source(`<style>${css}</style><p id="x" class="c">t</p>`);
    expect(html(`@layer base, utilities; @layer utilities { p { color: red } } @layer base { #x { color: blue } }`)).toContain('rgb("#ff0000")');
    expect(html(`@layer a { #x.c { color: blue } } p { color: red }`)).toContain('rgb("#ff0000")');
  });

  it("reverses the layer order for !important", () => {
    expect(source(`<style>@layer a, b; @layer a { p { color: red !important } } @layer b { p { color: blue !important } }</style><p>t</p>`))
      .toContain('rgb("#ff0000")');
  });
});

describe("media queries", () => {
  const a4 = { width: 793.7, height: 1122.5 };
  it.each([
    ["print", true],
    ["screen", false],
    ["only screen and (min-width: 576px)", false],
    ["(min-width: 768px)", true],
    ["(min-width: 1024px)", false],
    ["(width >= 48rem)", true],
    ["(width >= 64rem)", false],
    ["(400px <= width <= 800px)", true],
    ["not print", false],
    ["(orientation: portrait)", true],
    ["(prefers-color-scheme: dark)", false],
    ["(hover: hover)", false],
    ["screen, print and (max-width: 900px)", true],
  ])("%s → %s", (q, expected) => {
    expect(mediaMatches(q, a4)).toBe(expected);
  });

  it("evaluates breakpoints against the @page size", () => {
    const css = `.x { color: red } @media (min-width: 640px) { .x { color: blue } }`;
    expect(source(`<style>${css}</style><p class="x">t</p>`)).toContain('rgb("#0000ff")');
    expect(source(`<style>@page { size: A5 } ${css}</style><p class="x">t</p>`)).toContain('rgb("#ff0000")');
  });
});

describe("@supports", () => {
  it.each([
    ["(display: flex)", true],
    ["(display: subgrid-ish)", false],
    ["not (display: subgrid-ish)", true],
    ["(display: flex) and (color: oklch(50% 0.1 200))", true],
    ["(-webkit-appearance: none) or (color: red)", true],
    ["selector(:is(a))", true],
  ])("%s → %s", (q, expected) => {
    expect(supportsCondition(q)).toBe(expected);
  });
});

describe("CSS nesting", () => {
  it("resolves & and relative nested rules", () => {
    const css = `.card { color: red; .title { color: blue } &.wide { color: green } @media print { & { font-weight: bold } } }`;
    const out = source(`<style>${css}</style><div class="card wide"><p class="title">a</p></div>`);
    expect(out).toContain('rgb("#0000ff")');
    expect(out).toContain('weight: "bold"');
  });
});

describe("@property", () => {
  it("provides initial values to var()", () => {
    const css = `@property --c { syntax: "<color>"; inherits: false; initial-value: #00ff00 } p { color: var(--c) }`;
    expect(source(`<style>${css}</style><p>t</p>`)).toContain('rgb("#00ff00")');
  });

  it("treats an empty custom property as a valid value", () => {
    expect(source(`<style>:root { --e: ; } p { color: red var(--e) }</style><p>t</p>`)).toContain('rgb("#ff0000")');
  });
});

function tree() {
  const kids: SelectorElement[] = [];
  const root: SelectorElement = { tagName: "ul", getAttribute: (n) => (n === "class" ? "list" : undefined), parent: () => undefined, position: () => ({ index: 1, count: 1 }), siblings: () => [root], children: () => kids };
  for (let i = 0; i < 5; i++) {
    const cls = i === 2 ? "on" : undefined;
    const e: SelectorElement = {
      tagName: i === 4 ? "p" : "li",
      getAttribute: (n) => (n === "class" ? cls : n === "data-x" ? "Foo" : undefined),
      parent: () => root,
      position: () => ({ index: i + 1, count: 5 }),
      siblings: () => kids,
      children: () => [],
      isEmpty: () => i === 3,
    };
    kids.push(e);
  }
  return { root, kids };
}

describe("selectors level 4", () => {
  const { root, kids } = tree();
  it.each([
    [".on + li", 3, true],
    [".on ~ li", 3, true],
    [".on ~ li", 1, false],
    ["li:not(.on)", 2, false],
    ["li:not(.on)", 1, true],
    [":is(li, p).on", 2, true],
    [":where(.list) > li", 0, true],
    ["li:nth-child(2n+1)", 2, true],
    ["li:nth-child(-n+2)", 2, false],
    ["li:nth-last-child(2)", 3, true],
    ["li:last-of-type", 3, true],
    ["li:empty", 3, true],
    ["[data-x=foo i]", 0, true],
    ["[data-x=foo]", 0, false],
    [".md\\:flex", 0, false],
  ])("%s on child %i → %s", (sel, i, expected) => {
    expect(matches(parseSelector(sel)!, kids[i]!)).toBe(expected);
  });

  it("matches :has()", () => {
    expect(matches(parseSelector("ul:has(> .on)")!, root)).toBe(true);
    expect(matches(parseSelector("ul:has(.off)")!, root)).toBe(false);
  });

  it("unescapes class names", () => {
    const el = (cls: string): SelectorElement => ({ tagName: "div", getAttribute: (n) => (n === "class" ? cls : undefined), parent: () => undefined, position: () => ({ index: 1, count: 1 }) });
    expect(matches(parseSelector(".md\\:flex")!, el("md:flex"))).toBe(true);
    expect(matches(parseSelector(".w-1\\/2")!, el("w-1/2"))).toBe(true);
    expect(matches(parseSelector(".p-0\\.5")!, el("p-0.5"))).toBe(true);
    expect(matches(parseSelector(".\\31 0")!, el("10"))).toBe(true);
  });

  it("gives :where zero specificity and :is its argument's", () => {
    expect(parseSelector(":where(#a) p")!.specificity).toEqual([0, 0, 1]);
    expect(parseSelector(":is(#a, .b) p")!.specificity).toEqual([1, 0, 1]);
  });
});

describe("modern values", () => {
  it.each([
    ["oklch(58.8% 0.158 241.966)", "#0084d1"],
    ["oklch(96.8% 0.007 247.896)", "#f1f5f9"],
    ["color-mix(in oklab, #000 50%, transparent)", "#00000080"],
    ["lab(50% 40 59.5)", "#bf5700"],
    ["hwb(120 0% 0%)", "#00ff00"],
    ["rgb(0 0 0 / 0.1)", "#0000001a"],
    ["hsl(120deg 100% 50%)", "#00ff00"],
    ["rebeccapurple", "#663399"],
    ["color(srgb 1 0 0)", "#ff0000"],
  ])("color %s", (input, expected) => {
    expect(parseColor(input)).toBe(expected);
  });

  const ctx = { fontSize: 12, rootFontSize: 12 };
  it.each([
    ["calc(1 / 2 * 100%)", { value: 50, unit: "%" }],
    ["calc(0.25rem * 4)", { value: 12, unit: "pt" }],
    ["clamp(1rem, 2vw, 2rem)", { value: 12, unit: "pt" }],
    ["max(0px, 1rem - 20px)", { value: 0, unit: "pt" }],
    ["min(10px, 1rem)", { value: 7.5, unit: "pt" }],
    ["calc(-1 * 0.5rem)", { value: -6, unit: "pt" }],
    ["10vw", { value: 59.528, unit: "pt" }],
  ])("length %s", (input, expected) => {
    expect(parseLength(input, ctx)).toEqual(expected);
  });

  it("maps logical properties to physical sides", () => {
    const out = source(`<div style="padding-inline: 10pt; padding-block: 4pt 6pt; margin-block-start: 8pt; background: #eee">x</div>`);
    expect(out).toContain("inset: (top: 4pt, right: 10pt, bottom: 6pt, left: 10pt)");
  });

  it("simplifies unitless calc() line heights", () => {
    expect(htmlToTypst(`<p style="line-height: calc(1.25 / 0.875)">x</p>`).warnings).toEqual([]);
  });

  it("expands the font shorthand", () => {
    const out = source(`<p style="font: italic bold 15px/1.5 Georgia, serif">x</p>`);
    expect(out).toContain('style: "italic"');
    expect(out).toContain("size: 11.25pt");
  });

  it("adds padding to content-box widths but not border-box ones", () => {
    expect(source(`<div style="width: 100pt; padding: 0 10pt; background: red">x</div>`)).toContain("width: 100pt + 10pt + 10pt");
    expect(source(`<div style="box-sizing: border-box; width: 100pt; padding: 0 10pt; background: red">x</div>`)).toContain("width: 100pt,");
  });
});
