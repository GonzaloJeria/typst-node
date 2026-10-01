import type { BackgroundImage, Block, BoxStyle, FirstPage, Length, LineHeight, PageRun, PageSetup, Sides, Stroke, Document, Inline, MarginBand, MarginBox, Shadow, Size, TableCell, TableRow, TextStyle, TransformOp } from "./ir.js";
import { align, call, color, length, num, paint, radius, sides, size, str, stroke } from "./literals.js";

/**
 * IR → Typst source. The body is emitted entirely in code mode: every node is
 * a function call and every text run a string literal, so the output is
 * correct by construction regardless of what characters the HTML contained.
 */
export function emitDocument(doc: Document): string {
  const lines: string[] = [];
  if (doc.page) lines.push("#" + call("set page", pageArgs(doc.page)));
  // CSS line boxes: `line-height: normal` spans the font's ascender to
  // descender (Typst's default cap-height/baseline edges would let lines
  // touch); other line heights add half the extra space above and below.
  const text = {
    ...textArgs(doc.text ?? {}),
    lang: doc.lang === undefined ? undefined : str(doc.lang),
    "top-edge": str("ascender"),
    "bottom-edge": str("descender"),
  };
  lines.push("#" + call("set text", text));
  // Blocks are spaced only by CSS margins (collapsing like Typst's weak spacing).
  lines.push("#" + call("set par", { leading: "0pt", spacing: "0pt" }));
  lines.push("#" + call("set block", { spacing: "0pt" }));
  lines.push(LINE_HEIGHT_FN);
  if (typeof doc.lineHeight === "number") lines.push(`#show: css-line-height.with(${num(doc.lineHeight)})`);
  // Headings keep their element (for the PDF outline) but take size and
  // weight from CSS, like any other block.
  lines.push("#show heading: it => it.body");
  // Typst drops spacing at the start of the page; CSS keeps the first block's
  // top margin (it does not collapse through the page). An empty block keeps it.
  // Page runs (composed sections) bring their own, after their `set page`: content before
  // a `set page` would start a new page and leave the first one blank.
  const strut = doc.children[0]?.kind === "page-run" ? [] : ["block(height: 0pt)"];
  lines.push(`#${seq([...strut, ...emitBlocks(doc.children)])}`);
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
  if (typeof run.lineHeight === "number") body.push(`show: css-line-height.with(${num(run.lineHeight)})`);
  body.push("block(height: 0pt)", ...emitBlocks(run.children));
  return `{\n${body.map((i) => indent(i)).join("\n")}\n}`;
}

/**
 * Sets text edges so each line box is `l` em tall with the glyphs centered,
 * as CSS does. The font's ascender and descender are measured in context.
 */
const LINE_HEIGHT_FN = `#let css-line-height(l, body) = context {
  let m(t, b) = measure(text(top-edge: t, bottom-edge: b, "x")).height / text.size
  let (a, d) = (m("ascender", "baseline"), m("baseline", "descender"))
  let h = (l - a - d) / 2
  set text(top-edge: (a + h) * 1em, bottom-edge: -(d + h) * 1em)
  body
}`;

function withLineHeight(l: LineHeight | undefined, body: string): string {
  if (l === undefined) return body;
  if (l === "normal") return call("text", { "top-edge": str("ascender"), "bottom-edge": str("descender") }, body);
  return `css-line-height(${num(l)}, ${body})`;
}

/** Joins content values; a code block concatenates its expressions. */
/** The current page's resolved margins (Typst's `auto` default included). */
const PAGE_MARGINS =
  "{ let v = page.margin; let d = 2.5 / 21 * calc.min(page.width, page.height); " +
  "let r(x, full) = if x == auto { d } else if type(x) == relative { x.length + x.ratio * full } else if type(x) == ratio { x * full } else { x }; " +
  "if v == auto { (left: d, right: d, top: d, bottom: d) } else if type(v) != dictionary { let x = r(v, page.width); (left: x, right: x, top: x, bottom: x) } else { (left: r(v.left, page.width), right: r(v.right, page.width), top: r(v.top, page.height), bottom: r(v.bottom, page.height)) } }";

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
    "number-width": s.numberWidth && str(s.numberWidth),
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
          radius: s.radius && radius(s.radius),
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

/**
 * A grid cell's content. Flex and grid items keep their margins inside the
 * cell, but Typst drops spacing at the start and end of a container: empty
 * blocks hold it in place.
 */
function gridCell(nodes: Block[]): string {
  const margin = (b: Block | undefined, side: "above" | "below"): boolean => {
    if (!b) return false;
    if (b.kind === "box") return !!b.style[side] || margin(side === "above" ? b.children[0] : b.children.at(-1), side);
    if (b.kind === "pad" || b.kind === "styled-block") return margin(side === "above" ? b.children[0] : b.children.at(-1), side);
    return "margins" in b && !!b.margins?.[side];
  };
  const strut = "block(height: 0pt)";
  const body = emitBlocks(nodes);
  if (margin(nodes[0], "above")) body.unshift(strut);
  if (margin(nodes.at(-1), "below")) body.push(strut);
  return seq(body);
}

function blocks(nodes: Block[]): string {
  return seq(emitBlocks(nodes));
}

/**
 * Emits sibling blocks. Typst collapses adjacent spacing to the larger one,
 * which matches CSS for positive margins; a negative top margin is combined
 * with the previous bottom margin by hand (`12px` and `-12px` give 0).
 */
function emitBlocks(nodes: Block[]): string[] {
  const out: string[] = [];
  let prev: Block | undefined;
  for (let node of nodes) {
    const above = edgeMargin(node, "above");
    if (above && above.value < 0) {
      node = structuredClone(node);
      setEdgeMargin(node, "above", undefined);
      const below = prev && edgeMargin(prev, "below");
      if (below && below.value > 0 && out.length) {
        const copy = structuredClone(prev!);
        setEdgeMargin(copy, "below", undefined);
        out[out.length - 1] = emitBlock(copy);
        out.push(`v(${length(below)} + ${length(above)})`);
      } else out.push(`v(${length(above)})`);
    }
    out.push(emitBlock(node));
    prev = node;
  }
  return out;
}

type Edge = "above" | "below";

/** The top or bottom margin a block carries, looking through wrappers. */
function edgeMargin(b: Block, side: Edge): Length | undefined {
  if (b.kind === "box") return b.style[side] ?? (b.style.inset || b.style.stroke ? undefined : edgeOfChildren(b.children, side));
  if ("margins" in b && b.margins?.[side]) return b.margins[side];
  if (b.kind === "styled-block" || b.kind === "transform") return edgeOfChildren(b.children, side);
  return undefined;
}

function edgeOfChildren(children: Block[], side: Edge): Length | undefined {
  const child = side === "above" ? children[0] : children.at(-1);
  return child && edgeMargin(child, side);
}

function setEdgeMargin(b: Block, side: Edge, value: Length | undefined): void {
  if (b.kind === "box" && b.style[side]) {
    if (value) b.style[side] = value;
    else delete b.style[side];
  } else if ("margins" in b && b.margins?.[side]) {
    if (value) b.margins[side] = value;
    else delete b.margins[side];
  } else if (b.kind === "box" || b.kind === "styled-block" || b.kind === "transform") {
    const child = side === "above" ? b.children[0] : b.children.at(-1);
    if (child) setEdgeMargin(child, side, value);
  }
}

function imageCall(n: { src: string; width?: Size; height?: Size; alt?: string; fit?: string }): string {
  return call(
    "image",
    {
      width: n.width && size(n.width),
      height: n.height && size(n.height),
      fit: n.fit && str(n.fit),
      alt: n.alt === undefined ? undefined : str(n.alt),
    },
    str(n.src),
  );
}

export function emitBlock(node: Block): string {
  const out = emitBlockBody(node);
  const m = "margins" in node && node.margins && (node.margins.above?.value || node.margins.below?.value) ? node.margins : undefined;
  // Full width: an auto-width block would shrink to its content and defeat `align`.
  return m ? call("block", { width: "100%", above: m.above && length(m.above), below: m.below && length(m.below) }, out) : out;
}

function emitBlockBody(node: Block): string {
  switch (node.kind) {
    case "paragraph": {
      const body = call(
        "par",
        {
          justify: node.justify === undefined ? undefined : String(node.justify),
          // CSS indents the first line of every block, not only after a previous paragraph.
          "first-line-indent": node.indent && `(amount: ${length(node.indent)}, all: true)`,
        },
        inlines(node.children),
      );
      const aligned = node.align ? `align(${align(node.align)}, ${body})` : body;
      return withLineHeight(node.lineHeight, aligned);
    }
    case "heading": {
      const content = inlines(node.children);
      const body = withLineHeight(node.lineHeight, call("heading", { level: String(node.level) }, node.style ? call("text", textArgs(node.style), content) : content));
      // Full width, so an enclosing auto-width block cannot shrink it to its text.
      return node.align ? `block(width: 100%, align(${align(node.align)}, ${body}))` : body;
    }
    case "list": {
      // CSS markers hang outside the content box, in the list's padding: a
      // zero-width box right-aligns them just left of the text.
      const items = node.items.map(blocks);
      const hang = (marker: string) => `box(width: 0pt, align(right, ${marker} + h(0.5em)))`;
      const layout = { indent: "0pt", "body-indent": "0pt" };
      if (node.ordered) {
        const pattern = node.numbering === undefined ? "1." : node.numbering;
        return call(
          "enum",
          {
            start: node.start === undefined ? undefined : num(node.start),
            ...layout,
            // An empty numbering pattern hides the numbers (`list-style: none`).
            numbering: pattern === "" ? "n => []" : `n => ${hang(`numbering(${str(pattern)}, n)`)}`,
          },
          ...items,
        );
      }
      const marker = node.marker === undefined ? "[•]" : node.marker === "" ? undefined : `[${str(node.marker)}]`.replace(/^\[(".*")\]$/, "$1");
      return call("list", { ...layout, marker: marker === undefined ? "[]" : hang(marker) }, ...items);
    }
    case "box":
      return boxBlock(node.style, node.children);
    case "place": {
      // Fixed boxes are offset from the page area, i.e. inside the margins.
      const m = (side: string) => (node.pageArea ? `m.${side} + ` : "");
      const neg = (side: string, l: Length) => (node.pageArea ? `-(${m(side)}${length(l)})` : length({ ...l, value: -l.value }));
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
      const names = node.fillAuto ? cellNames(node) : undefined;
      const parts: string[] = [];
      if (node.header?.length) parts.push(call("table.header", { repeat: "true" }, ...rows(node.header, node.inset, names?.names)));
      parts.push(...rows(node.body, node.inset, names?.names));
      if (node.footer?.length) parts.push(call("table.footer", {}, ...rows(node.footer, node.inset, names?.names)));
      const table = call(
        "table",
        {
          columns: names ? "cols" : tuple(node.columns),
          stroke:
            node.stroke === undefined
              ? undefined
              : node.stroke === null
                ? "none"
                : "width" in node.stroke
                  ? stroke(node.stroke as Stroke)
                  : tableSides(node.stroke),
          inset: node.inset && ("unit" in node.inset ? length(node.inset) : sides(node.inset, length)),
        },
        ...parts,
      );
      return names ? autoTableLayout(node, names, table) : table;
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
          align: [node.halign && align(node.halign), node.valign].filter(Boolean).join(" + ") || undefined,
          rows: node.rows && (node.rowsIfFree ? `if free { ${tuple(node.rows)} } else { auto }` : tuple(node.rows)),
        },
        ...node.cells.map(gridCell),
      );
    case "flow": {
      // Weak spacing between items disappears where a line wraps.
      const gap = node.gap ? `h(${length(node.gap)}, weak: true)` : undefined;
      const items = node.items.map((it) => call("box", { width: it.width && size(it.width) }, gridCell(it.children)));
      const line = call("par", {}, seq(gap ? items.flatMap((it, i) => (i ? [gap, it] : [it])) : items));
      const body = `{\n${indent(`set par(leading: ${node.rowGap ? length(node.rowGap) : "0pt"}, justify: false)`)}\n${indent(node.align ? `align(${align(node.align)}, ${line})` : line)}\n}`;
      return call("block", { width: "100%" }, body);
    }
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

function tuple(sizes: Size[]): string {
  return `(${sizes.map(size).join(", ")}${sizes.length === 1 ? "," : ""})`;
}

/** Variable names for the cells of an auto-layout table, and the cells of each column. */
function cellNames(node: Extract<Block, { kind: "table" }>): { names: Map<TableCell, string>; columns: string[][] } {
  const names = new Map<TableCell, string>();
  const columns: string[][] = node.columns.map(() => []);
  let k = 0;
  for (const section of [node.header ?? [], node.body, node.footer ?? []]) {
    // Rows still covered by a rowspan from above, per column.
    let taken: number[] = [];
    for (const row of section) {
      let col = 0;
      for (const c of row.cells) {
        while ((taken[col] ?? 0) > 0) col++;
        const name = `c${k++}`;
        names.set(c, name);
        const span = c.colspan ?? 1;
        if (span === 1 && node.columns[col] === "auto") columns[col]?.push(name);
        for (let j = 0; j < span; j++) taken[col + j] = c.rowspan ?? 1;
        col += span;
      }
      taken = taken.map((t) => Math.max(0, (t ?? 0) - 1));
    }
  }
  return { names, columns };
}

/**
 * CSS automatic table layout for a table with a width: each `auto` column
 * gets its content's natural width plus a share of the free space
 * proportional to it. When the content does not fit, Typst's own `auto`
 * sizing takes over (it wraps the widest columns first, as browsers do).
 */
function autoTableLayout(node: Extract<Block, { kind: "table" }>, cells: { names: Map<TableCell, string>; columns: string[][] }, table: string): string {
  const all = [...(node.header ?? []), ...node.body, ...(node.footer ?? [])].flatMap((r) => r.cells);
  const inset = node.inset ?? { value: 0, unit: "pt" as const };
  const pad = "unit" in inset ? `2 * ${length(inset)}` : [inset.left, inset.right].map((l) => (l ? length(l) : "0pt")).join(" + ");
  const autos = node.columns.flatMap((c, i) => (c === "auto" ? [i] : []));
  const fixed = node.columns.flatMap((c) => (c === "auto" ? [] : [typeof c === "object" && c.unit === "%" && !c.offset ? `${num(c.value)}% * size.width` : size(c)]));
  const lines = [
    ...all.map((c) => `let ${cells.names.get(c)} = ${blocks(c.children)}`),
    ...autos.map((i) => {
      const list = cells.columns[i]!;
      return `let m${i} = (${list.join(", ")}${list.length === 1 ? "," : ""}).fold(0pt, (a, c) => calc.max(a, measure(c).width)) + ${pad}`;
    }),
    `let need = ${autos.map((i) => `m${i}`).join(" + ")}`,
    `let free = size.width - need${fixed.length ? ` - (${fixed.join(" + ")})` : ""}`,
    `let cols = if free >= 0pt and need > 0pt { (${node.columns.map((c, i) => (c === "auto" ? `m${i} + free * (m${i} / need)` : size(c))).join(", ")},) } else { ${tuple(node.columns)} }`,
    table,
  ];
  return `layout(size => {
${lines.map((l) => indent(l)).join("\n")}
})`;
}

function rows(rs: TableRow[], inset?: Length | Sides<Length>, names?: Map<TableCell, string>): string[] {
  return rs.flatMap((r) => {
    if (!r.height || !r.cells.length) return r.cells.map((c) => cell(c, undefined, names?.get(c)));
    // A zero-width strut in the first cell keeps the row at least `height` tall (padding included).
    const own = r.cells[0]!.inset ?? inset;
    const pad = own && ("unit" in own ? [own, own] : [own.top, own.bottom]).filter((l): l is Length => !!l).map(length);
    const strut = `block(height: calc.max(0pt, ${[length(r.height), ...(pad ?? [])].join(" - ")}))`;
    const [first, ...rest] = r.cells;
    return [cell(first!, strut, names?.get(first!)), ...rest.map((c) => cell(c, undefined, names?.get(c)))];
  });
}

function cell(c: TableCell, strut?: string, name?: string): string {
  const named = {
    colspan: c.colspan && c.colspan > 1 ? num(c.colspan) : undefined,
    rowspan: c.rowspan && c.rowspan > 1 ? num(c.rowspan) : undefined,
    align: c.align && align(c.align),
    fill: c.fill && paint(c.fill),
    inset: c.inset && sides(c.inset, length),
    // Sides left out fall back to the table's stroke.
    stroke: c.stroke && `(${(["top", "right", "bottom", "left"] as const).filter((k) => c.stroke![k]).map((k) => `${k}: ${stroke(c.stroke![k]!)}`).join(", ")})`,
  };
  const content = name ?? blocks(c.children);
  const body = strut ? call("grid", { columns: "(0pt, 1fr)" }, strut, content) : content;
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
  let body = blocks(children);
  // `align` around the block would also align its contents: reset them.
  if (s.align) body = `align(start, ${body})`;
  const spacing = {
    above: s.above && length(s.above),
    below: s.below && length(s.below),
    breakable: s.breakable === undefined ? undefined : String(s.breakable),
  };
  const hpad = [s.inset?.left, s.inset?.right].filter((l): l is Length => !!l).map(length);
  const width = s.width && (s.contentWidth && hpad.length ? [size(s.width), ...hpad].join(" + ") : size(s.width));
  // `min-height`: measured, so a box that fits gets a definite height (in which
  // fractional spacing and bottom-anchored children work) and a taller one breaks freely.
  const min = s.minHeight && !s.height ? outer(s.minHeight) : undefined;
  const args = {
    width,
    height: s.height ? outer(s.height) : min && "h",
    inset: s.inset && sides(s.inset, length),
    fill: s.fill && paint(s.fill),
    stroke: s.stroke && sides(s.stroke, stroke),
    radius: s.radius && radius(s.radius),
    clip: s.clip ? "true" : undefined,
  };
  const content = min ? "body(h != auto)" : body;
  // Spacing set inside a `layout` does not reach the surrounding flow: wrapped boxes get it outside.
  const wrapped = !!(min || s.image || s.shadows?.length);
  const inner = wrapped ? { breakable: spacing.breakable } : spacing;
  let b = s.image ? withBackground(s, args, inner, content) : call("block", { ...args, ...inner }, content);
  if (s.shadows?.length) b = shadowed(b, s);
  if (min) {
    const probe = call("block", { ...args, height: undefined, fill: undefined }, "body(false)");
    // `free`: whether flex-column spacers may take the box's spare height.
    b = ["layout(size => {", indent(`let body(free) = ${body}`), `  let h = measure(${probe}, width: size.width).height`, `  let h = if h < ${min} { ${min} } else { auto }`, indent(b), "})"].join("\n");
  }
  if (s.align) b = `align(${align(s.align)}, ${b})`;
  return wrapped && (spacing.above || spacing.below) ? call("block", { above: spacing.above, below: spacing.below }, b) : b;
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
  // Shadow layers grow uniformly; with uneven corners the top-left one stands for all.
  const r = style.radius && ("unit" in style.radius ? style.radius : style.radius.topLeft);
  const radius = r ? length(r) : "0pt";
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
