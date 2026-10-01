import { describe, expect, it } from "vitest";
import { htmlToTypst, type Block } from "../src/index.js";

const grid = (html: string) => {
  const r = htmlToTypst(html);
  const find = (blocks: Block[]): Extract<Block, { kind: "grid" }> | undefined => {
    for (const b of blocks) {
      if (b.kind === "grid") return b;
      if ("children" in b && Array.isArray(b.children)) {
        const g = find(b.children as Block[]);
        if (g) return g;
      }
    }
  };
  return { grid: find(r.document.children)!, warnings: r.warnings, source: r.source };
};

const flex = (justify: string, extra = "") =>
  grid(`<div style="display:flex; justify-content:${justify}; ${extra}"><span>A</span><span>B</span><span>C</span></div>`);

describe("flex justify-content", () => {
  it("leaves flex-start as plain auto columns", () => {
    const { grid: g, warnings } = flex("flex-start");
    expect(g.columns).toEqual(["auto", "auto", "auto"]);
    expect(g.columnGutters).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it.each([
    ["flex-end", ["1fr", "auto", "auto", "auto"]],
    ["center", ["1fr", "auto", "auto", "auto", "1fr"]],
    ["space-between", ["auto", "1fr", "auto", "1fr", "auto"]],
    ["space-around", ["0.5fr", "auto", "1fr", "auto", "1fr", "auto", "0.5fr"]],
    ["space-evenly", ["1fr", "auto", "1fr", "auto", "1fr", "auto", "1fr"]],
  ])("%s distributes free space in spacer columns", (justify, expected) => {
    const { grid: g, warnings } = flex(justify);
    expect(g.columns.map((c) => (typeof c === "string" ? c : `${c.value}${c.unit}`))).toEqual(expected);
    expect(g.cells).toHaveLength(expected.length);
    expect(warnings).toEqual([]);
  });

  it("keeps the gap between items, not next to edge spacers", () => {
    const { grid: g } = flex("center", "gap: 8pt");
    expect(g.columnGutters).toEqual([
      { value: 0, unit: "pt" },
      { value: 8, unit: "pt" },
      { value: 8, unit: "pt" },
      { value: 0, unit: "pt" },
    ]);
  });

  it("ignores justification when an item grows, as CSS does", () => {
    const { grid: g } = grid(`<div style="display:flex; justify-content:center"><div style="flex:1">A</div><div>B</div></div>`);
    expect(g.columns).toEqual([{ value: 1, unit: "fr" }, "auto"]);
  });

  it("shrinks items with a background to their content", () => {
    const { source } = grid(`<div style="display:flex"><div style="background:#eee">A</div></div>`);
    expect(source).not.toContain("width: 100%");
  });
});

describe("flex align-items", () => {
  it.each([
    ["center", "horizon"],
    ["flex-end", "bottom"],
    ["flex-start", "top"],
  ])("%s aligns every cell", (value, expected) => {
    expect(flex("flex-start", `align-items:${value}`).grid.valign).toBe(expected);
  });

  it("warns where it is not converted", () => {
    const { warnings } = grid(`<div style="display:flex; flex-direction:column; align-items:center"><div>A</div></div>`);
    expect(warnings).toEqual(["Unsupported CSS ignored: align-items: center with flex-direction: column"]);
  });
});

describe("text-align on headings", () => {
  it("aligns a heading", () => {
    expect(htmlToTypst(`<h1 style="text-align:center">T</h1>`).source).toContain('align(center, heading(level: 1, "T"))');
  });

  it("inherits the alignment and survives the heading's own margin", () => {
    const { source } = htmlToTypst(`<div style="text-align:right"><h2 style="margin:0 0 10px">T</h2></div>`);
    // Full width, so the margin's auto-width block cannot shrink it.
    expect(source).toContain('block(width: 100%, align(right, heading(level: 2, "T")))');
  });
});
