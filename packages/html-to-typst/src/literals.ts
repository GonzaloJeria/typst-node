import type { Color, GradientStop, HAlign, Length, Paint, Sides, Size, Stroke } from "./ir.js";

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
  if (s.dash) return `(paint: ${color(s.color)}, thickness: ${length(s.width)}, dash: ${str(s.dash)})`;
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

export function paint(p: Paint): string {
  if (typeof p === "string") return color(p);
  const stops = normalizeStops(p.stops).map((s) => `(${color(s.color)}, ${num(s.offset)}%)`).join(", ");
  if (p.kind === "radial") return `gradient.radial(${stops})`;
  // CSS measures from "to top" clockwise; Typst from "to right" clockwise (y points down).
  const angle = (((p.angle - 90) % 360) + 360) % 360;
  return `gradient.linear(${stops}, angle: ${num(angle)}deg)`;
}

/** Fills in missing stop offsets the way CSS does and keeps them monotonic. */
function normalizeStops(stops: GradientStop[]): { color: Color; offset: number }[] {
  const offsets = stops.map((s) => s.offset);
  offsets[0] ??= 0;
  offsets[offsets.length - 1] ??= 100;
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] !== undefined) {
      offsets[i] = Math.max(offsets[i]!, offsets[i - 1]!);
      continue;
    }
    let j = i;
    while (offsets[j] === undefined) j++;
    const from = offsets[i - 1]!;
    const to = Math.max(offsets[j]!, from);
    for (let k = i; k < j; k++) offsets[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s, i) => ({ color: s.color, offset: Math.min(100, Math.max(0, offsets[i]!)) }));
}
