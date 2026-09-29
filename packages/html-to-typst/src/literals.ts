import type { Color, HAlign, Length, Sides, Size, Stroke } from "./ir.js";

/**
 * Every piece of user text reaches Typst as a string literal, never as markup,
 * so `#`, `$`, `*`, `_`, `@`, `<` and friends need no escaping at all.
 */
export function str(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: {
        const code = ch.codePointAt(0)!;
        // Other control characters are invalid in Typst source.
        out += code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : ch;
      }
    }
  }
  return out + '"';
}

export function num(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Non-finite number: ${n}`);
  // Avoid exponent notation, which Typst does not accept for lengths.
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

export function length(l: Length): string {
  return `${num(l.value)}${l.unit}`;
}

export function size(s: Size): string {
  return s === "auto" ? "auto" : length(s);
}

const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export function color(c: Color): string {
  if (!COLOR.test(c)) throw new TypeError(`Invalid color: ${c}`);
  return `rgb(${str(c)})`;
}

export function align(a: HAlign): string {
  return a;
}

export function stroke(s: Stroke): string {
  return `${length(s.width)} + ${color(s.color)}`;
}

/** Collapses to the shortest form when all present sides are equal. */
export function sides<T>(value: Sides<T>, render: (v: T) => string): string {
  const entries = (["top", "right", "bottom", "left"] as const)
    .filter((k) => value[k] !== undefined)
    .map((k) => [k, render(value[k] as T)] as const);
  if (entries.length === 4 && entries.every(([, v]) => v === entries[0]![1])) return entries[0]![1];
  return `(${entries.map(([k, v]) => `${k}: ${v}`).join(", ")})`;
}

/** Renders `name(a: 1, b: 2, body)` skipping undefined named args. */
export function call(name: string, named: Record<string, string | undefined>, ...positional: string[]): string {
  const args = Object.entries(named)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `${name}(${[...args, ...positional].join(", ")})`;
}
