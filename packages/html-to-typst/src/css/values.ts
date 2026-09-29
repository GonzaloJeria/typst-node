import type { Color, Gradient, GradientStop, Length, Shadow, TransformOp } from "../ir.js";

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
  const v = value.trim();
  if (/^calc\(/i.test(v)) return parseCalc(v.slice(5, -1), ctx);
  const m = LENGTH.exec(v);
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

/**
 * Evaluates `calc()` with + - * / over lengths and numbers. Terms are reduced
 * to pt, or kept as % when every length term is a percentage.
 */
function parseCalc(expr: string, ctx: LengthContext): Length | undefined {
  const tokens = expr.match(/\d*\.?\d+[a-z%]*|[-+*/()]/gi);
  if (!tokens || tokens.join("").length !== expr.replace(/\s+/g, "").length) return undefined;
  let pos = 0;
  let unit: "pt" | "%" | undefined;
  type Q = { n: number; dim: boolean };
  const primary = (): Q | undefined => {
    const t = tokens[pos++];
    if (t === "(") {
      const q = sum();
      return tokens[pos++] === ")" ? q : undefined;
    }
    if (t === "-") {
      const q = primary();
      return q && { n: -q.n, dim: q.dim };
    }
    if (t === undefined || !/^\d*\.?\d+/.test(t)) return undefined;
    if (/^\d*\.?\d+$/.test(t)) return { n: Number(t), dim: false };
    const l = parseLength(t, ctx);
    if (!l) return undefined;
    const u = l.unit === "%" ? "%" : "pt";
    if (unit && unit !== u) return undefined; // Mixing % with absolute lengths needs layout.
    unit = u;
    const n = u === "%" ? l.value : toPt(l);
    return n === undefined ? undefined : { n, dim: true };
  };
  const product = (): Q | undefined => {
    let a = primary();
    while (a && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const b = primary();
      if (!b || (a.dim && b.dim) || (op === "/" && (b.dim || b.n === 0))) return undefined;
      a = { n: op === "*" ? a.n * b.n : a.n / b.n, dim: a.dim || b.dim };
    }
    return a;
  };
  const sum = (): Q | undefined => {
    let a = product();
    while (a && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const b = product();
      if (!b || a.dim !== b.dim) return undefined;
      a = { n: op === "+" ? a.n + b.n : a.n - b.n, dim: a.dim };
    }
    return a;
  };
  const q = sum();
  if (!q || pos !== tokens.length || !q.dim) return q && !q.dim && q.n === 0 ? { value: 0, unit: "pt" } : undefined;
  return { value: q.n, unit: unit ?? "pt" };
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

const HSL = /^hsla?\(\s*([^)]*)\)$/i;
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
  const hsl = HSL.exec(v);
  if (hsl) {
    const parts = hsl[1]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return undefined;
    const h = ((parseFloat(parts[0]!) % 360) + 360) % 360;
    const sat = parseFloat(parts[1]!) / 100;
    const lig = parseFloat(parts[2]!) / 100;
    if (![h, sat, lig].every(Number.isFinite)) return undefined;
    const k = (n: number) => (n + h / 30) % 12;
    const a = sat * Math.min(lig, 1 - lig);
    const f = (n: number) => 255 * (lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
    const alpha = parts[3] === undefined ? "" : `, ${parts[3]}`;
    return parseColor(`rgb(${f(0)}, ${f(8)}, ${f(4)}${alpha})`);
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

/** Multiplies a color's alpha by `factor` (0–1), for `opacity`. */
export function withAlpha(color: Color, factor: number): Color {
  if (factor >= 1) return color;
  const base = color.slice(1, 7);
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
  const next = Math.round(Math.max(0, Math.min(1, factor)) * alpha);
  return `#${base}${next.toString(16).padStart(2, "0")}`;
}

const SIDE_ANGLES: Record<string, number> = {
  "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
  "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
  "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315,
};

/**
 * Parses `linear-gradient()` / `radial-gradient()`. Corner directions are
 * approximated as 45° multiples; radial shape, size and position are ignored.
 */
export function parseGradient(value: string): Gradient | undefined {
  const m = /^(?:repeating-)?(linear|radial)-gradient\((.*)\)$/is.exec(value.trim());
  if (!m) return undefined;
  const args = splitArgs(m[2]!);
  let angle = 180;
  if (m[1] === "linear" && args[0] !== undefined) {
    const first = args[0].trim().toLowerCase().replace(/\s+/g, " ");
    const deg = /^(-?\d*\.?\d+)(deg|turn|rad|grad)$/.exec(first);
    if (deg) {
      const n = Number(deg[1]);
      angle = deg[2] === "turn" ? n * 360 : deg[2] === "rad" ? (n * 180) / Math.PI : deg[2] === "grad" ? n * 0.9 : n;
      args.shift();
    } else if (first in SIDE_ANGLES) {
      angle = SIDE_ANGLES[first]!;
      args.shift();
    }
  } else if (m[1] === "radial" && args[0] !== undefined && parseColor(splitValue(args[0])[0] ?? "") === undefined) {
    args.shift(); // shape / size / position
  }
  const stops: GradientStop[] = [];
  for (const arg of args) {
    const [c, pos] = splitValue(arg);
    const color = parseColor(c ?? "");
    if (!color) return undefined;
    const offset = pos?.endsWith("%") ? Number(pos.slice(0, -1)) : undefined;
    stops.push(offset !== undefined && Number.isFinite(offset) ? { color, offset } : { color });
  }
  if (stops.length < 2) return undefined;
  return m[1] === "linear" ? { kind: "linear", angle, stops } : { kind: "radial", stops };
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseAngle(v: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(deg|turn|rad|grad)?$/.exec(v.trim().toLowerCase());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!m[2]) return n === 0 ? 0 : undefined;
  return m[2] === "turn" ? n * 360 : m[2] === "rad" ? (n * 180) / Math.PI : m[2] === "grad" ? n * 0.9 : n;
}

/**
 * Parses a `transform` list into operations, outermost first. Returns
 * undefined for anything unsupported (skew, matrix, 3D, % translations).
 */
export function parseTransform(value: string, ctx: LengthContext): TransformOp[] | undefined {
  const v = value.trim();
  if (v === "none") return [];
  const ops: TransformOp[] = [];
  const re = /([a-zA-Z]+)\(([^)]*)\)/g;
  let consumed = "";
  for (const m of v.matchAll(re)) {
    consumed += m[0];
    const fn = m[1]!.toLowerCase();
    const args = m[2]!.split(",").map((a) => a.trim()).filter(Boolean);
    const len = (a: string | undefined) => {
      if (a === undefined) return { value: 0, unit: "pt" as const };
      const l = parseLength(a, ctx);
      return l && l.unit !== "%" ? l : undefined;
    };
    if (fn === "rotate" || fn === "rotatez") {
      const deg = parseAngle(args[0] ?? "");
      if (deg === undefined) return undefined;
      ops.push({ kind: "rotate", deg });
    } else if (fn === "scale" || fn === "scalex" || fn === "scaley") {
      const nums = args.map(Number);
      if (!nums.length || nums.some((n) => !Number.isFinite(n))) return undefined;
      const x = fn === "scaley" ? 1 : nums[0]!;
      const y = fn === "scalex" ? 1 : fn === "scaley" ? nums[0]! : nums[1] ?? nums[0]!;
      ops.push({ kind: "scale", x, y });
    } else if (fn === "translate" || fn === "translatex" || fn === "translatey") {
      const a = len(fn === "translatey" ? undefined : args[0]);
      const b = len(fn === "translatex" ? undefined : fn === "translatey" ? args[0] : args[1]);
      if (!a || !b) return undefined;
      ops.push({ kind: "translate", dx: a, dy: b });
    } else return undefined;
  }
  if (consumed.replace(/\s+/g, "") !== v.replace(/\s+/g, "")) return undefined;
  return ops;
}

/** Parses outer `box-shadow` layers; `inset` shadows make the value unsupported. */
export function parseShadows(value: string, ctx: LengthContext): Shadow[] | undefined {
  const v = value.trim();
  if (v === "none") return [];
  const layers: Shadow[] = [];
  for (const layer of splitArgs(v)) {
    const tokens = splitValue(layer);
    if (tokens.some((t) => t.toLowerCase() === "inset")) return undefined;
    const colorToken = tokens.find((t) => parseColor(t) !== undefined);
    const lengths = tokens.filter((t) => t !== colorToken).map((t) => parseLength(t, ctx));
    if (lengths.length < 2 || lengths.length > 4 || lengths.some((l) => !l || l.unit === "%")) return undefined;
    const [dx, dy, blur = { value: 0, unit: "pt" as const }, spread = { value: 0, unit: "pt" as const }] = lengths as Length[];
    layers.push({ dx: dx!, dy: dy!, blur, spread, color: parseColor(colorToken ?? "") ?? ("#00000040" as Color) });
  }
  return layers;
}
