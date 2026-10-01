import { describe, expect, it } from "vitest";
import { htmlToTypst, type Block } from "../src/index.js";

const doc = (html: string, css = "") => htmlToTypst(`<style>${css}</style>${html}`);
const blocks = (html: string, css = "") => doc(html, css).document.children;

describe("horizontal margins", () => {
  it("pads blocks outside their box and alignment", () => {
    const [b] = blocks('<div style="margin: 0 10px 0 20px; background: #eee">x</div>');
    expect(b).toMatchObject({ kind: "pad", left: { value: 15 }, right: { value: 7.5 }, children: [{ kind: "box", style: { fill: "#eeeeee" } }] });
    expect(doc('<p style="margin-left: 5%">x</p>').source).toContain("pad(left: 5%,");
  });

  it("combines auto and fixed margins", () => {
    const [b] = blocks('<div style="width: 50%; margin-left: auto; margin-right: 16px">x</div>');
    expect(b).toMatchObject({ kind: "pad", right: { value: 12 }, children: [{ kind: "box", style: { align: "right" } }] });
  });

  it("adds space around inline elements", () => {
    const [p] = blocks('<p>a<span style="margin: 0 8px">b</span>c</p>');
    expect((p as Extract<Block, { kind: "paragraph" }>).children).toEqual([
      { kind: "text", value: "a" },
      { kind: "space", width: { value: 6, unit: "pt" } },
      { kind: "text", value: "b" },
      { kind: "space", width: { value: 6, unit: "pt" } },
      { kind: "text", value: "c" },
    ]);
  });

  it("does not pad out-of-flow elements", () => {
    expect(blocks('<div style="position: absolute; top: 0; margin-left: 10px">x</div>')[0]).toMatchObject({ kind: "place" });
  });
});

describe("line-height", () => {
  it.each([
    ["1.5", 1.5],
    ["150%", 1.5],
    ["2em", 2],
    ["18px", 1.13],
    ["1", 1],
  ])("maps %s to a multiple of the font size", (value, lineHeight) => {
    expect(blocks(`<p style="line-height: ${value}">x</p>`)[0]).toMatchObject({ lineHeight });
  });

  it("sets the document default from body and only overrides differences", () => {
    const r = doc('<p>a</p><p class="loose">b</p><div class="loose"><p>c</p></div>', "body { line-height: 1.4 } .loose { line-height: 2 }");
    expect(r.document.lineHeight).toBe(1.4);
    // The nested paragraph inherits line-height from its div.
    expect(r.document.children.map((b) => (b as { lineHeight?: unknown }).lineHeight)).toEqual([undefined, 2, 2]);
    expect(r.source).toContain("#show: css-line-height.with(1.4)");
    expect(r.source).toContain("css-line-height(2, par(");
  });
});

