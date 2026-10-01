/**
 * Layout IR: the contract between the HTML/CSS front-end (DOM + cascade) and
 * the Typst emitter. Every value here is already resolved — no CSS units that
 * need context (em, %, of-font-size), no inheritance, no selectors.
 */

export type LengthUnit = "pt" | "mm" | "cm" | "in" | "em" | "%" | "fr";
export interface Length {
  value: number;
  unit: LengthUnit;
}
export type Size = Length | "auto";

/** `#rrggbb` or `#rrggbbaa`. */
export type Color = `#${string}`;

export interface GradientStop {
  color: Color;
  /** Position along the gradient, 0–100 (%). Omitted stops are spaced evenly. */
  offset?: number;
}

export type Gradient =
  | { kind: "linear"; /** CSS angle in degrees (0 = to top, 90 = to right). */ angle: number; stops: GradientStop[] }
  | { kind: "radial"; stops: GradientStop[] };

/** Anything that can fill an area. */
export type Paint = Color | Gradient;

export type HAlign = "start" | "end" | "left" | "right" | "center";
export type VAlign = "top" | "horizon" | "bottom";

export interface Sides<T> {
  top?: T;
  right?: T;
  bottom?: T;
  left?: T;
}

export interface Stroke {
  width: Length;
  color: Color;
  dash?: "dashed" | "dotted";
}

export interface TextStyle {
  font?: string[];
  size?: Length;
  weight?: number | "regular" | "bold";
  style?: "normal" | "italic";
  fill?: Color;
  tracking?: Length;
}

/** An outer `box-shadow` layer; lengths are absolute (pt). */
export interface Shadow {
  dx: Length;
  dy: Length;
  blur: Length;
  spread: Length;
  color: Color;
}

export type TransformOp =
  | { kind: "rotate"; /** Clockwise degrees, as in CSS. */ deg: number }
  | { kind: "scale"; x: number; y: number }
  | { kind: "translate"; dx: Length; dy: Length };

export interface BoxStyle {
  width?: Size;
  /** CSS `height`; padding is added unless `borderBox`. */
  height?: Length;
  /** CSS `min-height`; padding is added unless `borderBox`. */
  minHeight?: Length;
  /** `box-sizing: border-box`: heights already include the padding. */
  borderBox?: boolean;
  /** `width` is a CSS content-box width: horizontal padding is added. */
  contentWidth?: boolean;
  /** `background-image: url()`, painted over the fill and under the content. */
  image?: BackgroundImage;
  inset?: Sides<Length>;
  fill?: Paint;
  stroke?: Sides<Stroke>;
  radius?: Length;
  /** Space above/below — margins already collapsed by the front-end. */
  above?: Length;
  below?: Length;
  /** `break-inside: avoid` → false. */
  breakable?: boolean;
  align?: HAlign;
  /** Outer shadows, painted behind the box (makes it unbreakable). */
  shadows?: Shadow[];
}

export interface BackgroundImage {
  src: string;
  /** `cover`/`contain` scale to the box; `stretch` fills it; a size is used as is. */
  fit: "cover" | "contain" | "stretch" | { width?: Length; height?: Length };
  align: { x: HAlign; y: VAlign };
}

export interface InlineBoxStyle {
  width?: Size;
  /** Horizontal padding: takes space in the line. */
  inset?: Sides<Length>;
  /** Vertical padding: painted without changing line height, as in CSS inline boxes. */
  outset?: Sides<Length>;
  fill?: Paint;
  stroke?: Sides<Stroke>;
  radius?: Length;
}

// ── Inline ──────────────────────────────────────────────────────────────────

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "emph"; children: Inline[] }
  | { kind: "underline"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "super"; children: Inline[] }
  | { kind: "sub"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "styled"; style: TextStyle; children: Inline[] }
  | { kind: "box"; style: InlineBoxStyle; children: Inline[] }
  /** Horizontal space, from inline margins. */
  | { kind: "space"; width: Length }
  | { kind: "linebreak" }
  | { kind: "image"; src: string; width?: Size; height?: Size; alt?: string }
  /** `position: relative` offset of inline content: painted shifted, laid out in place. */
  | { kind: "move"; dx: Length; dy: Length; children: Inline[] }
  /** Current page number or total page count (headers and footers). */
  | { kind: "page-counter"; which: "page" | "pages" };

// ── Block ───────────────────────────────────────────────────────────────────

export interface TableCell {
  children: Block[];
  colspan?: number;
  rowspan?: number;
  align?: HAlign;
  fill?: Paint;
  /** The cell's own borders, when they differ from the table-wide stroke. */
  stroke?: Sides<Stroke>;
}

export interface TableRow {
  cells: TableCell[];
}

export type Block =
  | {
      kind: "paragraph";
      children: Inline[];
      align?: HAlign;
      justify?: boolean;
      /** Gap between lines, when `line-height` differs from the document's. */
      leading?: Length;
    }
  /** Horizontal margins (outside the box, like CSS). */
  | { kind: "pad"; left?: Length; right?: Length; children: Block[] }
  | PageRun
  /** CSS multi-column layout (`column-count`). */
  | { kind: "columns"; count: number; gutter?: Length; children: Block[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[]; align?: HAlign; style?: TextStyle }
  | {
      kind: "list";
      ordered: boolean;
      start?: number;
      /** Bullet text for unordered lists; "" hides it (`list-style: none`). */
      marker?: string;
      /** Typst numbering pattern for ordered lists, e.g. "a." or "I.". */
      numbering?: string;
      items: Block[][];
    }
  | { kind: "box"; style: BoxStyle; children: Block[] }
  | { kind: "styled-block"; style: TextStyle; children: Block[] }
  | {
      kind: "table";
      /** One entry per column after rowspan/colspan normalization. */
      columns: Size[];
      header?: TableRow[];
      body: TableRow[];
      footer?: TableRow[];
      /** Per-cell stroke: one for all sides, or per side (e.g. only bottom rules). */
      stroke?: Stroke | Sides<Stroke> | null;
      inset?: Length;
    }
  | {
      kind: "grid";
      columns: Size[];
      gutter?: Length;
      /** Per-boundary column gaps, overriding `gutter` between columns (flex spacers). */
      columnGutters?: Length[];
      /** Vertical alignment of every cell (CSS `align-items`). */
      valign?: "top" | "horizon" | "bottom";
      cells: Block[][];
    }
  | { kind: "raw-block"; value: string; lang?: string }
  | { kind: "rule" }
  | { kind: "pagebreak"; weak?: boolean }
  | { kind: "image"; src: string; width?: Size; height?: Size; alt?: string }
  /**
   * Out-of-flow content (`position: absolute`) anchored to a corner of the
   * containing block; offsets point inwards from that corner.
   */
  | {
      kind: "place";
      x: "left" | "right";
      y: "top" | "bottom";
      dx: Length;
      dy: Length;
      /** `left` and `right` both set without a width: the box spans between them. */
      span?: { left: Length; right: Length };
      /** Offsets are from the page area inside the margins (`position: fixed`). */
      pageArea?: boolean;
      children: Block[];
    }
  | { kind: "transform"; ops: TransformOp[]; children: Block[] };

/** Content of one `@page` margin box. */
export interface MarginBox {
  /** Text from `content` strings and counters… */
  inlines?: Inline[];
  /** …or a running element moved here with `element()`. */
  blocks?: Block[];
  style?: TextStyle;
}

export interface MarginBand {
  left?: MarginBox;
  center?: MarginBox;
  right?: MarginBox;
}

export interface PageSetup {
  paper?: string;
  flipped?: boolean;
  width?: Length;
  height?: Length;
  margin?: Sides<Length>;
  fill?: Paint;
  /** `@page { background-image: url() }`, painted behind the content on every page. */
  image?: BackgroundImage;
  /** `null` removes an inherited header (e.g. a named page with `content: none`). */
  header?: MarginBand | null;
  footer?: MarginBand | null;
  /** Content repeated on every page above the body (`position: fixed`). */
  foreground?: Block[];
  /** Overrides for the document's first page (`@page :first`). */
  first?: FirstPage;
}

export interface FirstPage {
  header?: MarginBand | null;
  footer?: MarginBand | null;
  fill?: Paint | null;
}

/**
 * A run of pages with its own page setup: a CSS named page (`page: name`) or a
 * composed section. Nested runs inherit whatever setup they do not override.
 */
export interface PageRun {
  kind: "page-run";
  /** CSS page name, resolved against `@page name` rules. */
  name?: string;
  page?: PageSetup;
  text?: TextStyle;
  leading?: Length;
  lang?: string;
  children: Block[];
}

export interface Document {
  page?: PageSetup;
  /** Document-wide text defaults (from `body`/`html`). */
  text?: TextStyle;
  /** Document-wide gap between lines (from the body's `line-height`). */
  leading?: Length;
  lang?: string;
  children: Block[];
}
