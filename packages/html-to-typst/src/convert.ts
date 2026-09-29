import { Cascade, type ComputedStyle } from "./css/cascade.js";
import { parseLength, parseColor, splitValue, type LengthContext } from "./css/values.js";
import { attr, isElement, isText, type Element, type Node } from "./dom.js";
import type {
  Block, BoxStyle, Color, HAlign, Inline, Length, Sides, Size, Stroke, TableCell, TableRow, TextStyle,
} from "./ir.js";

export interface ConvertOptions {
  /** Font stacks for CSS generic families. Unmapped generics are dropped. */
  genericFamilies?: Partial<Record<"serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui", string[]>>;
}

const DEFAULT_GENERICS: NonNullable<ConvertOptions["genericFamilies"]> = {
  // Fonts embedded in the official Typst binary.
  serif: ["Libertinus Serif"],
  monospace: ["DejaVu Sans Mono"],
};

const SKIP = new Set(["head", "script", "style", "template", "noscript", "title", "meta", "link", "iframe", "object", "embed", "video", "audio", "canvas", "form", "input", "button", "select", "textarea", "svg", "math"]);

const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "img", "ins", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr", "font", "big"]);

const HEADINGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Properties that are ignored with a warning because Typst has no equivalent in this mapping. */
const UNSUPPORTED: Record<string, (v: string) => boolean> = {
  float: (v) => v !== "none",
  position: (v) => v !== "static" && v !== "relative",
  transform: (v) => v !== "none",
  "z-index": () => true,
  "flex-wrap": (v) => v !== "nowrap",
  "background-image": (v) => v !== "none",
  "box-shadow": (v) => v !== "none",
  "line-height": (v) => v !== "normal",
};

export class Converter {
  readonly warnings = new Set<string>();
  readonly #generics: NonNullable<ConvertOptions["genericFamilies"]>;
  readonly #styles = new WeakMap<Element, ComputedStyle>();

  constructor(readonly cascade: Cascade, options: ConvertOptions = {}) {
    this.#generics = { ...DEFAULT_GENERICS, ...options.genericFamilies };
    for (const w of cascade.warnings) this.warnings.add(w);
  }

  style(el: Element, parent: ComputedStyle | undefined): ComputedStyle {
    let s = this.#styles.get(el);
    if (!s) {
      s = this.cascade.compute(el, parent, attr(el, "style"));
      this.#styles.set(el, s);
      for (const [prop, isBad] of Object.entries(UNSUPPORTED)) {
        const v = s.props.get(prop);
        // Only warn where the property is declared, not where it is inherited.
        if (v !== undefined && isBad(v) && parent?.props.get(prop) !== v) {
          this.warnings.add(`Unsupported CSS ignored: ${prop}: ${v} (<${el.tagName}>)`);
        }
      }
    }
    return s;
  }

  // ── Block formatting context ──────────────────────────────────────────────

  /** Converts the children of a block container. */
  blocks(container: Element, style: ComputedStyle): Block[] {
    const out: Block[] = [];
    let run = new InlineRun();
    const flush = () => {
      const children = run.finish();
      if (children.length > 0) out.push(this.#paragraph(children, style));
      run = new InlineRun();
    };

    for (const child of container.childNodes) {
      if (isText(child)) {
        run.text(child.value, style.props.get("white-space"));
        continue;
      }
      if (!isElement(child) || SKIP.has(child.tagName)) continue;
      const cs = this.style(child, style);
      const display = displayOf(child, cs);
      if (display === "none") continue;
      if (display === "inline") {
        this.#inlineInto(run, child, cs, style);
      } else {
        flush();
        out.push(...this.#block(child, cs, style));
      }
    }
    flush();
    return out;
  }

  #paragraph(children: Inline[], style: ComputedStyle): Block {
    const p: Extract<Block, { kind: "paragraph" }> = { kind: "paragraph", children };
    const ta = style.props.get("text-align");
    if (ta === "justify") p.justify = true;
    else {
      const a = hAlign(ta);
      if (a && a !== "start" && a !== "left") p.align = a;
    }
    return p;
  }

  #block(el: Element, style: ComputedStyle, parent: ComputedStyle): Block[] {
    const tag = el.tagName;
    let content: Block[];
    const display = style.props.get("display");

    if (tag in HEADINGS) {
      const run = new InlineRun();
      this.#inlineChildren(run, el, style);
      content = [{ kind: "heading", level: HEADINGS[tag]!, children: run.finish() }];
    } else if (tag === "ul" || tag === "ol") {
      content = [this.#list(el, style)];
    } else if (tag === "table") {
      content = [this.#table(el, style)];
    } else if (tag === "pre") {
      const code = el.childNodes.find((n): n is Element => isElement(n) && n.tagName === "code");
      const lang = /(?:^|\s)(?:language|lang)-(\S+)/.exec(code ? attr(code, "class") ?? "" : "")?.[1];
      content = [{ kind: "raw-block", value: textContent(el).replace(/\n$/, ""), ...(lang ? { lang } : {}) }];
    } else if (tag === "hr") {
      content = [{ kind: "rule" }];
    } else if (tag === "img") {
      const img = this.#image(el, style);
      content = img ? [{ ...img }] : [];
    } else if (display === "flex" || display === "grid") {
      content = this.#grid(el, style, display);
    } else {
      content = this.blocks(el, style);
    }

    content = this.#applyBox(el, style, content);

    const textDiff = this.#textDiff(style, parent);
    if (textDiff) content = [{ kind: "styled-block", style: textDiff, children: content }];

    const before = style.props.get("break-before");
    const after = style.props.get("break-after");
    if (before === "page" || before === "left" || before === "right") content.unshift({ kind: "pagebreak", weak: true });
    if (after === "page" || after === "left" || after === "right") content.push({ kind: "pagebreak", weak: true });
    return content;
  }

  #applyBox(el: Element, s: ComputedStyle, content: Block[]): Block[] {
    const ctx = lengthContext(s);
    const box: BoxStyle = {};
    const p = s.props;

    // A table's width is expressed through its column sizes instead.
    const width = el.tagName === "table" ? undefined : p.get("width") ?? p.get("max-width");
    if (width && width !== "auto" && width !== "none") {
      const w = parseLength(width, ctx);
      if (w) box.width = w;
    }
    const inset = sides((side) => positive(parseLength(p.get(`padding-${side}`) ?? "", ctx)));
    if (inset) box.inset = inset;
    const fill = parseColor(p.get("background-color") ?? "");
    if (fill && fill !== "#00000000") box.fill = fill;
    const stroke = sides((side) => borderStroke(p, side, ctx));
    if (stroke) box.stroke = stroke;
    const radius = positive(parseLength(p.get("border-radius") ?? "", ctx));
    if (radius) box.radius = radius;
    const above = parseLength(p.get("margin-top") ?? "", ctx);
    if (above && above.unit !== "%") box.above = above;
    const below = parseLength(p.get("margin-bottom") ?? "", ctx);
    if (below && below.unit !== "%") box.below = below;
    if (p.get("break-inside") === "avoid" || p.get("break-inside") === "avoid-page") box.breakable = false;
    if (p.get("margin-left") === "auto") box.align = p.get("margin-right") === "auto" ? "center" : "right";

    if (Object.keys(box).length === 0) return content;
    // CSS blocks stretch to the container; make that visible when the box is.
    if (!box.width && !box.align && (box.fill || box.stroke) && el.tagName !== "table") box.width = { value: 100, unit: "%" };
    // Tables and images carry their own width; keep them as the box body.
    return [{ kind: "box", style: box, children: content }];
  }

  #list(el: Element, style: ComputedStyle): Block {
    const items: Block[][] = [];
    for (const child of el.childNodes) {
      if (!isElement(child) || child.tagName !== "li") continue;
      const cs = this.style(child, style);
      if (cs.props.get("display") === "none") continue;
      items.push(this.#block(child, cs, style));
    }
    const ordered = el.tagName === "ol";
    const start = Number(attr(el, "start"));
    return { kind: "list", ordered, items, ...(ordered && Number.isInteger(start) && start !== 1 ? { start } : {}) };
  }

  #grid(el: Element, style: ComputedStyle, display: "flex" | "grid"): Block[] {
    const ctx = lengthContext(style);
    const children = el.childNodes.filter(isElement).filter((c) => !SKIP.has(c.tagName));
    const cells: Block[][] = [];
    const childStyles = children.map((c) => this.style(c, style));

    let columns: Size[] | undefined;
    if (display === "flex") {
      const dir = style.props.get("flex-direction") ?? "row";
      if (dir.startsWith("column")) return this.blocks(el, style);
      columns = childStyles.map((cs) => {
        const grow = Number(splitValue(cs.props.get("flex") ?? cs.props.get("flex-grow") ?? "0")[0]);
        if (grow > 0) return { value: grow, unit: "fr" as const };
        const w = parseLength(cs.props.get("width") ?? cs.props.get("flex-basis") ?? "", ctx);
        return w ?? "auto";
      });
    } else {
      columns = parseTrackList(style.props.get("grid-template-columns") ?? "", ctx);
      if (!columns) {
        this.warnings.add(`Unsupported grid-template-columns: ${style.props.get("grid-template-columns") ?? "(none)"}`);
        return this.blocks(el, style);
      }
    }
    children.forEach((c, i) => {
      const cs = childStyles[i]!;
      if (cs.props.get("display") !== "none") cells.push(this.#block(c, cs, style));
    });
    if (display === "flex") columns = columns.slice(0, cells.length);
    const gap = parseLength(splitValue(style.props.get("column-gap") ?? style.props.get("gap") ?? "")[0] ?? "", ctx);
    return [{ kind: "grid", columns: columns.length ? columns : ["auto"], cells, ...(gap ? { gutter: gap } : {}) }];
  }

  // ── Inline formatting context ─────────────────────────────────────────────

  #inlineChildren(run: InlineRun, el: Element, style: ComputedStyle): void {
    for (const child of el.childNodes) {
      if (isText(child)) run.text(child.value, style.props.get("white-space"));
      else if (isElement(child) && !SKIP.has(child.tagName)) {
        const cs = this.style(child, style);
        if (displayOf(child, cs) === "none") continue;
        this.#inlineInto(run, child, cs, style);
      }
    }
  }

  #inlineInto(run: InlineRun, el: Element, style: ComputedStyle, parent: ComputedStyle): void {
    const tag = el.tagName;
    if (tag === "br") return run.push({ kind: "linebreak" }, true);
    if (tag === "wbr") return;
    if (tag === "img") {
      const img = this.#image(el, style);
      if (img) run.push(img, false);
      return;
    }
    if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") {
      const value = textContent(el).replace(/\s+/g, " ");
      if (value) run.push({ kind: "code", value }, false);
      return;
    }
    if (displayOf(el, style) !== "inline") {
      // A block nested in inline content: approximate with line breaks.
      this.warnings.add(`Block <${tag}> inside inline content was flattened`);
      run.push({ kind: "linebreak" }, true);
      this.#inlineChildren(run, el, style);
      run.push({ kind: "linebreak" }, true);
      return;
    }

    let children = run.nested(() => this.#inlineChildren(run, el, style));
    const wrap = (node: Inline) => (children = [node]);

    switch (tag) {
      case "strong": case "b": wrap({ kind: "strong", children }); break;
      case "em": case "i": case "cite": case "var": case "dfn": wrap({ kind: "emph", children }); break;
      case "u": case "ins": wrap({ kind: "underline", children }); break;
      case "s": case "del": case "strike": wrap({ kind: "strike", children }); break;
      case "sup": wrap({ kind: "super", children }); break;
      case "sub": wrap({ kind: "sub", children }); break;
      case "q": children = [{ kind: "text", value: "“" }, ...children, { kind: "text", value: "”" }]; break;
      case "a": {
        const href = attr(el, "href");
        if (href && !/^\s*javascript:/i.test(href)) wrap({ kind: "link", href, children });
        break;
      }
    }

    const deco = style.props.get("text-decoration") ?? style.props.get("text-decoration-line");
    if (deco?.includes("underline") && tag !== "u" && tag !== "ins") wrap({ kind: "underline", children });
    if (deco?.includes("line-through") && !["s", "del", "strike"].includes(tag)) wrap({ kind: "strike", children });

    const diff = this.#textDiff(style, parent);
    if (diff) wrap({ kind: "styled", style: diff, children });
    run.splice(children);
  }

  #image(el: Element, style: ComputedStyle): Extract<Inline, { kind: "image" }> | undefined {
    const src = attr(el, "src");
    if (!src) return undefined;
    const ctx = lengthContext(style);
    const dim = (name: "width" | "height"): Size | undefined => {
      const css = style.props.get(name);
      if (css && css !== "auto") return parseLength(css, ctx);
      const a = attr(el, name);
      return a ? parseLength(/^\d+(\.\d+)?$/.test(a) ? `${a}px` : a, ctx) : undefined;
    };
    const width = dim("width");
    const height = dim("height");
    const alt = attr(el, "alt");
    return { kind: "image", src, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(alt ? { alt } : {}) };
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  #table(el: Element, style: ComputedStyle): Block {
    const sections: Record<"header" | "body" | "footer", Element[]> = { header: [], body: [], footer: [] };
    let colEls: Element[] = [];
    for (const child of el.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === "thead") sections.header.push(...rowsOf(child));
      else if (child.tagName === "tbody") sections.body.push(...rowsOf(child));
      else if (child.tagName === "tfoot") sections.footer.push(...rowsOf(child));
      else if (child.tagName === "tr") sections.body.push(child);
      else if (child.tagName === "colgroup") colEls.push(...child.childNodes.filter(isElement).filter((c) => c.tagName === "col"));
      else if (child.tagName === "col") colEls.push(child);
      else if (child.tagName === "caption") this.warnings.add("<caption> is not supported yet and was dropped");
    }
    // Without <thead>, a leading row of only <th> cells acts as the header.
    const first = sections.body[0];
    if (sections.header.length === 0 && first && cellsOf(first).every((c) => c.tagName === "th") && cellsOf(first).length > 0) {
      sections.header.push(sections.body.shift()!);
    }

    const ctx = lengthContext(style);
    let firstCell: { el: Element; style: ComputedStyle } | undefined;
    const convertSection = (rows: Element[]): TableRow[] => {
      const grid = new OccupancyGrid();
      const out: TableRow[] = rows.map((tr, r) => {
        const trStyle = this.style(tr, style);
        const cells: TableCell[] = [];
        for (const td of cellsOf(tr)) {
          const cs = this.style(td, trStyle);
          firstCell ??= { el: td, style: cs };
          const colspan = clampSpan(attr(td, "colspan"), 1000);
          let rowspan = clampSpan(attr(td, "rowspan"), 65534);
          if (attr(td, "rowspan") === "0" || rowspan > rows.length - r) rowspan = rows.length - r;
          grid.place(r, colspan, rowspan);
          cells.push(this.#cell(td, cs, trStyle, colspan, rowspan));
        }
        return { cells };
      });
      return grid.pad(out);
    };
    const header = convertSection(sections.header);
    const body = convertSection(sections.body);
    const footer = convertSection(sections.footer);

    const columnCount = Math.max(1, ...[header, body, footer].flatMap((rows) => rows.map(rowWidth)));
    // Pad rows now that the table-wide column count is known.
    for (const rows of [header, body, footer]) padRows(rows, columnCount);

    const columns: Size[] = Array.from({ length: columnCount }, () => "auto");
    const widthSource = colEls.length > 0 ? colEls : cellsOf(sections.header[0] ?? sections.body[0] ?? el).filter((c) => clampSpan(attr(c, "colspan"), 1000) === 1);
    widthSource.slice(0, columnCount).forEach((c, i) => {
      const w = this.style(c, style).props.get("width") ?? attr(c, "width");
      const l = w ? parseLength(/^\d+(\.\d+)?$/.test(w) ? `${w}px` : w, ctx) : undefined;
      if (l) columns[i] = l;
    });
    const tableWidth = style.props.get("width") ?? attr(el, "width");
    if (tableWidth && /^100(\.0+)?%$/.test(tableWidth.trim())) {
      for (let i = 0; i < columns.length; i++) if (columns[i] === "auto") columns[i] = { value: 1, unit: "fr" };
    }

    const block: Extract<Block, { kind: "table" }> = { kind: "table", columns, body };
    if (header.length) block.header = header;
    if (footer.length) block.footer = footer;

    const border = Number(attr(el, "border"));
    const cellStroke = firstCell && firstStroke(firstCell.style, lengthContext(firstCell.style));
    block.stroke = cellStroke ?? firstStroke(style, ctx) ?? (border > 0 ? { width: { value: 0.75, unit: "pt" }, color: "#000000" } : null);

    const pad = firstCell && parseLength(firstCell.style.props.get("padding-top") ?? "", lengthContext(firstCell.style));
    const cellpadding = attr(el, "cellpadding");
    block.inset = pad ?? (cellpadding ? parseLength(`${cellpadding}px`, ctx) : undefined) ?? { value: 0.75, unit: "pt" };
    return block;
  }

  #cell(td: Element, style: ComputedStyle, rowStyle: ComputedStyle, colspan: number, rowspan: number): TableCell {
    let children = this.blocks(td, style);
    const diff = this.#textDiff(style, rowStyle);
    const isTh = td.tagName === "th";
    const cellText: TextStyle = { ...diff };
    if (isTh && !style.props.has("font-weight")) cellText.weight = "bold";
    if (Object.keys(cellText).length) children = [{ kind: "styled-block", style: cellText, children }];

    const cell: TableCell = { children };
    if (colspan > 1) cell.colspan = colspan;
    if (rowspan > 1) cell.rowspan = rowspan;
    const align = hAlign(style.props.get("text-align")) ?? hAlign(attr(td, "align")) ?? (isTh ? "center" : undefined);
    if (align && align !== "start" && align !== "left") cell.align = align;
    const fill = parseColor(style.props.get("background-color") ?? rowStyle.props.get("background-color") ?? attr(td, "bgcolor") ?? "");
    if (fill && fill !== "#00000000") cell.fill = fill;
    // Children paragraphs already carry alignment; drop it to avoid doubling.
    for (const b of children) if (b.kind === "paragraph") delete b.align;
    return cell;
  }

  // ── Text style ────────────────────────────────────────────────────────────

  /** Text properties of `s` that differ from `parent`, or undefined. */
  #textDiff(s: ComputedStyle, parent: ComputedStyle | undefined): TextStyle | undefined {
    const out: TextStyle = {};
    const changed = (p: string) => s.props.get(p) !== parent?.props.get(p);

    if (changed("color")) {
      const c = parseColor(s.props.get("color") ?? "");
      if (c) out.fill = c;
    }
    if (changed("font-family")) {
      const f = this.fontFamily(s.props.get("font-family") ?? "");
      if (f.length) out.font = f;
    }
    if (!parent || Math.abs(s.fontSize - parent.fontSize) > 1e-6) out.size = { value: round(s.fontSize), unit: "pt" };
    if (changed("font-weight")) {
      const w = s.props.get("font-weight");
      if (w === "bold" || w === "bolder") out.weight = "bold";
      else if (w === "normal" || w === "lighter") out.weight = "regular";
      else if (w && /^\d+$/.test(w)) out.weight = Number(w);
    }
    if (changed("font-style")) {
      const st = s.props.get("font-style");
      if (st === "italic" || st === "oblique") out.style = "italic";
      else if (st === "normal") out.style = "normal";
    }
    if (changed("letter-spacing")) {
      const l = parseLength(s.props.get("letter-spacing") ?? "", lengthContext(s));
      if (l) out.tracking = l;
    }
    return Object.keys(out).length ? out : undefined;
  }

  fontFamily(value: string): string[] {
    const out: string[] = [];
    for (const raw of value.split(",")) {
      const name = raw.trim().replace(/^["']|["']$/g, "");
      if (!name) continue;
      const generic = this.#generics[name.toLowerCase() as keyof typeof DEFAULT_GENERICS];
      if (generic) out.push(...generic);
      else if (!/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont)$/i.test(name)) out.push(name);
    }
    return [...new Set(out)];
  }
}

// ── Inline run with CSS whitespace collapsing ────────────────────────────────

class InlineRun {
  #nodes: Inline[] = [];
  /** True when the previous emitted character was collapsible whitespace (or line start). */
  #lastSpace = true;

  text(value: string, whiteSpace: string | undefined): void {
    if (whiteSpace === "pre" || whiteSpace === "pre-wrap" || whiteSpace === "break-spaces") {
      value.split("\n").forEach((line, i) => {
        if (i > 0) this.push({ kind: "linebreak" }, true);
        if (line) this.push({ kind: "text", value: line }, false);
      });
      return;
    }
    if (whiteSpace === "pre-line") {
      value.split("\n").forEach((line, i) => {
        if (i > 0) this.push({ kind: "linebreak" }, true);
        this.text(line, undefined);
      });
      return;
    }
    let collapsed = value.replace(/[ \t\n\r\f]+/g, " ");
    if (this.#lastSpace) collapsed = collapsed.replace(/^ /, "");
    if (!collapsed) return;
    this.#lastSpace = collapsed.endsWith(" ");
    const last = this.#nodes.at(-1);
    if (last?.kind === "text") last.value += collapsed;
    else this.#nodes.push({ kind: "text", value: collapsed });
  }

  push(node: Inline, endsWithSpace: boolean): void {
    if (node.kind === "linebreak") trimTrailing(this.#nodes);
    this.#nodes.push(node);
    this.#lastSpace = endsWithSpace;
  }

  /** Collects the nodes produced by `fill` separately, sharing whitespace state. */
  nested(fill: () => void): Inline[] {
    const outer = this.#nodes;
    this.#nodes = [];
    fill();
    const inner = this.#nodes;
    this.#nodes = outer;
    return inner;
  }

  splice(nodes: Inline[]): void {
    this.#nodes.push(...nodes);
  }

  finish(): Inline[] {
    trimTrailing(this.#nodes);
    return prune(this.#nodes);
  }
}

function trimTrailing(nodes: Inline[]): void {
  for (let last = nodes.at(-1); last; last = nodes.at(-1)) {
    if (last.kind === "text") {
      last.value = last.value.replace(/ +$/, "");
      if (last.value) return;
      nodes.pop();
    } else if ("children" in last) {
      trimTrailing(last.children);
      if (last.children.length || last.kind === "link") return;
      nodes.pop();
    } else return;
  }
}

/** Drops empty wrappers and empty text, and merges adjacent text runs. */
function prune(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (n.kind === "text") {
      if (!n.value) continue;
      const last = out.at(-1);
      if (last?.kind === "text") last.value += n.value;
      else out.push(n);
    } else if ("children" in n) {
      n.children = prune(n.children);
      if (n.children.length || n.kind === "link") out.push(n);
    } else out.push(n);
  }
  return out;
}

// ── Tables: occupancy grid for rowspan/colspan ─────────────────────────────

class OccupancyGrid {
  readonly #occupied: boolean[][] = [];

  /** Places a cell in the first free column of `row`. */
  place(row: number, colspan: number, rowspan: number): void {
    const line = (this.#occupied[row] ??= []);
    let col = 0;
    while (line[col]) col++;
    for (let r = row; r < row + rowspan; r++) {
      const target = (this.#occupied[r] ??= []);
      for (let c = col; c < col + colspan; c++) target[c] = true;
    }
  }

  /** Records each row's extent and occupied slots so short rows can be padded. */
  pad(rows: TableRow[]): TableRow[] {
    rows.forEach((row, r) => {
      const line = this.#occupied[r] ?? [];
      rowStats.set(row, { width: line.length, used: line.filter(Boolean).length });
    });
    return rows;
  }
}

const rowStats = new WeakMap<TableRow, { width: number; used: number }>();

function rowWidth(row: TableRow): number {
  return rowStats.get(row)?.width ?? row.cells.length;
}

function padRows(rows: TableRow[], columns: number): void {
  for (const row of rows) {
    // Typst auto-places cells: a short row must be filled, or the next row's cells would flow into it.
    const missing = columns - (rowStats.get(row)?.used ?? row.cells.length);
    for (let i = 0; i < missing; i++) row.cells.push({ children: [] });
  }
}

function rowsOf(section: Element): Element[] {
  return section.childNodes.filter((n): n is Element => isElement(n) && n.tagName === "tr");
}

function cellsOf(tr: Element): Element[] {
  return tr.childNodes.filter((n): n is Element => isElement(n) && (n.tagName === "td" || n.tagName === "th"));
}

function clampSpan(value: string | undefined, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : 1;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function displayOf(el: Element, s: ComputedStyle): "none" | "inline" | "block" | "flex" | "grid" {
  const d = s.props.get("display");
  if (d === "none") return "none";
  if (d === "inline" || d === "inline-block" || d === "inline-flex") return "inline";
  if (d === "flex" || d === "grid") return d;
  if (d) return "block";
  return INLINE.has(el.tagName) ? "inline" : "block";
}

function hAlign(v: string | undefined): HAlign | undefined {
  switch (v?.toLowerCase()) {
    case "left": return "left";
    case "right": return "right";
    case "center": case "middle": return "center";
    case "start": return "start";
    case "end": return "end";
    default: return undefined;
  }
}

function lengthContext(s: ComputedStyle): LengthContext {
  return { fontSize: s.fontSize, rootFontSize: s.rootFontSize };
}

function positive(l: Length | undefined): Length | undefined {
  return l && l.value > 0 ? l : undefined;
}

function sides<T>(get: (side: "top" | "right" | "bottom" | "left") => T | undefined): Sides<T> | undefined {
  const out: Sides<T> = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const v = get(side);
    if (v !== undefined) out[side] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

const BORDER_WIDTHS: Record<string, number> = { thin: 0.75, medium: 2.25, thick: 3.75 };

function borderStroke(p: ReadonlyMap<string, string>, side: string, ctx: LengthContext): Stroke | undefined {
  const style = p.get(`border-${side}-style`);
  if (!style || style === "none" || style === "hidden") return undefined;
  const w = p.get(`border-${side}-width`) ?? "medium";
  const width = w in BORDER_WIDTHS ? { value: BORDER_WIDTHS[w]!, unit: "pt" as const } : parseLength(w, ctx);
  if (!width || width.value <= 0) return undefined;
  const c = p.get(`border-${side}-color`);
  const color = (c && c !== "currentcolor" ? parseColor(c) : undefined) ?? parseColor(p.get("color") ?? "") ?? ("#000000" as Color);
  return { width, color };
}

function firstStroke(s: ComputedStyle, ctx: LengthContext): Stroke | undefined {
  for (const side of ["top", "right", "bottom", "left"]) {
    const st = borderStroke(s.props, side, ctx);
    if (st) return st;
  }
  return undefined;
}

function parseTrackList(value: string, ctx: LengthContext): Size[] | undefined {
  const tracks: Size[] = [];
  const expanded = value.replace(/repeat\(\s*(\d+)\s*,\s*([^)]+)\)/g, (_, n: string, t: string) =>
    Array.from({ length: Number(n) }, () => t.trim()).join(" "),
  );
  for (const token of splitValue(expanded)) {
    if (token === "auto") tracks.push("auto");
    else if (/^\d*\.?\d+fr$/.test(token)) tracks.push({ value: Number(token.slice(0, -2)), unit: "fr" });
    else {
      const l = parseLength(token, ctx);
      if (!l) return undefined;
      tracks.push(l);
    }
  }
  return tracks.length ? tracks : undefined;
}

function textContent(n: Node): string {
  if (isText(n)) return n.value;
  return "childNodes" in n ? n.childNodes.map(textContent).join("") : "";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

