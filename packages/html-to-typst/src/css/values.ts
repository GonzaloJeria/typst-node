import type { Color, Length } from "../ir.js";

/** Context needed to turn relative CSS units into absolute ones. */
export interface LengthContext {
  /** Computed font size of the element, in pt. */
  fontSize: number;
  /** Root font size, in pt. */
  rootFontSize: number;
}

const PX_TO_PT = 0.75;
const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|pt|pc|mm|cm|in|em|rem|%|q)?$/i;

/**
 * Parses a CSS length into an IR length. Relative units (px, em, rem) become
 * pt; `%` stays relative because only Typst knows the containing block.
 */
export function parseLength(value: string, ctx: LengthContext): Length | undefined {
  const m = LENGTH.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  switch (unit) {
    case "":
      return n === 0 ? { value: 0, unit: "pt" } : undefined;
    case "px": return { value: n * PX_TO_PT, unit: "pt" };
    case "pt": return { value: n, unit: "pt" };
    case "pc": return { value: n * 12, unit: "pt" };
    case "mm": return { value: n, unit: "mm" };
    case "cm": return { value: n, unit: "cm" };
    case "q": return { value: n / 4, unit: "mm" };
    case "in": return { value: n, unit: "in" };
    case "em": return { value: n * ctx.fontSize, unit: "pt" };
    case "rem": return { value: n * ctx.rootFontSize, unit: "pt" };
    case "%": return { value: n, unit: "%" };
  }
  return undefined;
}

/** Converts an absolute IR length to pt (undefined for `%`/`fr`/`em`). */
export function toPt(l: Length): number | undefined {
  switch (l.unit) {
    case "pt": return l.value;
    case "mm": return (l.value * 72) / 25.4;
    case "cm": return (l.value * 72) / 2.54;
    case "in": return l.value * 72;
    default: return undefined;
  }
}

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 7, "x-small": 7.5, small: 10, medium: 12, large: 13.5, "x-large": 18, "xx-large": 24,
};

/** Resolves `font-size` to pt against the parent's size. */
export function parseFontSize(value: string, parentPt: number, rootPt: number): number | undefined {
  const v = value.trim().toLowerCase();
  if (v in FONT_SIZE_KEYWORDS) return FONT_SIZE_KEYWORDS[v];
  if (v === "smaller") return parentPt / 1.2;
  if (v === "larger") return parentPt * 1.2;
  const l = parseLength(v, { fontSize: parentPt, rootFontSize: rootPt });
  if (!l) return undefined;
  if (l.unit === "%") return (l.value / 100) * parentPt;
  return toPt(l);
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", aqua: "#00ffff",
  cyan: "#00ffff", teal: "#008080", navy: "#000080", fuchsia: "#ff00ff", magenta: "#ff00ff",
  pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc", dimgray: "#696969", dimgrey: "#696969",
  darkblue: "#00008b", darkred: "#8b0000", darkgreen: "#006400", steelblue: "#4682b4",
  transparent: "#00000000",
};

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;

/** Parses a CSS color into `#rrggbb[aa]`, or undefined when unsupported. */
export function parseColor(value: string): Color | undefined {
  const v = value.trim().toLowerCase();
  if (v in NAMED) return NAMED[v] as Color;
  const hex = HEX.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return `#${h}`;
  }
  const rgb = RGB.exec(v);
  if (rgb) {
    const parts = rgb[1]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return undefined;
    const channel = (p: string) => (p.endsWith("%") ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p));
    const alpha = (p: string) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)) * 255;
    const nums = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)];
    if (parts[3] !== undefined) nums.push(alpha(parts[3]));
    if (nums.some((n) => !Number.isFinite(n))) return undefined;
    const hexed = nums.map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0"));
    if (hexed.length === 4 && hexed[3] === "ff") hexed.pop();
    return `#${hexed.join("")}`;
  }
  return undefined;
}

/** Splits a CSS value on top-level whitespace (ignoring spaces inside parens). */
export function splitValue(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Expands 1–4 value box shorthands (margin, padding) to [top, right, bottom, left]. */
export function expandBox(values: string[]): [string, string, string, string] | undefined {
  const [a, b = a, c = a, d = b] = values;
  if (a === undefined || values.length > 4) return undefined;
  return [a, b!, c!, d!];
}
