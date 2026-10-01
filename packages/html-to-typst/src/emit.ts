import type { BackgroundImage, Block, BoxStyle, FirstPage, Length, PageRun, PageSetup, Sides, Stroke, Document, Inline, MarginBand, MarginBox, Shadow, Size, TableCell, TableRow, TextStyle, TransformOp } from "./ir.js";
import { align, call, color, length, num, paint, sides, size, str, stroke } from "./literals.js";

/**
 * IR → Typst source. The body is emitted entirely in code mode: every node is
 * a function call and every text run a string literal, so the output is
 * correct by construction regardless of what characters the HTML contained.
 */
export function emitDocument(doc: Document): string {
  const lines: string[] = [];
  if (doc.page) lines.push("#" + call("set page", pageArgs(doc.page)));
  // CSS line boxes span the font's ascender to descender; Typst's default
  // cap-height/baseline edges would let lines of text touch or overlap.
  const text = {
    ...textArgs(doc.text ?? {}),
    lang: doc.lang === undefined ? undefined : str(doc.lang),
    "top-edge": str("ascender"),
    "bottom-edge": str("descender"),
  };
  lines.push("#" + call("set text", text));
  lines.push("#" + call("set par", { leading: doc.leading ? length(doc.leading) : LINE_GAP }));
  lines.push(`#${seq(doc.children.map(emitBlock))}`);
  return lines.join("\n") + "\n";
}

function pageArgs(p: PageSetup): Record<string, string | undefined> {
  const first = p.first;
  const decorate = (value: MarginBand | null | undefined, override: MarginBand | null | undefined, has: boolean) => {
    const base = value === null ? "none" : value && band(value);
    if (!has) return base;
    const alt = override ? band(override) : "none";
    return `context if here().page() == 1 { ${alt} } else { ${base ?? "none"} }`;
  };
  return {
    paper: p.paper === undefined ? undefined : str(p.paper),
    flipped: p.flipped ? "true" : undefined,
    width: p.width && length(p.width),
    height: p.height && length(p.height),
    margin: p.margin && sides(p.margin, length),
    fill: p.fill && paint(p.fill),
    // `fill` cannot vary per page, so a different first-page fill is painted as background.
    background: pageBackground(p, first),
    header: first && "header" in first ? decorate(p.header, first.header, true) : decorate(p.header, undefined, false),
    footer: first && "footer" in first ? decorate(p.footer, first.footer, true) : decorate(p.footer, undefined, false),
    foreground: p.foreground && blocks(p.foreground),
  };
}

/** Page background image and a different first-page fill (`fill` cannot vary per page). */
function pageBackground(p: PageSetup, first: FirstPage | undefined): string | undefined {
  const image = p.image && backgroundPicture(p.image, "100%", "100%");
  if (!first || !("fill" in first)) return image;
  const cover = call("rect", { width: "100%", height: "100%", fill: first.fill ? paint(first.fill) : "white" });
  return `context if here().page() == 1 { ${cover} } else { ${image ?? "none"} }`;
}

function backgroundPicture(img: BackgroundImage, width: string, height: string): string {
  const fit = img.fit;
  const picture = typeof fit === "string"
    ? call("image", { width: "100%", height: "100%", fit: str(fit) }, str(img.src))
    : call("image", { width: fit.width && length(fit.width), height: fit.height && length(fit.height) }, str(img.src));
  return call("block", { width, height }, `align(${img.align.x} + ${img.align.y}, ${picture})`);
}

function pageRun(run: PageRun): string {
  const body: string[] = [call("pagebreak", { weak: "true" })];
  if (run.page) body.push(call("set page", pageArgs(run.page)));
  if (run.text || run.lang) {
    body.push(call("set text", { ...textArgs(run.text ?? {}), lang: run.lang === undefined ? undefined : str(run.lang) }));
  }
  if (run.leading) body.push(call("set par", { leading: length(run.leading) }));
  body.push(...run.children.map(emitBlock));
  return `{\n${body.map((i) => indent(i)).join("\n")}\n}`;
}

/** Gap between line boxes that approximates `line-height: normal` (≈1.2). */
const LINE_GAP = "0.2em";

/** Joins content values; a code block concatenates its expressions. */
/** The current page's resolved margins (Typst's `auto` default included). */
const PAGE_MARGINS =
  "{ let v = page.margin; let d = 2.5 / 21 * calc.min(page.width, page.height); " +
  "let r(x, full) = if x == auto { d } else if type(x) == relative { x.length + x.ratio * full } else if type(x) == ratio { x * full } else { x }; " +
  "if v == auto { (left: d, right: d, top: d, bottom: d) } else { (left: r(v.left, page.width), right: r(v.right, page.width), top: r(v.top, page.height), bottom: r(v.bottom, page.height)) } }";

function seq(items: string[]): string {
  if (items.length === 0) return "[]";
  if (items.length === 1) return items[0]!;
  return `{\n${items.map((i) => indent(i)).join("\n")}\n}`;
}

function indent(s: string): string {
  return s.replace(/^/gm, "  ");
}

function textArgs(s: TextStyle): Record<string, string | undefined> {
  return {
    font: s.font && `(${s.font.map(str).join(", ")}${s.font.length === 1 ? "," : ""})`,
    size: s.size && length(s.size),
    weight: s.weight === undefined ? undefined : typeof s.weight === "number" ? num(s.weight) : str(s.weight),
    style: s.style && str(s.style),
    fill: s.fill && color(s.fill),
    tracking: s.tracking && length(s.tracking),
  };
}

export function emitInline(node: Inline): string {
  switch (node.kind) {
    case "text":
      return str(node.value);
    case "strong":
    case "emph":
    case "underline":
    case "strike":
    case "super":
    case "sub":
      return `${node.kind}(${inlines(node.children)})`;
    case "code":
      return `raw(${str(node.value)})`;
    case "link":
      return `link(${str(node.href)}, ${inlines(node.children)})`;
    case "styled":
      return call("text", textArgs(node.style), inlines(node.children));
    case "box": {
      const s = node.style;
      return call(
        "box",
        {
          width: s.width && size(s.width),
          inset: s.inset && sides(s.inset, length),
          outset: s.outset && sides(s.outset, length),
          fill: s.fill && paint(s.fill),
          stroke: s.stroke && sides(s.stroke, stroke),
          radius: s.radius && length(s.radius),
        },
        inlines(node.children),
      );
    }
    case "linebreak":
      return "linebreak()";
    case "space":
      return `h(${length(node.width)})`;
    case "move":
      return call("box", {}, call("move", { dx: length(node.dx), dy: length(node.dy) }, inlines(node.children)));
    case "page-counter":
      return node.which === "page"
        ? "context counter(page).display()"
        : "context str(counter(page).final().first())";
    case "image":
      return call("box", {}, imageCall(node));
  }
}

function inlines(nodes: Inline[]): string {
  return seq(nodes.map(emitInline));
}

function blocks(nodes: Block[]): string {
  return seq(nodes.map(emitBlock));
}

function imageCall(n: { src: string; width?: Size; height?: Size; alt?: string }): string {
  return call(
    "image",
    {
      width: n.width && size(n.width),
      height: n.height && size(n.height),
      alt: n.alt === undefined ? undefined : str(n.alt),
    },
    str(n.src),
  );
}

export function emitBlock(node: Block): string {
  switch (node.kind) {
    case "paragraph": {
      const body = call(
        "par",
        {
          justify: node.justify === undefined ? undefined : String(node.justify),
          leading: node.leading && length(node.leading),
        },
        inlines(node.children),
      );
      return node.align ? `align(${align(node.align)}, ${body})` : body;
    }
    case "heading": {
      const body = call("heading", { level: String(node.level) }, inlines(node.children));
      // Full width, so an enclosing auto-width block cannot shrink it to its text.
      return node.align ? `block(width: 100%, align(${align(node.align)}, ${body}))` : body;
    }
    case "list": {
      const items = node.items.map(blocks);
      return node.ordered
        ? call(
            "enum",
            {
              start: node.start === undefined ? undefined : num(node.start),
              numbering: node.numbering === undefined ? undefined : str(node.numbering),
              // An empty numbering pattern hides the numbers (`list-style: none`).
              ...(node.numbering === "" ? { numbering: "n => []" } : {}),
            },
            ...items,
          )
        : call("list", { marker: node.marker === undefined ? undefined : node.marker === "" ? "[]" : str(node.marker) }, ...items);
    }
    case "box":
      return boxBlock(node.style, node.children);
    case "place": {
      // Fixed boxes are offset from the page area, i.e. inside the margins.
      const m = (side: string) => (node.pageArea ? `m.${side} + ` : "");
      const neg = (side: string, l: Length) => (node.pageArea ? `-(${m(side)}${length(l)})` : `-${length(l)}`);
      const dx = node.x === "left" ? `${m("left")}${length(node.dx)}` : neg("right", node.dx);
      const dy = node.y === "top" ? `${m("top")}${length(node.dy)}` : neg("bottom", node.dy);
      let body = blocks(node.children);
      if (node.span) {
        const margins = node.pageArea ? " - m.left - m.right" : "";
        body = call("block", { width: `100%${margins} - ${length(node.span.left)} - ${length(node.span.right)}` }, body);
      }
      const placed = call("place", { dx, dy }, `${node.y} + ${node.x}`, body);
      return node.pageArea ? `context {\n  let m = ${PAGE_MARGINS}\n${indent(placed)}\n}` : placed;
    }
    case "transform":
      return transform(node.ops, blocks(node.children));
    case "pad":
      return call("pad", { left: node.left && length(node.left), right: node.right && length(node.right) }, blocks(node.children));
    case "styled-block":
      return call("text", textArgs(node.style), blocks(node.children));
    case "table": {
      const parts: string[] = [];
      if (node.header?.length) parts.push(call("table.header", { repeat: "true" }, ...rows(node.header)));
      parts.push(...rows(node.body));
      if (node.footer?.length) parts.push(call("table.footer", {}, ...rows(node.footer)));
      return call(
        "table",
        {
          columns: `(${node.columns.map(size).join(", ")}${node.columns.length === 1 ? "," : ""})`,
          stroke:
            node.stroke === undefined
              ? undefined
              : node.stroke === null
                ? "none"
                : "width" in node.stroke
                  ? stroke(node.stroke as Stroke)
                  : tableSides(node.stroke),
          inset: node.inset && length(node.inset),
        },
        ...parts,
      );
    }
    case "grid":
      return call(
        "grid",
        {
          columns: `(${node.columns.map(size).join(", ")}${node.columns.length === 1 ? "," : ""})`,
          ...(node.columnGutters
            ? {
                "column-gutter": `(${node.columnGutters.map(length).join(", ")}${node.columnGutters.length === 1 ? "," : ""})`,
                "row-gutter": node.gutter && length(node.gutter),
              }
            : { gutter: node.gutter && length(node.gutter) }),
          align: node.valign,
        },
        ...node.cells.map(blocks),
      );
    case "raw-block":
      return call("raw", { block: "true", lang: node.lang === undefined ? undefined : str(node.lang) }, str(node.value));
    case "rule":
      return "line(length: 100%)";
    case "columns":
      return balancedColumns(node.count, node.gutter ? length(node.gutter) : "1em", blocks(node.children));
    case "page-run":
      return pageRun(node);
    case "pagebreak":
      return call("pagebreak", { weak: node.weak ? "true" : undefined });
    case "image":
      return imageCall(node);
  }
}

function rows(rs: TableRow[]): string[] {
  return rs.flatMap((r) => r.cells.map(cell));
}

function cell(c: TableCell): string {
  const named = {
    colspan: c.colspan && c.colspan > 1 ? num(c.colspan) : undefined,
    rowspan: c.rowspan && c.rowspan > 1 ? num(c.rowspan) : undefined,
    align: c.align && align(c.align),
    fill: c.fill && paint(c.fill),
    // Sides left out fall back to the table's stroke.
    stroke: c.stroke && `(${(["top", "right", "bottom", "left"] as const).filter((k) => c.stroke![k]).map((k) => `${k}: ${stroke(c.stroke![k]!)}`).join(", ")})`,
  };
  const body = blocks(c.children);
  return Object.values(named).some((v) => v !== undefined) ? call("table.cell", named, body) : body;
}

function transform(ops: TransformOp[], body: string): string {
  // CSS applies the list right to left, so the first function is outermost.
  return ops.reduceRight((inner, op) => {
    switch (op.kind) {
      case "rotate":
        return call("rotate", { reflow: "false" }, `${num(op.deg)}deg`, inner);
      case "scale":
        return call("scale", { x: `${num(op.x * 100)}%`, y: `${num(op.y * 100)}%`, reflow: "false" }, inner);
      case "translate":
        return call("move", { dx: length(op.dx), dy: length(op.dy) }, inner);
    }
  }, body);
}

/** Blur is approximated by stacking progressively smaller translucent layers. */
const BLUR_STEPS = 4;

/**
 * Paints `box-shadow` layers behind a block. Typst has no shadows, so the
 * block is measured and translucent rounded rectangles are placed under it.
 */
function boxBlock(s: BoxStyle, children: Block[]): string {
  const vpad = [s.inset?.top, s.inset?.bottom].filter((l): l is Length => !!l).map(length);
  // CSS heights exclude padding unless border-box; Typst's include it.
  const outer = (l: Length) => (s.borderBox || !vpad.length ? length(l) : [length(l), ...vpad].join(" + "));
  const inner = (l: Length) => (!s.borderBox || !vpad.length ? length(l) : [length(l), ...vpad].join(" - "));
  let body = blocks(children);
  // A zero-width strut column keeps the row at least `min-height` tall.
  if (s.minHeight) body = call("grid", { columns: "(0pt, 1fr)" }, call("block", { height: inner(s.minHeight) }), body);
  const spacing = {
    above: s.above && length(s.above),
    below: s.below && length(s.below),
    breakable: s.breakable === undefined ? undefined : String(s.breakable),
  };
  const args = {
    width: s.width && size(s.width),
    height: s.height && outer(s.height),
    inset: s.inset && sides(s.inset, length),
    fill: s.fill && paint(s.fill),
    stroke: s.stroke && sides(s.stroke, stroke),
    radius: s.radius && length(s.radius),
  };
  let b = s.image ? withBackground(s, args, spacing, body) : call("block", { ...args, ...spacing }, body);
  if (s.shadows?.length) b = shadowed(b, s);
  return s.align ? `align(${align(s.align)}, ${b})` : b;
}

/** Paints a background image under the box content, clipped to the box. */
function withBackground(
  s: BoxStyle,
  args: Record<string, string | undefined>,
  spacing: Record<string, string | undefined>,
  body: string,
): string {
  const layer = call(
    "block",
    { width: "m.width", height: "m.height", radius: args.radius, fill: args.fill, clip: "true" },
    backgroundPicture(s.image!, "100%", "100%"),
  );
  return [
    "layout(size => {",
    indent(`let body = ${call("block", { ...args, fill: undefined }, body)}`),
    "  let m = measure(body, width: size.width, height: size.height)",
    `  ${call("block", { ...spacing, breakable: "false" }, `{
    place(${layer})
    body
  }`)}`,
    "})",
  ].join("\n");
}

/**
 * CSS balances column heights by default; Typst fills each column in turn.
 * Measure the content at column width and cap the height at an even share,
 * with slack for lines that cannot split across columns. Content taller than
 * the region flows normally across pages instead.
 */
function balancedColumns(count: number, gutter: string, body: string): string {
  return [
    "layout(size => {",
    indent(`let body = ${body}`),
    `  let w = (size.width - ${gutter} * ${count - 1}) / ${count}`,
    "  let h = measure(block(width: w, body)).height",
    `  let target = (h / ${count} + ${count - 1} * 1.5em).to-absolute()`,
    `  let cols = columns(${count}, gutter: ${gutter}, body)`,
    "  if target < size.height { block(height: target, breakable: false, cols) } else { cols }",
    "})",
  ].join("\n");
}

function shadowed(block: string, style: BoxStyle): string {
  const radius = style.radius ? length(style.radius) : "0pt";
  const layers = (style.shadows ?? []).flatMap((sh: Shadow) => {
    const steps = sh.blur.value > 0 ? BLUR_STEPS : 1;
    return Array.from({ length: steps }, (_, i) => {
      // Largest (outermost) layer first; each adds 1/steps of the opacity.
      const k = steps === 1 ? 0 : (steps - i) / steps / 2;
      const grow = `(${length(sh.spread)} + ${length(sh.blur)} * ${num(k)})`;
      const color = steps === 1 ? sh.color : fade(sh.color, 1 / steps);
      return `place(dx: ${length(sh.dx)} - ${grow}, dy: ${length(sh.dy)} - ${grow}, block(width: m.width + 2 * ${grow}, height: m.height + 2 * ${grow}, radius: ${radius} + ${grow}, fill: ${paint(color)}))`;
    });
  });
  return [
    "layout(size => {",
    indent(`let body = ${block}`),
    "  let m = measure(body, width: size.width, height: size.height)",
    `  block(breakable: false, {\n${layers.map((l) => indent(indent(l))).join("\n")}\n    body\n  })`,
    "})",
  ].join("\n");
}

function fade(color: `#${string}`, factor: number): `#${string}` {
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
  return `#${color.slice(1, 7)}${Math.round(alpha * factor).toString(16).padStart(2, "0")}`;
}

function marginBox(box: MarginBox | undefined): string {
  if (!box) return "[]";
  const body = box.blocks ? blocks(box.blocks) : inlines(box.inlines ?? []);
  return box.style ? call("text", textArgs(box.style), body) : body;
}

/** `@page` margin boxes as a three-column band (left, center, right). */
function band(b: MarginBand): string {
  const slots = (["left", "center", "right"] as const).filter((k) => b[k]);
  if (slots.length === 1) {
    const k = slots[0]!;
    return `align(${k === "center" ? "center" : k} + horizon, ${marginBox(b[k])})`;
  }
  return call(
    "grid",
    { columns: "(1fr, auto, 1fr)", "column-gutter": "1em" },
    `align(left + horizon, ${marginBox(b.left)})`,
    `align(center + horizon, ${marginBox(b.center)})`,
    `align(right + horizon, ${marginBox(b.right)})`,
  );
}

/** Table stroke dictionaries default missing sides to a black rule, so name them all. */
function tableSides(value: Sides<Stroke>): string {
  const all = (["top", "right", "bottom", "left"] as const).map((k) => `${k}: ${value[k] ? stroke(value[k]!) : "none"}`);
  return `(${all.join(", ")})`;
}
