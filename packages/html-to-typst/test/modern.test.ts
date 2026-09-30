import { describe, expect, it } from "vitest";
import { htmlToTypst, TranspileError, type Block, type Inline } from "../src/index.js";

const doc = (html: string, css = "") => htmlToTypst(`<style>${css}</style>${html}`);
const blocks = (html: string, css = "") => doc(html, css).document.children;
const para = (html: string, css = ""): Inline[] => {
  const [p] = blocks(`<p>${html}</p>`, css);
  return (p as Extract<Block, { kind: "paragraph" }>).children;
};

describe("never fails silently", () => {
  it("warns about unknown properties and unsupported values", () => {
    const { warnings } = doc('<div class="a">x</div>', ".a { mix-blend-mode: multiply; display: table-caption; line-height: tall; cursor: pointer; -webkit-font-smoothing: auto }");
    expect(warnings).toEqual([
      "Unsupported CSS ignored: mix-blend-mode: multiply (<div>)",
      "Unsupported CSS value ignored: display: table-caption (<div>)",
      "Unsupported CSS value ignored: line-height: tall (<div>)",
    ]);
  });

  it("warns about background layers it cannot paint", () => {
    const { warnings } = doc('<div style="background: url(x.png) no-repeat #fff">x</div>');
    expect(warnings).toEqual(["Unsupported CSS value ignored: background: url(x.png) no-repeat (<div>)"]);
  });

  it("warns about undefined variables", () => {
    expect(doc('<p style="color: var(--nope)">x</p>').warnings).toContain("Undefined CSS variable --nope");
  });

  it("throws in strict mode", () => {
    expect(() => htmlToTypst('<div style="float: left">x</div>', { strict: true })).toThrow(TranspileError);
    expect(() => htmlToTypst("<p>ok</p>", { strict: true })).not.toThrow();
  });
});

describe("CSS variables and calc", () => {
  it("resolves inherited variables, fallbacks and :root", () => {
    const b = blocks(
      '<div class="card"><p class="t">x</p></div>',
      ":root { --brand: #6c5ce7; --pad: 8px } .card { border-left: 4px solid var(--brand); padding: var(--pad) } .t { color: var(--missing, var(--brand)) }",
    );
    expect(b[0]).toMatchObject({
      kind: "box",
      style: { stroke: { left: { width: { value: 3 }, color: "#6c5ce7" } }, inset: { top: { value: 6 } } },
      children: [{ kind: "styled-block", style: { fill: "#6c5ce7" } }],
    });
  });

  it("lets later declarations override variables per element", () => {
    const b = blocks('<p class="a">x</p><p class="a b">y</p>', ":root{--c:red} .a{color:var(--c)} .b{--c:blue}");
    expect(b.map((x) => (x as { style?: { fill?: string } }).style?.fill)).toEqual(["#ff0000", "#0000ff"]);
  });

  it("evaluates calc in lengths", () => {
    expect(blocks('<div style="padding: calc(4px * 2)">x</div>')[0]).toMatchObject({ style: { inset: { top: { value: 6 } } } });
  });
});

describe("gradients and opacity", () => {
  it("paints linear gradients from background and background-image", () => {
    const [b] = blocks('<div style="background: linear-gradient(135deg, #6c5ce7, #00cec9); color: white">x</div>');
    expect(b).toMatchObject({ kind: "styled-block", children: [{ kind: "box", style: { fill: { kind: "linear", angle: 135 } } }] });
    expect(doc('<div style="background: linear-gradient(to right, red, blue)">x</div>').source).toContain(
      'gradient.linear((rgb("#ff0000"), 0%), (rgb("#0000ff"), 100%), angle: 0deg)',
    );
  });

  it("applies opacity to text, fill and border", () => {
    const [b] = blocks('<div style="opacity: .5; background: #000; border: 1px solid #ff0000; color: #00ff00">x</div>');
    expect(b).toMatchObject({
      kind: "styled-block",
      style: { fill: "#00ff0080" },
      children: [{ kind: "box", style: { fill: "#00000080", stroke: { top: { color: "#ff000080" } } } }],
    });
  });

  it("uses gradients in table cells", () => {
    const [t] = blocks('<table><tr><td style="background-image: radial-gradient(white, #ccc)">a</td></tr></table>');
    expect((t as Extract<Block, { kind: "table" }>).body[0]!.cells[0]!.fill).toMatchObject({ kind: "radial" });
  });

  it("renders dashed and dotted borders", () => {
    expect(doc('<div style="border: 1px dashed red">x</div>').source).toContain('dash: "dashed"');
  });
});

describe("inline boxes", () => {
  it("paints badges with background, radius and padding", () => {
    expect(para('Hola <span class="badge">NUEVO</span>', ".badge { background: #ffeaa7; border-radius: 999px; padding: 2px 10px }")).toEqual([
      { kind: "text", value: "Hola " },
      {
        kind: "box",
        style: {
          fill: "#ffeaa7",
          radius: { value: 749.25, unit: "pt" },
          inset: { right: { value: 7.5, unit: "pt" }, left: { value: 7.5, unit: "pt" } },
          outset: { top: { value: 1.5, unit: "pt" }, bottom: { value: 1.5, unit: "pt" } },
        },
        children: [{ kind: "text", value: "NUEVO" }],
      },
    ]);
  });

  it("does not repaint inherited backgrounds on children", () => {
    const nodes = para('<span style="background: yellow">a <b>b</b></span>');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "box", children: [{ kind: "text" }, { kind: "strong" }] });
  });
});

describe("text-transform and generated content", () => {
  it("transforms text case", () => {
    expect(para('<span style="text-transform: uppercase">hola ñandú</span> <span style="text-transform: capitalize">el mejor-caso</span>')).toEqual([
      { kind: "text", value: "HOLA ÑANDÚ El Mejor-Caso" },
    ]);
  });

  it("inherits text-transform into headings", () => {
    expect(blocks("<h1>informe</h1>", "h1 { text-transform: uppercase }")[0]).toMatchObject({ children: [{ kind: "text", value: "INFORME" }] });
  });

  it("inserts ::before/::after content with escapes, attr() and styles", () => {
    const nodes = para('<a href="https://x.y" data-n="3">link</a>', 'a::before { content: "\\2713  "; color: green } a::after { content: " (" attr(data-n) ")" }');
    expect(nodes).toEqual([
      {
        kind: "link",
        href: "https://x.y",
        children: [
          { kind: "styled", style: { fill: "#008000" }, children: [{ kind: "text", value: "✓ " }] },
          { kind: "text", value: "link (3)" },
        ],
      },
    ]);
  });

  it("replaces list markers with list-style and ::before", () => {
    const [list] = blocks('<ul class="check"><li>a</li></ul><ol type="A"><li>x</li></ol><ol style="list-style: lower-roman inside"><li>y</li></ol>',
      "ul.check { list-style: none } ul.check li::before { content: '✓ ' }");
    expect(list).toMatchObject({ kind: "list", marker: "", items: [[{ kind: "paragraph", children: [{ kind: "text", value: "✓ a" }] }]] });
    const b = doc('<ol type="A"><li>x</li></ol><ol style="list-style-type: lower-roman"><li>y</li></ol><ul style="list-style-type: square"><li>z</li></ul>');
    expect(b.document.children.map((x) => (x as { numbering?: string; marker?: string }).numbering ?? (x as { marker?: string }).marker)).toEqual(["A.", "i.", "▪"]);
    expect(b.source).toContain('enum(numbering: "A."');
    expect(doc('<ol style="list-style: none"><li>x</li></ol>').source).toContain("numbering: n => []");
  });

  it("warns about unsupported content functions", () => {
    expect(doc("<p>x</p>", 'p::before { content: counter(item) }').warnings).toEqual(["Unsupported content value ignored: counter(item) (<p::before>)"]);
  });
});
