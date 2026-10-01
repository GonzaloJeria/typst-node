/**
 * Evaluates `@supports` conditions and media queries. The output medium is
 * print: a paged, static, colour medium without hover or a pointer, whose
 * viewport is the page box (as in Chrome when printing).
 */
import { checkDeclaration } from "./support.js";
import { parseSelector } from "./selector.js";
import { splitTopLevel } from "./parse.js";

export interface MediaContext {
  /** Page box size in CSS px. */
  width: number;
  height: number;
}

type Atom = (text: string) => boolean;

/** Generic `not` / `and` / `or` / parentheses evaluator over atoms. */
function evaluate(text: string, atom: Atom, func: Atom): boolean {
  let pos = 0;
  const src = text.trim();
  const ws = () => {
    while (/\s/.test(src[pos] ?? "")) pos++;
  };
  const group = (): string => {
    // src[pos] is "(": returns the text up to the matching ")".
    let depth = 0;
    const start = pos;
    for (; pos < src.length; pos++) {
      if (src[pos] === "(") depth++;
      else if (src[pos] === ")" && --depth === 0) return src.slice(start + 1, pos++);
    }
    return src.slice(start + 1);
  };
  const keyword = (k: string) => {
    ws();
    const re = new RegExp(`^${k}(?![-\\w])`, "i");
    if (re.test(src.slice(pos))) {
      pos += k.length;
      return true;
    }
    return false;
  };
  const term = (): boolean => {
    ws();
    if (keyword("not")) return !term();
    if (src[pos] === "(") {
      const inner = group().trim();
      return /^(?:\(|not\s)/i.test(inner) ? evaluate(inner, atom, func) : atom(inner);
    }
    const fn = /^[-\w]+\(/.exec(src.slice(pos));
    if (fn) {
      pos += fn[0].length - 1;
      return func(`${fn[0]}${group()})`);
    }
    // A bare word (media type, `only`).
    const word = /^[-\w]+/.exec(src.slice(pos));
    if (!word) {
      pos = src.length;
      return false;
    }
    pos += word[0].length;
    return atom(word[0]);
  };
  let result = term();
  for (;;) {
    if (keyword("and")) result = term() && result;
    else if (keyword("or")) result = term() || result;
    else break;
  }
  ws();
  return pos >= src.length && result;
}

/** `@supports` condition, answered for this converter's capabilities. */
export function supportsCondition(text: string): boolean {
  return evaluate(
    text,
    (decl) => {
      const i = decl.indexOf(":");
      if (i === -1) return false;
      const property = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).trim();
      if (property.startsWith("--")) return true;
      if (/^-(?:webkit|moz|ms|o)-/.test(property)) return false;
      return checkDeclaration(property, value, "") === undefined;
    },
    (fn) => {
      const m = /^selector\((.*)\)$/is.exec(fn);
      return !!m && parseSelector(m[1]!) !== undefined;
    },
  );
}

const MEDIA_TYPES: Record<string, boolean> = { all: true, print: true, screen: false, speech: false };

/** True when a comma-separated media query list matches. */
export function mediaMatches(query: string, ctx: MediaContext): boolean {
  return splitTopLevel(query, ",").some((q) => {
    // `only` is a legacy guard with no meaning of its own.
    const text = q.trim().replace(/^only\s+/i, "");
    if (!text) return true;
    return evaluate(text, (atom) => mediaAtom(atom, ctx), () => false);
  });
}

const RANGE_OPS = /\s*(<=|>=|<|>|=)\s*/;

function mediaAtom(text: string, ctx: MediaContext): boolean {
  const t = text.trim().toLowerCase();
  if (/^[-\w]+$/.test(t) && !t.includes("-") && t in MEDIA_TYPES) return MEDIA_TYPES[t]!;
  // Range syntax: `width >= 40rem`, `400px < width <= 700px`.
  if (RANGE_OPS.test(t) && !t.includes(":")) {
    const parts = t.split(RANGE_OPS);
    if (parts.length === 3 || parts.length === 5) {
      let ok = true;
      for (let i = 0; i + 2 < parts.length; i += 2) {
        const [a, op, b] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
        const left = rangeValue(a, ctx);
        const right = rangeValue(b, ctx);
        if (left === undefined || right === undefined) return false;
        ok &&= compare(left, op, right);
      }
      return ok;
    }
    return false;
  }
  const colon = t.indexOf(":");
  const feature = (colon === -1 ? t : t.slice(0, colon)).trim();
  const value = colon === -1 ? undefined : t.slice(colon + 1).trim();
  const prefix = /^(min|max)-(.*)$/.exec(feature);
  const name = prefix ? prefix[2]! : feature;
  const actual = featureValue(name, ctx);
  if (actual === undefined) return false;
  if (value === undefined) return actual !== 0 && actual !== "none";
  if (typeof actual === "string") return actual === value;
  const wanted = name === "aspect-ratio" ? ratio(value) : name === "resolution" ? resolution(value) : length(value);
  if (wanted === undefined) return false;
  if (!prefix) return Math.abs(actual - wanted) < 1e-6;
  return prefix[1] === "min" ? actual >= wanted : actual <= wanted;
}

function featureValue(name: string, ctx: MediaContext): number | string | undefined {
  switch (name) {
    case "width":
    case "device-width": return ctx.width;
    case "height":
    case "device-height": return ctx.height;
    case "aspect-ratio": return ctx.width / ctx.height;
    case "orientation": return ctx.height >= ctx.width ? "portrait" : "landscape";
    case "color": return 8;
    case "monochrome": return 0;
    case "resolution": return 1;
    case "grid": return 0;
    case "hover":
    case "any-hover":
    case "pointer":
    case "any-pointer": return "none";
    case "update": return "none";
    case "scripting": return "none";
    case "prefers-color-scheme": return "light";
    case "prefers-reduced-motion": return "no-preference";
    case "prefers-contrast": return "no-preference";
    case "forced-colors": return "none";
    case "inverted-colors": return "none";
    case "display-mode": return "browser";
  }
  return undefined;
}

function rangeValue(text: string, ctx: MediaContext): number | undefined {
  const t = text.trim();
  if (t === "width") return ctx.width;
  if (t === "height") return ctx.height;
  if (t === "aspect-ratio") return ctx.width / ctx.height;
  return length(t) ?? ratio(t);
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b + 1e-6;
    case ">": return a > b;
    case ">=": return a >= b - 1e-6;
    default: return Math.abs(a - b) < 1e-6;
  }
}

const PX_PER: Record<string, number> = { px: 1, em: 16, rem: 16, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

/** Media query lengths in px; `em` is the initial font size, 16px. */
function length(text: string): number | undefined {
  const m = /^(-?\d*\.?\d+)([a-z]*)$/.exec(text.trim());
  if (!m) return undefined;
  if (!m[2]) return Number(m[1]) === 0 ? 0 : undefined;
  const k = PX_PER[m[2]];
  return k === undefined ? undefined : Number(m[1]) * k;
}

function ratio(text: string): number | undefined {
  const m = /^(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+))?$/.exec(text.trim());
  return m ? Number(m[1]) / Number(m[2] ?? 1) : undefined;
}

function resolution(text: string): number | undefined {
  const m = /^(\d*\.?\d+)(dppx|x|dpi|dpcm)$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "dpi" ? n / 96 : m[2] === "dpcm" ? (n * 2.54) / 96 : n;
}
