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
}

export interface TextStyle {
  font?: string[];
  size?: Length;
  weight?: number | "regular" | "bold";
  style?: "normal" | "italic";
  fill?: Color;
  tracking?: Length;
}

export interface BoxStyle {
  width?: Size;
  inset?: Sides<Length>;
  fill?: Color;
  stroke?: Sides<Stroke>;
  radius?: Length;
  /** Space above/below — margins already collapsed by the front-end. */
  above?: Length;
  below?: Length;
  /** `break-inside: avoid` → false. */
  breakable?: boolean;
  align?: HAlign;
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
  | { kind: "linebreak" }
  | { kind: "image"; src: string; width?: Size; height?: Size; alt?: string };

// ── Block ───────────────────────────────────────────────────────────────────

export interface TableCell {
  children: Block[];
  colspan?: number;
  rowspan?: number;
  align?: HAlign;
  fill?: Color;
}

export interface TableRow {
  cells: TableCell[];
}

export type Block =
  | { kind: "paragraph"; children: Inline[]; align?: HAlign; justify?: boolean }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "list"; ordered: boolean; start?: number; items: Block[][] }
  | { kind: "box"; style: BoxStyle; children: Block[] }
  | { kind: "styled-block"; style: TextStyle; children: Block[] }
  | {
      kind: "table";
      /** One entry per column after rowspan/colspan normalization. */
      columns: Size[];
      header?: TableRow[];
      body: TableRow[];
      footer?: TableRow[];
      stroke?: Stroke | null;
      inset?: Length;
    }
  | { kind: "grid"; columns: Size[]; gutter?: Length; cells: Block[][] }
  | { kind: "raw-block"; value: string; lang?: string }
  | { kind: "rule" }
  | { kind: "pagebreak"; weak?: boolean }
  | { kind: "image"; src: string; width?: Size; height?: Size; alt?: string };

export interface PageSetup {
  paper?: string;
  width?: Length;
  height?: Length;
  margin?: Sides<Length>;
}

export interface Document {
  page?: PageSetup;
  /** Document-wide text defaults (from `body`/`html`). */
  text?: TextStyle;
  lang?: string;
  children: Block[];
}
