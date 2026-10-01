import { hslToRgb, NAMED_COLORS, parseColorFunction, type Rgba } from "./colors.js";
import type { Color, Gradient, GradientStop, Length, Shadow, TransformOp } from "../ir.js";

/** Context needed to turn relative CSS units into absolute ones. */
export interface LengthContext {
  /** Computed font size of the element, in pt. */
  fontSize: number;
  /** Root font size, in pt. */
  rootFontSize: number;
  /** Page area in pt, for viewport units (default: A4). */
  viewport?: { width: number; height: number };
}

const A4_PT = { width: 595.28, height: 841.89 };

const PX_TO_PT = 0.75;
const LENGTH = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|pt|pc|mm|cm|in|em|rem|%|q|ch|ex|lh|rlh|cap|ic|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|vi|vb)?$/i;

/**
 * Parses a CSS length into an IR length. Relative units (px, em, rem) become
 * pt; `%` stays relative because only Typst knows the containing block.
 */
export function parseLength(value: string, ctx: LengthContext): Length | undefined {
  const v = value.trim();
  const fn = /^(calc|min|max|clamp)\((.*)\)$/is.exec(v);
  if (fn) return parseCalc(fn[1]!.toLowerCase() === "calc" ? fn[2]! : v, ctx);
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
    // Font-relative units without font metrics: typical ratios for Latin fonts.
    case "ch": return { value: n * ctx.fontSize * 0.5, unit: "pt" };
    case "ex": return { value: n * ctx.fontSize * 0.5, unit: "pt" };
    case "cap": return { value: n * ctx.fontSize * 0.7, unit: "pt" };
    case "ic": return { value: n * ctx.fontSize, unit: "pt" };
    case "lh": return { value: n * ctx.fontSize * 1.2, unit: "pt" };
    case "rlh": return { value: n * ctx.rootFontSize * 1.2, unit: "pt" };
  }
  // Viewport units: when printing, the viewport is the page area (inside the margins).
  const vp = ctx.viewport ?? A4_PT;
  const viewport: Record<string, number> = {
    vw: vp.width, svw: vp.width, lvw: vp.width, dvw: vp.width, vi: vp.width,
    vh: vp.height, svh: vp.height, lvh: vp.height, dvh: vp.height, vb: vp.height,
    vmin: Math.min(vp.width, vp.height), vmax: Math.max(vp.width, vp.height),
  };
  if (unit in viewport) return { value: round4((n * viewport[unit]!) / 100), unit: "pt" };
  return undefined;
}

/**
 * Evaluates `calc()` with + - * / over lengths and numbers. Terms are reduced
 * to pt, or kept as % when every length term is a percentage.
 */
function parseCalc(expr: string, ctx: LengthContext): Length | undefined {
  const q = evalCalc(expr, ctx);
  if (!q) return undefined;
  if (!q.dim) return q.n === 0 ? { value: 0, unit: "pt" } : undefined;
  if (q.pct === 0) return { value: round4(q.n), unit: "pt" };
  if (Math.abs(q.n) < 1e-9) return { value: round4(q.pct), unit: "%" };
  // Typst relative lengths combine both: `100% - 2rem` → `100% - 24pt`.
  return { value: round4(q.pct), unit: "%", offset: round4(q.n) };
}

function evalCalc(expr: string, ctx: LengthContext): { n: number; pct: number; dim: boolean } | undefined {
  const tokens = expr.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?[a-z%]*|[a-z-]+\(|[-+*/(),]/gi);
  if (!tokens || tokens.join("").length !== expr.replace(/\s+/g, "").length) return undefined;
  // A sign glued to a number after an operand is a binary operator (`1px -2px` is invalid CSS anyway).
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1]!;
    if (/^[-+]\d|^[-+]\./.test(tokens[i]!) && !/^[-+*/(,]$|\($/.test(prev)) {
      tokens.splice(i, 1, tokens[i]![0]!, tokens[i]!.slice(1));
    }
  }
  let pos = 0;
  // A number (dim: false) or a length `n pt + pct %` (dim: true).
  type Q = { n: number; pct: number; dim: boolean };
  const fail = (): undefined => {
    pos = tokens.length + 1;
    return undefined;
  };
  const scale = (q: Q, k: number): Q => ({ n: q.n * k, pct: q.pct * k, dim: q.dim });
  const args = (): Q[] | undefined => {
    const out: Q[] = [];
    for (;;) {
      const q = sum();
      if (!q) return undefined;
      out.push(q);
      const t = tokens[pos++];
      if (t === ")") return out;
      if (t !== ",") return undefined;
    }
  };
  const primary = (): Q | undefined => {
    const t = tokens[pos++];
    if (t === "(" || t?.toLowerCase() === "calc(") {
      const q = sum();
      return tokens[pos++] === ")" ? q : fail();
    }
    if (t === "-" || t === "+") {
      const q = primary();
      return q && (t === "-" ? scale(q, -1) : q);
    }
    const fn = t?.toLowerCase();
    if (fn === "min(" || fn === "max(" || fn === "clamp(") {
      const list = args();
      if (!list || !list.length || list.some((q) => q.dim !== list[0]!.dim)) return fail();
      // Comparing % with absolute lengths needs the container size.
      const percent = list.some((q) => q.pct !== 0);
      if (percent && list.some((q) => q.n !== 0)) return fail();
      const ns = list.map((q) => (percent ? q.pct : q.n));
      let v: number;
      if (fn === "clamp(") {
        if (ns.length !== 3) return fail();
        v = Math.max(ns[0]!, Math.min(ns[1]!, ns[2]!));
      } else v = fn === "min(" ? Math.min(...ns) : Math.max(...ns);
      return percent ? { n: 0, pct: v, dim: true } : { n: v, pct: 0, dim: list[0]!.dim };
    }
    if (t === undefined || !/^[-+]?\d*\.?\d+/.test(t)) return fail();
    if (/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(t)) return { n: Number(t), pct: 0, dim: false };
    const l = parseLength(t, ctx);
    if (!l) return fail();
    if (l.unit === "%") return { n: 0, pct: l.value, dim: true };
    const n = toPt(l);
    return n === undefined ? fail() : { n, pct: 0, dim: true };
  };
  const product = (): Q | undefined => {
    let a = primary();
    while (a && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const b = primary();
      if (!b || (a.dim && b.dim) || (op === "/" && (b.dim || b.n === 0))) return fail();
      const [len, k] = a.dim ? [a, b.n] : [b, a.n];
      a = op === "*" ? scale(len, k) : scale(a, 1 / b.n);
    }
    return a;
  };
  const sum = (): Q | undefined => {
    let a = product();
    while (a && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const b = product();
      if (!b) return fail();
      // A unitless zero mixes with lengths, as in `max(0, 1rem)`.
      const zero = (q: Q) => !q.dim && q.n === 0;
      if (a.dim !== b.dim && !zero(a) && !zero(b)) return fail();
      const sign = op === "+" ? 1 : -1;
      a = { n: a.n + sign * b.n, pct: a.pct + sign * b.pct, dim: a.dim || b.dim };
    }
    return a;
  };
  const q = sum();
  if (!q || pos !== tokens.length) return undefined;
  return q;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Evaluates a unitless `calc()`/`min()`/`max()`/`clamp()` expression (e.g. `calc(1 / 2)`). */
export function parseNumber(value: string): number | undefined {
  const v = value.trim();
  if (/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(v)) return Number(v);
  if (!/^(?:calc|min|max|clamp)\(/i.test(v)) return undefined;
  const q = evalCalc(/^calc\(/i.test(v) ? v.slice(5, -1) : v, { fontSize: 12, rootFontSize: 12 });
  return q && !q.dim ? q.n : undefined;
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

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LEGACY = /^(rgba?|hsla?)\(\s*(.*)\)$/is;

/** Parses a CSS color into `#rrggbb[aa]`, or undefined when unsupported. */
export function parseColor(value: string): Color | undefined {
  const c = parseRgba(value);
  if (!c) return undefined;
  const hexed = c.map((n) => Math.round(n * 255).toString(16).padStart(2, "0"));
  if (hexed[3] === "ff") hexed.pop();
  return `#${hexed.join("")}`;
}

function parseRgba(value: string): Rgba | undefined {
  const v = value.trim().toLowerCase();
  const named = NAMED_COLORS[v];
  if (named) return hexToRgba(named);
  const hex = HEX.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return hexToRgba(h);
  }
  const legacy = LEGACY.exec(v);
  if (legacy) {
    const parts = legacy[2]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return undefined;
    const num = (p: string, full: number) => (p === "none" ? 0 : p.endsWith("%") ? (parseFloat(p) / 100) * full : Number(p));
    const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
    let rgb: number[];
    if (legacy[1]!.startsWith("rgb")) rgb = parts.slice(0, 3).map((p) => num(p, 255) / 255);
    else {
      const h = parseFloat(parts[0]!) * (/turn$/.test(parts[0]!) ? 360 : /rad$/.test(parts[0]!) && !/grad$/.test(parts[0]!) ? 180 / Math.PI : /grad$/.test(parts[0]!) ? 0.9 : 1);
      rgb = hslToRgb(h, num(parts[1]!, 100) / 100, num(parts[2]!, 100) / 100);
    }
    const out = [...rgb, alpha];
    if (out.some((n) => !Number.isFinite(n))) return undefined;
    return out.map((n) => Math.min(1, Math.max(0, n))) as Rgba;
  }
  return parseColorFunction(v, parseRgba);
}

function hexToRgba(h: string): Rgba {
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
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

/**
 * `box-shadow: inset 0 0 0 <huge spread> <color>` paints the whole padding
 * box (Bootstrap tables stripe rows this way): returns that color.
 */
export function parseInsetFill(value: string): Color | undefined {
  const tokens = splitValue(value.trim());
  if (tokens[0]?.toLowerCase() !== "inset" || tokens.length !== 6) return undefined;
  if (!tokens.slice(1, 4).every((t) => /^0(?:[a-z]+)?$/.test(t))) return undefined;
  const spread = parseLength(tokens[4]!, { fontSize: 12, rootFontSize: 12 });
  if (!spread || spread.unit !== "pt" || spread.value < 500) return undefined;
  return parseColor(tokens[5]!);
}

/** Composites `top` over `bottom` (both `#rrggbb[aa]`). */
export function overColor(bottom: Color, top: Color): Color {
  const rgba = (c: Color) => [1, 3, 5, 7].map((i) => (i === 7 && c.length < 9 ? 255 : parseInt(c.slice(i, i + 2), 16)) / 255);
  const [br, bg, bb, ba] = rgba(bottom) as [number, number, number, number];
  const [tr, tg, tb, ta] = rgba(top) as [number, number, number, number];
  const a = ta + ba * (1 - ta);
  if (a === 0) return "#00000000";
  const mix = (t: number, b: number) => Math.round(((t * ta + b * ba * (1 - ta)) / a) * 255).toString(16).padStart(2, "0");
  const alpha = Math.round(a * 255);
  return `#${mix(tr, br)}${mix(tg, bg)}${mix(tb, bb)}${alpha === 255 ? "" : alpha.toString(16).padStart(2, "0")}`;
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

/** `url("…")` → the URL, unescaped. */
export function parseUrl(value: string): string | undefined {
  const m = /^url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s)"']+))\s*\)$/i.exec(value.trim());
  const url = m && (m[1] ?? m[2] ?? m[3]);
  return url ? url.replace(/\\(.)/g, "$1") : undefined;
}
