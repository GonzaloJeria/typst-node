import { Cascade, type ComputedStyle, type PseudoElement } from "./css/cascade.js";
import { serializeOuter } from "parse5";
import { checkDeclaration } from "./css/support.js";
import { overColor, parseColor, parseGradient, parseInsetFill, parseLength, parseShadows, parseTransform, parseUrl, splitValue, toPt, withAlpha, type LengthContext } from "./css/values.js";
import { attr, isElement, isText, type Element, type Node, type TextNode } from "./dom.js";
import type {
  BackgroundImage, Block, BoxStyle, Color, HAlign, Corners, ImageFit, Inline, InlineBoxStyle, Length, LineHeight, Margins, Radius, Paint, Sides, Size, Stroke, TableCell, TableRow, TextStyle, TransformOp, VAlign,
} from "./ir.js";

export interface ConvertOptions {
  /** Font stacks for CSS generic families. Unmapped generics are dropped. */
  genericFamilies?: Partial<Record<"serif" | "sans-serif" | "monospace" | "cursive" | "fantasy" | "system-ui", string[]>>;
  /**
   * Font family names to use instead of CSS ones (case-insensitive keys),
   * e.g. when an `@font-face` name differs from the name inside the font file.
   */
  fontAliases?: Record<string, string>;
}

const DEFAULT_GENERICS: NonNullable<ConvertOptions["genericFamilies"]> = {
  // Fonts embedded in the official Typst binary.
  serif: ["Libertinus Serif"],
  monospace: ["DejaVu Sans Mono"],
  // Bundled with @gjeria/typst-html-pdf (see `bundledFontsDir`).
  "sans-serif": ["Inter"],
  "system-ui": ["Inter"],
};

/** Not document content: skipped silently. */
const SKIP = new Set(["head", "script", "style", "template", "noscript", "title", "meta", "link"]);
/** Content a PDF cannot show: dropped with a warning. */
const DROPPED = new Set(["iframe", "object", "embed", "video", "audio", "canvas", "input", "button", "select", "textarea", "math"]);

const INLINE = new Set(["svg", "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "img", "ins", "kbd", "label", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "tt", "u", "var", "wbr", "font", "big"]);

const HEADINGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

export class Converter {
  readonly warnings = new Set<string>();
  readonly #generics: NonNullable<ConvertOptions["genericFamilies"]>;
  readonly #styles = new WeakMap<Element, ComputedStyle>();
  readonly #aliases = new Map<string, string>();
  /** `position: fixed` content, repeated on every page. */
  readonly foreground: Block[] = [];
  /** `position: running(name)` elements, for `@page` margin boxes. */
  readonly running = new Map<string, Block[]>();

  constructor(readonly cascade: Cascade, options: ConvertOptions = {}) {
    this.#generics = { ...DEFAULT_GENERICS, ...options.genericFamilies };
    for (const [k, v] of Object.entries(options.fontAliases ?? {})) this.#aliases.set(k.toLowerCase(), v);
    for (const w of cascade.warnings) this.warnings.add(w);
  }

  style(el: Element, parent: ComputedStyle | undefined): ComputedStyle {
    let s = this.#styles.get(el);
    if (!s) {
      s = this.cascade.compute(el, parent, attr(el, "style"));
      this.#styles.set(el, s);
      this.#validate(s, el.tagName);
    }
    return s;
  }

  /** Warns about every declaration on the element that cannot be rendered as written. */
  #validate(s: ComputedStyle, where: string): void {
    for (const w of this.cascade.warnings.splice(0)) this.warnings.add(w);
    for (const [prop, value] of s.own) {
      // `vertical-align` only affects inline boxes (Tailwind's preflight sets it on block images).
      if (prop === "vertical-align" && s.props.get("display") === "block") continue;
      const warning = checkDeclaration(prop, value, where);
      if (warning) this.warnings.add(warning);
    }
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

    this.#pseudo(run, container, style, "before");
    for (const child of container.childNodes) {
      if (isText(child)) {
        run.text(child.value, style.props);
        continue;
      }
      if (!isElement(child) || this.#skip(child)) continue;
      const cs = this.style(child, style);
      const display = displayOf(child, cs);
      if (display === "none") continue;
      if (display === "inline") {
        this.#inlineInto(run, child, cs, style);
        continue;
      }
      flush();
      const name = cs.own.get("page")?.toLowerCase();
      if (!name || name === "auto" || name === this.#pageName) {
        out.push(...this.#block(child, cs, style));
        continue;
      }
      // A different named page starts a new page run; adjacent siblings share it.
      const outer = this.#pageName;
      this.#pageName = name;
      const content = this.#block(child, cs, style);
      this.#pageName = outer;
      const last = out.at(-1);
      if (last?.kind === "page-run" && last.name === name) last.children.push(...content);
      else if (content.length) out.push({ kind: "page-run", name, children: content });
    }
    this.#pseudo(run, container, style, "after");
    flush();
    return out;
  }

  /** CSS page name of the run being converted (`page` property). */
  #pageName: string | undefined;

  /** The body's `line-height`, emitted once for the whole document. */
  baseLineHeight: string | undefined;

  #paragraph(children: Inline[], style: ComputedStyle): Block {
    const p: Extract<Block, { kind: "paragraph" }> = { kind: "paragraph", children };
    const lh = style.props.get("line-height");
    if (lh !== this.baseLineHeight) {
      const height = lineHeightOf(lh, style);
      if (height !== undefined) p.lineHeight = height;
    }
    const ta = style.props.get("text-align");
    if (ta === "justify") p.justify = true;
    else {
      const a = hAlign(ta);
      if (a && a !== "start" && a !== "left") p.align = a;
    }
    return p;
  }

  /** Set while converting a flex item that shrinks to its content (an `auto` track). */
  #shrinkItem = false;
  /** Set while converting a flex item whose width became its grid column. */
  #trackItem = false;
  /** Padding (in pt) of the nearest positioned ancestor: absolute offsets start at its padding box. */
  #containerPadding: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 };

  #block(el: Element, style: ComputedStyle, parent: ComputedStyle): Block[] {
    const tag = el.tagName;
    const shrink = this.#shrinkItem;
    const track = this.#trackItem;
    this.#shrinkItem = false;
    this.#trackItem = false;
    let content: Block[];
    const display = style.props.get("display");
    const position = style.own.get("position") ?? "static";
    const positioned = position === "relative" || position === "absolute" || position === "fixed";
    const outerPadding = this.#containerPadding;
    if (positioned) {
      const ctx = lengthContext(style);
      const pt = (side: string) => {
        const l = parseLength(style.props.get(`padding-${side}`) ?? "", ctx);
        return l && l.unit === "pt" ? l.value : 0;
      };
      this.#containerPadding = { top: pt("top"), right: pt("right"), bottom: pt("bottom"), left: pt("left") };
    }
    try {

    if (tag in HEADINGS) {
      const run = new InlineRun();
      this.#inlineChildren(run, el, style);
      const heading: Extract<Block, { kind: "heading" }> = { kind: "heading", level: HEADINGS[tag]!, children: run.finish() };
      const a = hAlign(style.props.get("text-align"));
      if (a && a !== "start" && a !== "left") heading.align = a;
      const textStyle = this.#textDiff(style, parent);
      if (textStyle) heading.style = textStyle;
      const lh = style.props.get("line-height");
      if (lh !== this.baseLineHeight) {
        const height = lineHeightOf(lh, style);
        if (height !== undefined) heading.lineHeight = height;
      }
      content = [heading];
    } else if ((tag === "ul" || tag === "ol") && display !== "flex" && display !== "grid") {
      content = [this.#list(el, style)];
    } else if (tag === "table") {
      content = [this.#table(el, style)];
    } else if (tag === "pre") {
      const code = el.childNodes.find((n): n is Element => isElement(n) && n.tagName === "code");
      const lang = /(?:^|\s)(?:language|lang)-(\S+)/.exec(code ? attr(code, "class") ?? "" : "")?.[1];
      content = [{ kind: "raw-block", value: textContent(el).replace(/\n$/, ""), ...(lang ? { lang } : {}) }];
    } else if (tag === "hr") {
      content = [{ kind: "rule" }];
    } else if (tag === "img" || tag === "svg") {
      const img = this.#image(el, style);
      content = img ? [{ ...img }] : [];
    } else if (display === "flex" || display === "grid") {
      content = this.#grid(el, style, display);
    } else {
      content = this.blocks(el, style);
      const count = Number(style.own.get("column-count"));
      if (count > 1) {
        const gap = style.props.get("column-gap");
        const gutter = gap && gap !== "normal" ? parseLength(gap, lengthContext(style)) : undefined;
        // CSS `normal` gap is 1em.
        content = [{ kind: "columns", count, gutter: gutter ?? { value: 1, unit: "em" }, children: content }];
      }
    }

    } finally {
      this.#containerPadding = outerPadding;
    }
    content = this.#applyBox(el, style, content, positioned, shrink, track);

    // Headings carry their text style themselves.
    const textDiff = tag in HEADINGS ? undefined : this.#textDiff(style, parent);
    if (textDiff) content = [{ kind: "styled-block", style: textDiff, children: content }];

    const ops = parseTransform(style.own.get("transform") ?? "none", lengthContext(style)) ?? [];
    const offset = position === "relative" ? this.#relativeOffset(style) : undefined;
    if (offset) ops.unshift(offset);
    if (ops.length) content = [{ kind: "transform", ops, children: content }];

    const margins = this.#horizontalMargins(style);
    if (margins && !/^(absolute|fixed)$/.test(position)) {
      // Vertical margins move out of the pad, which would otherwise hide them.
      const vertical = hoistMargins(content);
      content = [{ kind: "pad", ...margins, children: content, ...(vertical ? { margins: vertical } : {}) }];
    }

    const running = /^running\(\s*([-\w]+)\s*\)$/.exec(position);
    if (running) {
      if (!this.running.has(running[1]!)) this.running.set(running[1]!, content);
      return [];
    }
    if (position === "absolute" || position === "fixed") {
      const placed = this.#place(style, content, position === "fixed");
      if (position === "absolute") return [placed];
      this.foreground.push(placed);
      return [];
    }

    const before = style.props.get("break-before");
    const after = style.props.get("break-after");
    if (before === "page" || before === "left" || before === "right") content.unshift({ kind: "pagebreak", weak: true });
    if (after === "page" || after === "left" || after === "right") content.push({ kind: "pagebreak", weak: true });
    return content;
  }

  /** Non-auto horizontal margins; `auto` is handled as alignment by the box. */
  #horizontalMargins(s: ComputedStyle): { left?: Length; right?: Length } | undefined {
    const ctx = lengthContext(s);
    const out: { left?: Length; right?: Length } = {};
    for (const side of ["left", "right"] as const) {
      const v = s.own.get(`margin-${side}`);
      const l = v && v !== "auto" ? parseLength(v, ctx) : undefined;
      if (l && l.value !== 0) out[side] = l;
    }
    return out.left || out.right ? out : undefined;
  }

  /** `position: relative` offsets: a visual shift that leaves layout untouched. */
  #relativeOffset(s: ComputedStyle): TransformOp | undefined {
    const ctx = lengthContext(s);
    const get = (side: string) => {
      const l = parseLength(s.own.get(side) ?? "", ctx);
      return l && l.unit !== "%" ? l.value : undefined;
    };
    const unit = (value: number): Length => ({ value, unit: "pt" });
    const [top, bottom, left, right] = [get("top"), get("bottom"), get("left"), get("right")];
    const dx = left ?? (right !== undefined ? -right : 0);
    const dy = top ?? (bottom !== undefined ? -bottom : 0);
    return dx || dy ? { kind: "translate", dx: unit(dx), dy: unit(dy) } : undefined;
  }

  /** Anchors out-of-flow content to the corner implied by top/right/bottom/left. */
  #place(s: ComputedStyle, children: Block[], pageArea = false): Block {
    const ctx = lengthContext(s);
    const len = (side: string) => {
      const l = parseLength(s.own.get(side) ?? "", ctx);
      return l && l.unit !== "%" ? l : undefined;
    };
    const zero: Length = { value: 0, unit: "pt" };
    // Offsets are from the containing block's padding box; Typst places from its content box.
    const pad = pageArea ? undefined : this.#containerPadding;
    const shift = (l: Length | undefined, side: "top" | "right" | "bottom" | "left") =>
      l && pad?.[side] && l.unit === "pt" ? { value: Math.round((l.value - pad[side]) * 1e4) / 1e4, unit: "pt" as const } : l;
    const [top, right, bottom, left] = [shift(len("top"), "top"), shift(len("right"), "right"), shift(len("bottom"), "bottom"), shift(len("left"), "left")];
    const x = left === undefined && right !== undefined ? "right" : "left";
    const y = top === undefined && bottom !== undefined ? "bottom" : "top";
    const placed: Extract<Block, { kind: "place" }> = { kind: "place", x, y, dx: (x === "left" ? left : right) ?? zero, dy: (y === "top" ? top : bottom) ?? zero, children };
    const width = s.props.get("width");
    if (left && right && (!width || width === "auto")) placed.span = { left, right };
    if (pageArea) placed.pageArea = true;
    return placed;
  }

  #applyBox(el: Element, s: ComputedStyle, content: Block[], positioned = false, shrink = false, track = false): Block[] {
    const ctx = lengthContext(s);
    const box: BoxStyle = {};
    const p = s.props;

    // A full-width table's width is expressed through its column sizes instead.
    // A flex item's width already sized its grid column.
    const fullTable = el.tagName === "table" && /^100(\.0+)?%$/.test((p.get("width") ?? attr(el, "width") ?? "").trim());
    const width = fullTable || track ? undefined : p.get("width") ?? p.get("max-width") ?? (el.tagName === "table" ? tableAttrWidth(el) : undefined);
    if (width && width !== "auto" && width !== "none") {
      const w = parseLength(width, ctx);
      if (w) box.width = w;
    }
    const inset = sides((side) => positive(parseLength(p.get(`padding-${side}`) ?? "", ctx)));
    if (inset) box.inset = inset;
    for (const [prop, key] of [["height", "height"], ["min-height", "minHeight"]] as const) {
      const v = p.get(prop);
      const l = v && v !== "auto" ? positive(parseLength(v, ctx)) : undefined;
      if (l) box[key] = l;
    }
    if (p.get("box-sizing") === "border-box" && (box.height || box.minHeight || box.width)) box.borderBox = true;
    // CSS widths exclude padding (content-box); Typst's include it.
    if (box.width && !box.borderBox && (inset?.left || inset?.right)) box.contentWidth = true;
    const opacity = opacityOf(s);
    const image = backgroundImage(p, ctx);
    if (image) box.image = image;
    const fill = backgroundOf(p, opacity);
    if (fill) box.fill = fill;
    const stroke = sides((side) => borderStroke(p, side, ctx, opacity));
    if (stroke) box.stroke = stroke;
    const radius = radiusOf(p, ctx);
    if (radius) box.radius = radius;
    // Paper has no scrolling: anything but `visible` clips, as Chrome prints it.
    const clipped = (v: string | undefined) => !!v && v !== "visible";
    if (clipped(p.get("overflow-x")) || clipped(p.get("overflow-y"))) box.clip = true;
    const above = parseLength(p.get("margin-top") ?? "", ctx);
    if (above && above.unit !== "%") box.above = above;
    const below = parseLength(p.get("margin-bottom") ?? "", ctx);
    if (below && below.unit !== "%") box.below = below;
    if (p.get("break-inside") === "avoid" || p.get("break-inside") === "avoid-page") box.breakable = false;
    // Auto margins only move a block narrower than its container.
    const full = box.width && typeof box.width === "object" && box.width.unit === "%" && box.width.value >= 100;
    if (p.get("margin-left") === "auto" && box.width && !full) box.align = p.get("margin-right") === "auto" ? "center" : "right";
    const shadows = parseInsetFill(s.own.get("box-shadow") ?? "") ? undefined : parseShadows(s.own.get("box-shadow") ?? "none", ctx);
    if (shadows?.length) box.shadows = shadows;

    // A positioned element is the containing block of its absolute children,
    // so it needs a block of its own even without visible styles.
    if (Object.keys(box).length === 0) return positioned ? [{ kind: "box", style: box, children: content }] : content;
    // Margins alone ride on the block itself instead of a wrapping box.
    const only = content.length === 1 ? content[0]! : undefined;
    if (!positioned && only && Object.keys(box).every((k) => k === "above" || k === "below") && MARGIN_KINDS.has(only.kind)) {
      (only as { margins?: Margins }).margins = { ...(box.above ? { above: box.above } : {}), ...(box.below ? { below: box.below } : {}) };
      return content;
    }
    // CSS blocks stretch to the container; make that visible when the box is.
    // Absolutely positioned boxes shrink to fit instead,
    // unless `left` and `right` together give them a width.
    const outOfFlow = /^(absolute|fixed)$/.test(s.own.get("position") ?? "") && !(s.own.get("left") && s.own.get("right"));
    if (!box.width && !box.align && !outOfFlow && !shrink && (box.fill || box.stroke || box.shadows || box.image) && el.tagName !== "table") {
      box.width = { value: 100, unit: "%" };
    }
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
    const list: Extract<Block, { kind: "list" }> = { kind: "list", ordered, items };
    if (ordered && Number.isInteger(start) && start !== 1) list.start = start;
    const cssType = style.props.get("list-style-type")?.toLowerCase();
    const typeAttr = attr(el, "type");
    if (ordered) {
      const pattern =
        cssType === "none" ? "" : cssType ? ORDERED_STYLES[cssType] : typeAttr && /^[aAiI1]$/.test(typeAttr) ? `${typeAttr}.` : undefined;
      if (pattern !== undefined && pattern !== "1.") list.numbering = pattern;
    } else if (cssType) {
      const quoted = /^(["'])(.*)\1$/.exec(cssType);
      const marker = quoted ? unescapeCss(quoted[2]!) : cssType === "none" ? "" : UNORDERED_STYLES[cssType];
      if (marker !== undefined) list.marker = marker;
    }
    return list;
  }

  #grid(el: Element, style: ComputedStyle, display: "flex" | "grid"): Block[] {
    // Text directly inside a flex or grid container becomes an anonymous item.
    const all = el.childNodes.flatMap((n): Element[] =>
      isElement(n) ? (this.#skip(n) ? [] : [n]) : isText(n) && n.value.trim() ? [anonymousItem(n, el)] : [],
    );
    const allStyles = all.map((c) => this.style(c, style));
    const visible = all.map((_, i) => i).filter((i) => allStyles[i]!.props.get("display") !== "none");
    // Absolutely positioned children are not flex/grid items: they are placed
    // against the container itself, after its items.
    const outOfFlow = (i: number) => /^(absolute|fixed)$/.test(allStyles[i]!.own.get("position") ?? "");
    const placed = visible.filter(outOfFlow).flatMap((i) => {
      this.#shrinkItem = this.#trackItem = false;
      return this.#block(all[i]!, allStyles[i]!, style);
    });
    const items = visible.filter((i) => !outOfFlow(i));
    const children = items.map((i) => all[i]!);
    const childStyles = items.map((i) => allStyles[i]!);
    return [...this.#items(el, style, display, children, childStyles), ...placed];
  }

  #items(el: Element, style: ComputedStyle, display: "flex" | "grid", children: Element[], childStyles: ComputedStyle[]): Block[] {
    const ctx = lengthContext(style);
    const cells: Block[][] = [];

    let columns: Size[] | undefined;
    if (display === "flex") {
      const dir = style.props.get("flex-direction") ?? "row";
      if (dir.startsWith("column")) return this.#columnFlex(children, childStyles, style, dir.endsWith("reverse"));
      columns = childStyles.map((cs) => {
        const grow = Number(splitValue(cs.props.get("flex") ?? cs.props.get("flex-grow") ?? "0")[0]);
        if (grow > 0) return { value: grow, unit: "fr" as const };
        const w = parseLength(cs.props.get("width") ?? cs.props.get("flex-basis") ?? "", ctx);
        return w ?? "auto";
      });
    } else {
      this.#flexAlignmentUnsupported(style, "display: grid");
      columns = parseTrackList(style.props.get("grid-template-columns") ?? "", ctx);
      if (!columns) {
        this.warnings.add(`Unsupported grid-template-columns: ${style.props.get("grid-template-columns") ?? "(none)"}`);
        return this.blocks(el, style);
      }
    }
    children.forEach((c, i) => {
      // Flex items without flex-grow or a width shrink to their content.
      this.#shrinkItem = display === "flex" && columns![i] === "auto";
      this.#trackItem = display === "flex" && typeof columns![i] === "object" && (columns![i] as Length).unit !== "fr";
      cells.push(this.#block(c, childStyles[i]!, style));
    });
    if (display === "flex") columns = columns.slice(0, cells.length);
    const gaps = splitValue(style.props.get("gap") ?? "");
    const gap = parseLength(style.props.get("column-gap") ?? gaps[1] ?? gaps[0] ?? "", ctx);
    const rowGap = parseLength(style.props.get("row-gap") ?? gaps[0] ?? "", ctx);
    if (display === "flex" && /^wrap/.test(style.props.get("flex-wrap") ?? "") && cells.length > 1) {
      return this.#wrapFlex(columns, cells, style, gap, rowGap);
    }
    const grid: Extract<Block, { kind: "grid" }> = { kind: "grid", columns: columns.length ? columns : ["auto"], cells, ...(gap ? { gutter: gap } : {}) };
    if (display === "flex") this.#alignFlex(grid, style, gap);
    if (display === "grid" && rowGap && gap && JSON.stringify(rowGap) !== JSON.stringify(gap)) {
      grid.columnGutters = Array(Math.max(0, grid.columns.length - 1)).fill(gap);
      grid.gutter = rowGap;
    }
    return [grid];
  }

  /**
   * A flex column: one grid column, `gap` between items, and `align-items`
   * as the cells' horizontal alignment (items then shrink to their content).
   */
  #columnFlex(children: Element[], styles: ComputedStyle[], style: ComputedStyle, reverse: boolean): Block[] {
    const justify = style.own.get("justify-content") ?? "normal";
    const ai = style.props.get("align-items") ?? "";
    const halign: HAlign | undefined = /^(center)$/.test(ai) ? "center" : /^(flex-end|end|self-end|right)$/.test(ai) ? "right" : undefined;
    const cells = children.map((c, i) => {
      this.#shrinkItem = halign !== undefined;
      return this.#block(c, styles[i]!, style);
    });
    if (reverse) cells.reverse();
    const ctx = lengthContext(style);
    const gaps = splitValue(style.props.get("gap") ?? "");
    const rowGap = parseLength(style.props.get("row-gap") ?? gaps[0] ?? "", ctx);
    const grid: Extract<Block, { kind: "grid" }> = { kind: "grid", columns: [{ value: 1, unit: "fr" }], cells, ...(rowGap ? { gutter: rowGap } : {}) };
    if (halign) grid.halign = halign;
    // Free height only exists in a container with a definite (or minimum) height.
    const definite = (p: string) => !!positive(parseLength(style.props.get(p) ?? "", ctx));
    const rows = definite("height") || definite("min-height") ? justifyRows(justify, cells.length) : undefined;
    if (rows) {
      grid.rows = rows.sizes;
      if (!definite("height")) grid.rowsIfFree = true;
      grid.cells = rows.order.map((i) => (i === undefined ? [] : cells[i]!));
    }
    return [grid];
  }

  #alignFlex(grid: Extract<Block, { kind: "grid" }>, style: ComputedStyle, gap: Length | undefined): void {
    const valign = FLEX_ALIGN[style.props.get("align-items") ?? ""];
    if (valign) grid.valign = valign;
    justifyFlex(grid, style.props.get("justify-content") ?? "", gap);
  }

  /**
   * `flex-wrap: wrap`. Items sized in % (a Bootstrap `.row` of `.col-*`) are
   * broken into lines that add up to at most 100%, one grid per line; other
   * items flow like inline blocks, which Typst wraps on its own.
   */
  #wrapFlex(columns: Size[], cells: Block[][], style: ComputedStyle, gap: Length | undefined, rowGap: Length | undefined): Block[] {
    const percent = columns.every((c) => typeof c === "object" && c.unit === "%" && !c.offset);
    if (percent) {
      const lines: number[][] = [];
      let used = Infinity;
      columns.forEach((c, i) => {
        const w = (c as Length).value;
        if (used + w > 100.01) lines.push([]), (used = 0);
        lines.at(-1)!.push(i);
        used += w;
      });
      return lines.map((line, i) => {
        const grid: Extract<Block, { kind: "grid" }> = { kind: "grid", columns: line.map((j) => columns[j]!), cells: line.map((j) => cells[j]!), ...(gap ? { gutter: gap } : {}) };
        this.#alignFlex(grid, style, gap);
        if (rowGap && i < lines.length - 1) grid.margins = { below: rowGap };
        return grid;
      });
    }
    const flow: Extract<Block, { kind: "flow" }> = {
      kind: "flow",
      items: cells.map((children, i) => {
        const c = columns[i];
        return typeof c === "object" && c.unit !== "fr" ? { width: c, children } : { children };
      }),
    };
    if (gap) flow.gap = gap;
    if (rowGap) flow.rowGap = rowGap;
    const justify = style.props.get("justify-content") ?? "";
    const a = /^(?:center)$/.test(justify) ? "center" : /^(?:flex-end|end|right)$/.test(justify) ? "right" : undefined;
    if (a) flow.align = a;
    return [flow];
  }

  /** `justify-content`/`align-items` are only converted for flex rows. */
  #flexAlignmentUnsupported(style: ComputedStyle, context: string): void {
    for (const prop of ["justify-content", "align-items"]) {
      const v = style.own.get(prop);
      if (v && !/^(normal|stretch|flex-start|start)$/.test(v)) this.warnings.add(`Unsupported CSS ignored: ${prop}: ${v} with ${context}`);
    }
  }

  // ── Inline formatting context ─────────────────────────────────────────────

  #inlineChildren(run: InlineRun, el: Element, style: ComputedStyle): void {
    this.#pseudo(run, el, style, "before");
    for (const child of el.childNodes) {
      if (isText(child)) run.text(child.value, style.props);
      else if (isElement(child) && !this.#skip(child)) {
        const cs = this.style(child, style);
        if (displayOf(child, cs) === "none") continue;
        this.#inlineInto(run, child, cs, style);
      }
    }
    this.#pseudo(run, el, style, "after");
  }

  /** Emits `::before` / `::after` generated content as inline text. */
  #pseudo(run: InlineRun, el: Element, style: ComputedStyle, which: PseudoElement): void {
    if (!this.cascade.hasPseudo(el, which)) return;
    const ps = this.cascade.compute(el, style, undefined, which);
    this.#validate(ps, `${el.tagName}::${which}`);
    const content = ps.own.get("content");
    if (!content || ps.props.get("display") === "none") return;
    const parts = parseContent(content, el, (msg) => this.warnings.add(`${msg} (<${el.tagName}::${which}>)`));
    if (!parts.length) return;
    const children = run.nested(() => {
      for (const part of parts) {
        if (typeof part === "string") run.text(part, ps.props);
        else run.push({ kind: "page-counter", which: part.counter }, false);
      }
    });
    run.splice(this.#decorate(children, "", ps, style));
  }

  #inlineInto(run: InlineRun, el: Element, style: ComputedStyle, parent: ComputedStyle): void {
    const tag = el.tagName;
    if (tag === "br") return run.push({ kind: "linebreak" }, true);
    if (tag === "wbr") return;
    if (tag === "img" || tag === "svg") {
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

    run.splice(this.#decorate(children, tag, style, parent));
  }

  /** Applies CSS text decoration, text style changes and inline box painting. */
  #decorate(nodes: Inline[], tag: string, style: ComputedStyle, parent: ComputedStyle): Inline[] {
    let children = nodes;
    const wrap = (node: Inline) => (children = [node]);
    const deco = style.own.get("text-decoration-line");
    if (deco?.includes("underline") && tag !== "u" && tag !== "ins") wrap({ kind: "underline", children });
    if (deco?.includes("line-through") && !["s", "del", "strike"].includes(tag)) wrap({ kind: "strike", children });

    const diff = this.#textDiff(style, parent);
    if (diff) wrap({ kind: "styled", style: diff, children });

    const box = this.#inlineBox(style);
    if (box && children.length) wrap({ kind: "box", style: box, children });

    // Block-level effects are not translated for inline content: say so.
    const where = tag || "::pseudo";
    for (const prop of ["transform", "box-shadow"]) {
      const v = style.own.get(prop);
      if (v && v !== "none") this.warnings.add(`Unsupported CSS ignored on inline element: ${prop}: ${v} (<${where}>)`);
    }
    const offset = style.own.get("position") === "relative" ? this.#relativeOffset(style) : undefined;
    if (offset?.kind === "translate" && children.length) wrap({ kind: "move", dx: offset.dx, dy: offset.dy, children });

    // Inline margins become horizontal space around the element.
    const margins = this.#horizontalMargins(style);
    if (margins && children.length) {
      children = [
        ...(margins.left ? [{ kind: "space" as const, width: margins.left }] : []),
        ...children,
        ...(margins.right ? [{ kind: "space" as const, width: margins.right }] : []),
      ];
    }
    return children;
  }

  /** Background, border and padding of an inline (or inline-block) element. */
  #inlineBox(s: ComputedStyle): InlineBoxStyle | undefined {
    const p = s.own;
    const ctx = lengthContext(s);
    const opacity = opacityOf(s);
    const box: InlineBoxStyle = {};
    const fill = backgroundOf(p, opacity);
    if (fill) box.fill = fill;
    const stroke = sides((side) => borderStroke(s.props, side, ctx, opacity, p));
    if (stroke) box.stroke = stroke;
    const radius = radiusOf(p, ctx);
    if (radius) box.radius = radius;
    const pad = (side: "top" | "right" | "bottom" | "left") => positive(parseLength(p.get(`padding-${side}`) ?? "", ctx));
    const inset = sides((side) => (side === "left" || side === "right" ? pad(side) : undefined));
    if (inset) box.inset = inset;
    const outset = sides((side) => (side === "top" || side === "bottom" ? pad(side) : undefined));
    if (outset) box.outset = outset;
    if (s.props.get("display") === "inline-block") {
      const w = parseLength(p.get("width") ?? "", ctx);
      if (w) box.width = w;
    }
    return Object.keys(box).length ? box : undefined;
  }

  /** Elements left out of the document; content a PDF cannot show is reported. */
  #skip(el: Element): boolean {
    if (SKIP.has(el.tagName)) return true;
    if (!DROPPED.has(el.tagName)) return false;
    this.warnings.add(`<${el.tagName}> cannot be rendered in a PDF and was dropped`);
    return true;
  }

  #image(el: Element, style: ComputedStyle): Extract<Inline, { kind: "image" }> | undefined {
    const src = el.tagName === "svg" ? svgDataUri(el, style.props.get("color")) : attr(el, "src");
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
    // With both sizes, CSS stretches the image (`object-fit: fill`); Typst would crop it.
    const fit: ImageFit | undefined =
      width && height && el.tagName === "svg" ? "contain" // preserveAspectRatio's default ("meet")
      : width && height ? (({ cover: "cover", contain: "contain", "scale-down": "contain", none: "contain" } as const)[style.props.get("object-fit") ?? ""] ?? "stretch") : undefined;
    return { kind: "image", src, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(alt ? { alt } : {}), ...(fit ? { fit } : {}) };
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
    // Without <thead>, leading rows made only of <th> cells act as the header
    // (all of them, so header rowspans stay inside the header section).
    if (sections.header.length === 0) {
      const isHeaderRow = (tr: Element) => cellsOf(tr).length > 0 && cellsOf(tr).every((c) => c.tagName === "th");
      while (sections.body.length > 1 && isHeaderRow(sections.body[0]!)) sections.header.push(sections.body.shift()!);
    }

    const ctx = lengthContext(style);
    let firstCell: { el: Element; style: ComputedStyle } | undefined;
    const borders: { cell: TableCell; sides: Sides<Stroke> | undefined }[] = [];
    const paddings: { cell: TableCell; style: ComputedStyle }[] = [];
    const convertSection = (rows: Element[]): TableRow[] => {
      const grid = new OccupancyGrid();
      const sectionStyles = new Map<Node, ComputedStyle>();
      const out: TableRow[] = rows.map((tr, r) => {
        // Rows inherit from their <thead>/<tbody>/<tfoot>, which may set variables or colors.
        const section = tr.parentNode;
        let parentStyle = style;
        if (section && isElement(section) && section !== el) {
          parentStyle = sectionStyles.get(section) ?? this.style(section, style);
          sectionStyles.set(section, parentStyle);
        }
        const trStyle = this.style(tr, parentStyle);
        const cells: TableCell[] = [];
        for (const td of cellsOf(tr)) {
          const cs = this.style(td, trStyle);
          firstCell ??= { el: td, style: cs };
          const colspan = clampSpan(attr(td, "colspan"), 1000);
          let rowspan = clampSpan(attr(td, "rowspan"), 65534);
          if (attr(td, "rowspan") === "0" || rowspan > rows.length - r) rowspan = rows.length - r;
          grid.place(r, colspan, rowspan);
          const cell = this.#cell(td, cs, trStyle, style, colspan, rowspan);
          // Row borders (`border-b` on a <tr>) are drawn by its cells, as with border-collapse.
          const rowSide = (side: "top" | "bottom") => borderStroke(trStyle.props, side, lengthContext(trStyle));
          borders.push({ cell, sides: sides((side) => borderStroke(cs.props, side, lengthContext(cs)) ?? (side === "top" || side === "bottom" ? rowSide(side) : undefined)) });
          paddings.push({ cell, style: cs });
          cells.push(cell);
        }
        const h = trStyle.props.get("height");
        const height = h && h !== "auto" ? positive(parseLength(h, lengthContext(trStyle))) : undefined;
        return height && height.unit !== "%" ? { cells, height } : { cells };
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
    // A table with a width (its box sets it) spreads the extra space over its auto columns.
    const tableWidth = style.props.get("width") ?? attr(el, "width");
    if (tableWidth && tableWidth !== "auto") {
      for (let i = 0; i < columns.length; i++) if (columns[i] === "auto") columns[i] = { value: 1, unit: "fr" };
    }

    const block: Extract<Block, { kind: "table" }> = { kind: "table", columns, body };
    if (header.length) block.header = header;
    if (footer.length) block.footer = footer;

    // Cell borders: one table-wide stroke when every cell has the same
    // borders, else each cell keeps its own. The table's own border is drawn
    // by its box, around the table only.
    const border = Number(attr(el, "border"));
    const fallback: Stroke | null = border > 0 ? { width: { value: 0.75, unit: "pt" }, color: "#000000" } : null;
    const key = (b: Sides<Stroke> | undefined) => JSON.stringify(b ?? null);
    const uniform = borders.every((b) => key(b.sides) === key(borders[0]?.sides));
    if (uniform) {
      const cellSides = borders[0]?.sides;
      const same = cellSides && (["top", "right", "bottom", "left"] as const).map((k) => JSON.stringify(cellSides[k]));
      block.stroke = (same && same.every((v) => v === same[0]) && cellSides.top ? cellSides.top : cellSides) ?? fallback;
    } else {
      block.stroke = fallback;
      for (const b of borders) if (b.sides) b.cell.stroke = b.sides;
    }

    const cellCtx = firstCell && lengthContext(firstCell.style);
    const pad = firstCell && sides((side) => {
      const l = parseLength(firstCell!.style.props.get(`padding-${side}`) ?? "", cellCtx!);
      return l && l.unit !== "%" ? l : undefined;
    });
    const cellpadding = attr(el, "cellpadding");
    const samePad = pad && (["right", "bottom", "left"] as const).every((k) => JSON.stringify(pad[k]) === JSON.stringify(pad.top));
    block.inset = (samePad ? pad!.top : pad) ?? (cellpadding ? parseLength(`${cellpadding}px`, ctx) : undefined) ?? { value: 0.75, unit: "pt" };
    // Cells padded differently from the first one (e.g. `py-1` headers over `py-0.5` rows) keep their own.
    const zero: Length = { value: 0, unit: "pt" };
    const tableInset = "unit" in block.inset ? { top: block.inset, right: block.inset, bottom: block.inset, left: block.inset } : block.inset;
    const norm = (s: Sides<Length>) => JSON.stringify((["top", "right", "bottom", "left"] as const).map((k) => s[k] ?? zero));
    if (pad) {
      for (const { cell, style: cs } of paddings) {
        const own = sides((side) => {
          const l = parseLength(cs.props.get(`padding-${side}`) ?? "", lengthContext(cs));
          return l && l.unit !== "%" ? l : undefined;
        }) ?? {};
        if (norm(own) !== norm(tableInset)) cell.inset = { top: own.top ?? zero, right: own.right ?? zero, bottom: own.bottom ?? zero, left: own.left ?? zero };
      }
    }
    return block;
  }

  #cell(td: Element, style: ComputedStyle, rowStyle: ComputedStyle, tableStyle: ComputedStyle, colspan: number, rowspan: number): TableCell {
    let children = this.blocks(td, style);
    // Rows and sections emit no text style of their own: diff against the table.
    const diff = this.#textDiff(style, tableStyle);
    const isTh = td.tagName === "th";
    const cellText: TextStyle = { ...diff };
    // <th> is bold unless the author sets font-weight on it.
    if (isTh && !style.own.has("font-weight")) cellText.weight = "bold";
    if (Object.keys(cellText).length) children = [{ kind: "styled-block", style: cellText, children }];

    const cell: TableCell = { children };
    if (colspan > 1) cell.colspan = colspan;
    if (rowspan > 1) cell.rowspan = rowspan;
    // <th> is centered unless the author sets text-align (even to `inherit`).
    const align = hAlign(style.props.get("text-align")) ?? hAlign(attr(td, "align")) ?? (isTh && !style.own.has("text-align") ? "center" : undefined);
    if (align && align !== "start" && align !== "left") cell.align = align;
    const fill =
      backgroundOf(style.props, opacityOf(style)) ??
      backgroundOf(rowStyle.props, opacityOf(rowStyle)) ??
      backgroundOf(new Map([["background-color", attr(td, "bgcolor") ?? ""]]), 1);
    if (fill) cell.fill = fill;
    // Children paragraphs already carry alignment; drop it to avoid doubling.
    for (const b of children) if (b.kind === "paragraph") delete b.align;
    return cell;
  }

  // ── Text style ────────────────────────────────────────────────────────────

  /** Text properties of `s` that differ from `parent`, or undefined. */
  #textDiff(s: ComputedStyle, parent: ComputedStyle | undefined): TextStyle | undefined {
    const out: TextStyle = {};
    const changed = (p: string) => s.props.get(p) !== parent?.props.get(p);

    const opacity = opacityOf(s);
    if (changed("color") || opacity < 1) {
      const c = parseColor(s.props.get("color") ?? "") ?? (opacity < 1 ? ("#000000" as Color) : undefined);
      if (c) out.fill = withAlpha(c, opacity);
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
      else if (this.#aliases.has(name.toLowerCase())) out.push(this.#aliases.get(name.toLowerCase())!);
      else if (!/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont)$/i.test(name)) out.push(name);
    }
    return [...new Set(out)];
  }
}

const FLEX_ALIGN: Record<string, "top" | "horizon" | "bottom"> = {
  "flex-start": "top", start: "top", "self-start": "top",
  center: "horizon",
  "flex-end": "bottom", end: "bottom", "self-end": "bottom",
};

/**
 * CSS `justify-content` for a flex row: free space goes into empty `1fr`
 * spacer columns. Items that grow (`fr` tracks) already take that space,
 * as in CSS. The gap stays between items, never next to an edge spacer.
 */
function justifyFlex(grid: Extract<Block, { kind: "grid" }>, justify: string, gap: Length | undefined): void {
  const n = grid.cells.length;
  if (n === 0 || grid.columns.some((c) => typeof c === "object" && c.unit === "fr")) return;
  // Spacer weights: [before first, between each pair..., after last].
  let weights: number[];
  switch (justify) {
    case "flex-end": case "end": case "right": weights = [1, ...Array(n - 1).fill(0), 0]; break;
    case "center": weights = [1, ...Array(n - 1).fill(0), 1]; break;
    case "space-between": weights = n === 1 ? [0, 0] : [0, ...Array(n - 1).fill(1), 0]; break;
    case "space-around": weights = [0.5, ...Array(n - 1).fill(1), 0.5]; break;
    case "space-evenly": weights = Array(n + 1).fill(1); break;
    default: return;
  }
  if (n === 1 && justify === "space-between") return;
  const zero: Length = { value: 0, unit: "pt" };
  const columns: Size[] = [];
  const cells: Block[][] = [];
  const gutters: Length[] = [];
  const spacer = (w: number) => {
    if (!w) return false;
    if (columns.length) gutters.push(zero);
    columns.push({ value: w, unit: "fr" });
    cells.push([]);
    return true;
  };
  spacer(weights[0]!);
  grid.cells.forEach((cell, i) => {
    // The CSS gap separates consecutive items; spacers sit after it.
    if (columns.length) gutters.push(i > 0 && gap ? gap : zero);
    columns.push(grid.columns[i]!);
    cells.push(cell);
    if (i < n - 1) spacer(weights[i + 1]!);
  });
  spacer(weights[n]!);
  grid.columns = columns;
  grid.cells = cells;
  grid.columnGutters = gutters;
}

// ── Inline run with CSS whitespace collapsing ────────────────────────────────

class InlineRun {
  #nodes: Inline[] = [];
  /** True when the previous emitted character was collapsible whitespace (or line start). */
  #lastSpace = true;

  text(raw: string, props: ReadonlyMap<string, string>): void {
    const whiteSpace = props.get("white-space");
    const value = transformText(raw, props.get("text-transform"));
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
        this.#collapse(line);
      });
      return;
    }
    this.#collapse(value, whiteSpace === "nowrap");
  }

  #collapse(value: string, nowrap = false): void {
    let collapsed = value.replace(/[ \t\n\r\f]+/g, " ");
    if (this.#lastSpace) collapsed = collapsed.replace(/^ /, "");
    if (!collapsed) return;
    this.#lastSpace = collapsed.endsWith(" ");
    // `nowrap`: spaces still collapse but never break the line.
    if (nowrap) collapsed = collapsed.replace(/ /g, "\u00a0");
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

/** An inline `<svg>` as a standalone SVG image, the way `<img>` would load it. */
function svgDataUri(el: Element, color: string | undefined): string {
  let markup = serializeOuter(el);
  if (!/^<svg[^>]*\sxmlns=/.test(markup)) markup = markup.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/xlink:/.test(markup) && !/\sxmlns:xlink=/.test(markup)) markup = markup.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  // `currentColor` resolves against the CSS color around the inline SVG.
  const c = color && parseColor(color);
  if (c) markup = markup.replace(/currentColor/gi, c);
  return `data:image/svg+xml;base64,${Buffer.from(markup, "utf8").toString("base64")}`;
}

/** Takes the vertical margins off a single block, to put them on a wrapper. */
function hoistMargins(content: Block[]): Margins | undefined {
  const only = content.length === 1 ? content[0]! : undefined;
  if (!only) return undefined;
  if (only.kind === "styled-block") return hoistMargins(only.children);
  let out: Margins | undefined;
  if (only.kind === "box" && (only.style.above || only.style.below)) {
    out = { ...(only.style.above ? { above: only.style.above } : {}), ...(only.style.below ? { below: only.style.below } : {}) };
    delete only.style.above;
    delete only.style.below;
  } else if ("margins" in only && only.margins) {
    out = only.margins;
    delete only.margins;
  }
  return out;
}

const MARGIN_KINDS = new Set<Block["kind"]>(["paragraph", "heading", "list", "table", "raw-block", "rule", "grid", "flow"]);

/** Wraps a text node in an element that no selector matches, as CSS's anonymous boxes. */
function anonymousItem(text: TextNode, parent: Element): Element {
  return {
    nodeName: "anonymous-box", tagName: "anonymous-box", attrs: [], namespaceURI: parent.namespaceURI,
    childNodes: [text], parentNode: parent,
  } as unknown as Element;
}

function displayOf(el: Element, s: ComputedStyle): "none" | "inline" | "block" | "flex" | "grid" {
  const d = s.props.get("display");
  if (d === "none") return "none";
  // Out-of-flow and running elements are blockified, as in CSS.
  if (/^(absolute|fixed|running\()/.test(s.own.get("position") ?? "")) return d === "flex" || d === "grid" ? d : "block";
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

/**
 * `justify-content` in a flex column as grid rows: items keep their height and
 * empty fractional rows take the free space. `order` lists, row by row, the item
 * index or `undefined` for a spacer.
 */
function justifyRows(justify: string, count: number): { sizes: Size[]; order: (number | undefined)[] } | undefined {
  const fr = (value: number): Size => ({ value, unit: "fr" });
  const items = Array.from({ length: count }, (_, i) => i);
  const between = (edge: number, inner: number) => {
    const order: (number | undefined)[] = [];
    const sizes: Size[] = [];
    if (edge) order.push(undefined), sizes.push(fr(edge));
    items.forEach((i, k) => {
      if (k && inner) order.push(undefined), sizes.push(fr(inner));
      order.push(i), sizes.push("auto");
    });
    if (edge) order.push(undefined), sizes.push(fr(edge));
    return { sizes, order };
  };
  if (!count) return undefined;
  switch (justify.replace(/^(safe|unsafe)\s+/, "")) {
    case "center": return between(1, 0);
    case "end": case "flex-end": return { sizes: [fr(1), ...items.map((): Size => "auto")], order: [undefined, ...items] };
    case "space-between": return count > 1 ? between(0, 1) : undefined;
    case "space-around": return between(1, 2);
    case "space-evenly": return between(1, 1);
  }
  return undefined;
}

/** The HTML `width` attribute of a table as CSS (`width="600"` is pixels). */
function tableAttrWidth(el: Element): string | undefined {
  const a = attr(el, "width")?.trim();
  return a ? (/^\d+(\.\d+)?$/.test(a) ? `${a}px` : a) : undefined;
}

function lengthContext(s: ComputedStyle): LengthContext {
  return { fontSize: s.fontSize, rootFontSize: s.rootFontSize, ...(s.viewport ? { viewport: s.viewport } : {}) };
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

function borderStroke(
  props: ReadonlyMap<string, string>,
  side: string,
  ctx: LengthContext,
  opacity = 1,
  own: ReadonlyMap<string, string> = props,
): Stroke | undefined {
  const p = own;
  const style = p.get(`border-${side}-style`);
  if (!style || style === "none" || style === "hidden") return undefined;
  const w = p.get(`border-${side}-width`) ?? "medium";
  const width = w in BORDER_WIDTHS ? { value: BORDER_WIDTHS[w]!, unit: "pt" as const } : parseLength(w, ctx);
  if (!width || width.value <= 0) return undefined;
  const c = p.get(`border-${side}-color`);
  const color = (c && c !== "currentcolor" ? parseColor(c) : undefined) ?? parseColor(props.get("color") ?? "") ?? ("#000000" as Color);
  const stroke: Stroke = { width, color: withAlpha(color, opacity) };
  if (style === "dashed" || style === "dotted") stroke.dash = style;
  return stroke;
}

function parseTrackList(value: string, ctx: LengthContext): Size[] | undefined {
  const tracks: Size[] = [];
  const expanded = value.replace(/repeat\(\s*(\d+)\s*,\s*((?:[^()]|\([^()]*\))+)\)/g, (_, n: string, t: string) =>
    Array.from({ length: Number(n) }, () => t.trim()).join(" "),
  );
  for (let token of splitValue(expanded)) {
    // minmax(min, max): the max track size decides the layout once there is room.
    const minmax = /^minmax\(\s*([^,]+),\s*([^)]+)\)$/.exec(token);
    if (minmax) token = /^(?:auto|max-content|min-content)$/.test(minmax[2]!.trim()) ? "auto" : minmax[2]!.trim();
    if (/^(?:auto|max-content|min-content|fit-content\(.*\))$/.test(token)) tracks.push("auto");
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


const ORDERED_STYLES: Record<string, string> = {
  decimal: "1.", "lower-alpha": "a.", "lower-latin": "a.", "upper-alpha": "A.", "upper-latin": "A.",
  "lower-roman": "i.", "upper-roman": "I.",
};
const UNORDERED_STYLES: Record<string, string | undefined> = { disc: undefined, circle: "◦", square: "▪" };

function opacityOf(s: ComputedStyle): number {
  const v = s.own.get("opacity")?.trim();
  if (!v) return 1;
  const n = v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/** Background paint: a gradient wins over the color layer, as it is painted on top. */
export function backgroundImage(p: ReadonlyMap<string, string>, ctx: LengthContext): BackgroundImage | undefined {
  const src = parseUrl(p.get("background-image") ?? "");
  if (!src) return undefined;
  const sizeValue = p.get("background-size") ?? "auto";
  let fit: BackgroundImage["fit"];
  if (sizeValue === "cover" || sizeValue === "contain") fit = sizeValue;
  else {
    const [w, h] = splitValue(sizeValue).map((t) => (t === "auto" ? undefined : parseLength(t, ctx)));
    if (w?.unit === "%" && w.value === 100 && h?.unit === "%" && h.value === 100) fit = "stretch";
    // `auto` (natural size) has no Typst equivalent without the image's pixel size: fit the width.
    else fit = { ...(w ? { width: w } : !h ? { width: { value: 100, unit: "%" } } : {}), ...(h ? { height: h } : {}) };
  }
  const pos = splitValue(p.get("background-position") ?? "left top");
  // A single keyword centers the other axis, as in CSS.
  const x = pos.find((t) => t === "left" || t === "right") ?? (pos.includes("center") || pos.length === 1 ? "center" : "left");
  const y = pos.find((t) => t === "top" || t === "bottom") ?? (pos.includes("center") || pos.length === 1 ? "horizon" : "top");
  return { src, fit, align: { x, y: y as VAlign } };
}

/** Corner radii; one length when all four are equal. */
function radiusOf(p: ReadonlyMap<string, string>, ctx: LengthContext): Radius | undefined {
  const corner = (c: string) => positive(parseLength(splitValue(p.get(`border-${c}-radius`) ?? "")[0] ?? "", ctx));
  const [topLeft, topRight, bottomRight, bottomLeft] = ["top-left", "top-right", "bottom-right", "bottom-left"].map(corner);
  const all = [topLeft, topRight, bottomRight, bottomLeft];
  if (all.every((c) => !c)) return undefined;
  if (all.every((c) => JSON.stringify(c) === JSON.stringify(topLeft))) return topLeft;
  const out: Corners = {};
  if (topLeft) out.topLeft = topLeft;
  if (topRight) out.topRight = topRight;
  if (bottomRight) out.bottomRight = bottomRight;
  if (bottomLeft) out.bottomLeft = bottomLeft;
  return out;
}

function backgroundOf(p: ReadonlyMap<string, string>, opacity: number): Paint | undefined {
  const gradient = parseGradient(p.get("background-image") ?? "");
  if (gradient) {
    return { ...gradient, stops: gradient.stops.map((st) => ({ ...st, color: withAlpha(st.color, opacity) })) };
  }
  let color = parseColor(p.get("background-color") ?? "");
  const overlay = parseInsetFill(p.get("box-shadow") ?? "");
  if (overlay) color = overColor(color ?? "#00000000", overlay);
  if (!color || color === "#00000000") return undefined;
  return withAlpha(color, opacity);
}

function transformText(value: string, transform: string | undefined): string {
  switch (transform) {
    case "uppercase": return value.toUpperCase();
    case "lowercase": return value.toLowerCase();
    case "capitalize": return value.replace(/(^|[\s\-(“"'])(\p{L})/gu, (_, pre: string, ch: string) => pre + ch.toUpperCase());
    default: return value;
  }
}

/** Evaluates a CSS `content` value: strings (with escapes), attr(), quotes. */
function parseContent(value: string, el: Element, warn: (message: string) => void): ContentPart[] {
  const v = value.trim();
  if (v === "none" || v === "normal") return [];
  const out: ContentPart[] = [];
  const text = (t: string) => {
    if (!t) return;
    if (typeof out.at(-1) === "string") out[out.length - 1] += t;
    else out.push(t);
  };
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([-\w]+)\s*\)|counter\(\s*(page|pages)\s*\)|(open-quote|close-quote|no-open-quote|no-close-quote)|(\S+\([^)]*\)|\S+)/g;
  for (const m of v.matchAll(re)) {
    if (m[1] !== undefined || m[2] !== undefined) text(unescapeCss(m[1] ?? m[2]!));
    else if (m[3]) text(attr(el, m[3]) ?? "");
    else if (m[4]) out.push({ counter: m[4] as "page" | "pages" });
    else if (m[5] === "open-quote") text("“");
    else if (m[5] === "close-quote") text("”");
    else if (m[6]) warn(`Unsupported content value ignored: ${m[6]}`);
  }
  return out;
}

/** Generated content: text, or a page counter (only meaningful when rendered in pages). */
type ContentPart = string | { counter: "page" | "pages" };

/** Resolves CSS string escapes such as `\2713 ` and `\"`. */
function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : ch!,
  );
}

/** A CSS `line-height` as a multiple of the element's font size. */
export function lineHeightOf(value: string | undefined, s: ComputedStyle): LineHeight | undefined {
  const v = value?.trim();
  if (!v || v === "normal") return "normal";
  if (/^\d*\.?\d+$/.test(v)) return round(Number(v));
  const l = parseLength(v, lengthContext(s));
  if (!l) return undefined;
  if (l.unit === "%") return round(l.value / 100);
  if (l.unit === "em") return round(l.value);
  const pt = toPt(l);
  return pt === undefined || s.fontSize <= 0 ? undefined : round(pt / s.fontSize);
}
