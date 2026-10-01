/**
 * CSS Color 4/5 functions that Typst has no direct syntax for: `oklch()`,
 * `oklab()`, `lab()`, `lch()`, `hwb()`, `color()` and `color-mix()`. Every
 * color is converted to sRGB (clamped to the gamut) with alpha.
 */

/** sRGB channels 0–1 and alpha 0–1. */
export type Rgba = [number, number, number, number];

const COLOR_FN = /^(oklch|oklab|lab|lch|hwb|color)\((.*)\)$/is;

/** Parses a color function into sRGB, or undefined when unsupported. */
export function parseColorFunction(value: string, parse: (v: string) => Rgba | undefined): Rgba | undefined {
  const v = value.trim();
  const mix = /^color-mix\((.*)\)$/is.exec(v);
  if (mix) return colorMix(mix[1]!, parse);
  const m = COLOR_FN.exec(v);
  if (!m) return undefined;
  const fn = m[1]!.toLowerCase();
  const [body, alphaText] = splitAlpha(m[2]!);
  const parts = body.split(/[\s,]+/).filter(Boolean);
  const alpha = alphaText === undefined ? 1 : component(alphaText, 1);
  if (alpha === undefined) return undefined;

  if (fn === "color") {
    const space = parts.shift()?.toLowerCase();
    const c = parts.map((p) => component(p, 1));
    if (c.length !== 3 || c.some((x) => x === undefined)) return undefined;
    const [r, g, b] = c as number[];
    if (space === "srgb") return rgba([r!, g!, b!], alpha);
    if (space === "srgb-linear") return rgba(gamma([r!, g!, b!]), alpha);
    if (space === "display-p3") return rgba(gamma(xyzToLinearSrgb(p3ToXyz(linearize([r!, g!, b!])))), alpha);
    return undefined;
  }
  if (parts.length !== 3) return undefined;
  switch (fn) {
    case "oklab": {
      const [l, a, b] = [component(parts[0]!, 1), component(parts[1]!, 0.4), component(parts[2]!, 0.4)];
      if (l === undefined || a === undefined || b === undefined) return undefined;
      return rgba(gamma(oklabToLinear(l, a, b)), alpha);
    }
    case "oklch": {
      const [l, c, h] = [component(parts[0]!, 1), component(parts[1]!, 0.4), hue(parts[2]!)];
      if (l === undefined || c === undefined || h === undefined) return undefined;
      const rad = (h * Math.PI) / 180;
      return rgba(gamma(oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad))), alpha);
    }
    case "lab": {
      const [l, a, b] = [component(parts[0]!, 100), component(parts[1]!, 125), component(parts[2]!, 125)];
      if (l === undefined || a === undefined || b === undefined) return undefined;
      return rgba(gamma(xyzToLinearSrgb(labToXyzD65(l, a, b))), alpha);
    }
    case "lch": {
      const [l, c, h] = [component(parts[0]!, 100), component(parts[1]!, 150), hue(parts[2]!)];
      if (l === undefined || c === undefined || h === undefined) return undefined;
      const rad = (h * Math.PI) / 180;
      return rgba(gamma(xyzToLinearSrgb(labToXyzD65(l, c * Math.cos(rad), c * Math.sin(rad)))), alpha);
    }
    case "hwb": {
      const [h, w, b] = [hue(parts[0]!), component(parts[1]!, 100), component(parts[2]!, 100)];
      if (h === undefined || w === undefined || b === undefined) return undefined;
      let [white, black] = [w / 100, b / 100];
      if (white + black >= 1) {
        const gray = white / (white + black);
        return rgba([gray, gray, gray], alpha);
      }
      const base = hslToRgb(h, 1, 0.5);
      return rgba(base.map((c) => c * (1 - white - black) + white) as [number, number, number], alpha);
    }
  }
  return undefined;
}

/** `color-mix(in <space>, <color> [p%], <color> [p%])`, interpolated with premultiplied alpha. */
function colorMix(args: string, parse: (v: string) => Rgba | undefined): Rgba | undefined {
  const list = splitComma(args);
  if (list.length !== 3) return undefined;
  const space = /^in\s+([-\w]+)/i.exec(list[0]!.trim())?.[1]?.toLowerCase();
  if (!space) return undefined;
  const entry = (text: string) => {
    const m = /^(.*?)(?:\s+(\d*\.?\d+)%)?$/s.exec(text.trim())!;
    const lead = /^(\d*\.?\d+)%\s+(.*)$/s.exec(text.trim());
    const colorText = lead ? lead[2]! : m[1]!;
    const pct = lead ? Number(lead[1]) : m[2] === undefined ? undefined : Number(m[2]);
    return { color: parse(colorText), pct };
  };
  const a = entry(list[1]!);
  const b = entry(list[2]!);
  if (!a.color || !b.color) return undefined;
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 === undefined && p2 === undefined) p1 = p2 = 50;
  else if (p1 === undefined) p1 = 100 - p2!;
  else if (p2 === undefined) p2 = 100 - p1;
  const total = p1 + p2!;
  if (total <= 0) return undefined;
  const t = p2! / total;
  // A total below 100% scales the result's alpha.
  const alphaScale = Math.min(1, total / 100);
  const toSpace = space === "oklab" || space === "oklch" ? (c: Rgba) => linearToOklab(linearize([c[0], c[1], c[2]])) : (c: Rgba) => [c[0], c[1], c[2]] as [number, number, number];
  const fromSpace = space === "oklab" || space === "oklch" ? (c: [number, number, number]) => gamma(oklabToLinear(...c)) : (c: [number, number, number]) => c;
  const ca = toSpace(a.color);
  const cb = toSpace(b.color);
  const alpha = a.color[3] * (1 - t) + b.color[3] * t;
  if (alpha === 0) return [0, 0, 0, 0];
  const mixed = ca.map((x, i) => (x * a.color![3] * (1 - t) + cb[i]! * b.color![3] * t) / alpha) as [number, number, number];
  return rgba(fromSpace(mixed), alpha * alphaScale);
}

function splitComma(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function splitAlpha(body: string): [string, string | undefined] {
  const slash = body.lastIndexOf("/");
  if (slash !== -1) return [body.slice(0, slash), body.slice(slash + 1).trim()];
  // Legacy comma syntax with a fourth value.
  const parts = body.split(",");
  return parts.length === 4 ? [parts.slice(0, 3).join(","), parts[3]!.trim()] : [body, undefined];
}

/** A number or percentage, where 100% = `full`; `none` is 0. */
function component(text: string, full: number): number | undefined {
  const t = text.trim().toLowerCase();
  if (t === "none") return 0;
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(%?)$/.exec(t);
  if (!m) return undefined;
  return m[2] ? (Number(m[1]) / 100) * full : Number(m[1]);
}

function hue(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (t === "none") return 0;
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(deg|grad|rad|turn)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case "grad": return n * 0.9;
    case "rad": return (n * 180) / Math.PI;
    case "turn": return n * 360;
    default: return n;
  }
}

function rgba([r, g, b]: [number, number, number], a: number): Rgba {
  const clamp = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
  return [clamp(r), clamp(g), clamp(b), clamp(a)];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

function linearize(c: [number, number, number]): [number, number, number] {
  return c.map((x) => {
    const s = Math.sign(x);
    const v = Math.abs(x);
    return v <= 0.04045 ? x / 12.92 : s * ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function gamma(c: [number, number, number]): [number, number, number] {
  return c.map((x) => {
    const s = Math.sign(x);
    const v = Math.abs(x);
    return v <= 0.0031308 ? x * 12.92 : s * (1.055 * v ** (1 / 2.4) - 0.055);
  }) as [number, number, number];
}

function oklabToLinear(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** CIE Lab (D50) to XYZ, adapted to D65 with the Bradford transform. */
function labToXyzD65(l: number, a: number, b: number): [number, number, number] {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const x = (fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * 0.3457 / 0.3585;
  const y = l > k * e ? fy ** 3 : l / k;
  const z = (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * (1 - 0.3457 - 0.3585) / 0.3585;
  return [
    0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z,
    -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z,
    0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z,
  ];
}

function xyzToLinearSrgb([x, y, z]: [number, number, number]): [number, number, number] {
  return [
    3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
    0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z,
  ];
}

function p3ToXyz([r, g, b]: [number, number, number]): [number, number, number] {
  return [
    0.4865709486482162 * r + 0.26566769316909306 * g + 0.1982172852343625 * b,
    0.2289745640697488 * r + 0.6917385218365064 * g + 0.079286914093745 * b,
    0.0 * r + 0.04511338185890264 * g + 1.043944368900976 * b,
  ];
}

/** CSS named colors (CSS Color 4). */
export const NAMED_COLORS: Record<string, string> = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff", beige: "f5f5dc",
  bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff", blueviolet: "8a2be2", brown: "a52a2a",
  burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00", chocolate: "d2691e", coral: "ff7f50",
  cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c", cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b",
  darkgoldenrod: "b8860b", darkgray: "a9a9a9", darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b",
  darkmagenta: "8b008b", darkolivegreen: "556b2f", darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000",
  darksalmon: "e9967a", darkseagreen: "8fbc8f", darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f",
  darkturquoise: "00ced1", darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969",
  dimgrey: "696969", dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22",
  fuchsia: "ff00ff", gainsboro: "dcdcdc", ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4", indianred: "cd5c5c",
  indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa", lavenderblush: "fff0f5", lawngreen: "7cfc00",
  lemonchiffon: "fffacd", lightblue: "add8e6", lightcoral: "f08080", lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2",
  lightgray: "d3d3d3", lightgreen: "90ee90", lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a",
  lightseagreen: "20b2aa", lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899",
  lightsteelblue: "b0c4de", lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6", magenta: "ff00ff",
  maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd", mediumorchid: "ba55d3", mediumpurple: "9370db",
  mediumseagreen: "3cb371", mediumslateblue: "7b68ee", mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc",
  mediumvioletred: "c71585", midnightblue: "191970", mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5",
  navajowhite: "ffdead", navy: "000080", oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23", orange: "ffa500",
  orangered: "ff4500", orchid: "da70d6", palegoldenrod: "eee8aa", palegreen: "98fb98", paleturquoise: "afeeee",
  palevioletred: "db7093", papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f", pink: "ffc0cb", plum: "dda0dd",
  powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399", red: "ff0000", rosybrown: "bc8f8f", royalblue: "4169e1",
  saddlebrown: "8b4513", salmon: "fa8072", sandybrown: "f4a460", seagreen: "2e8b57", seashell: "fff5ee", sienna: "a0522d",
  silver: "c0c0c0", skyblue: "87ceeb", slateblue: "6a5acd", slategray: "708090", slategrey: "708090", snow: "fffafa",
  springgreen: "00ff7f", steelblue: "4682b4", tan: "d2b48c", teal: "008080", thistle: "d8bfd8", tomato: "ff6347",
  turquoise: "40e0d0", violet: "ee82ee", wheat: "f5deb3", white: "ffffff", whitesmoke: "f5f5f5", yellow: "ffff00",
  yellowgreen: "9acd32", transparent: "00000000",
};
