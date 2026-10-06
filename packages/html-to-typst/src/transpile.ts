import { parse } from "parse5";
import { Cascade } from "./css/cascade.js";
import { parseStylesheet, type Declaration, type Stylesheet } from "./css/parse.js";
import { expandBox, parseColor, parseFontSize, parseGradient, parseLength, splitValue, toPt, type LengthContext } from "./css/values.js";
import type { MediaContext } from "./css/conditions.js";
import { backgroundImage, borderStroke, Converter, lineHeightOf, type ConvertOptions } from "./convert.js";
import { expandShorthand } from "./css/cascade.js";
import { attr, findAll, findFirst, isText } from "./dom.js";
import { emitDocument } from "./emit.js";
import { mapImages } from "./walk.js";
import type { Block, Document, Inline, Length, MarginBand, MarginBox, PageSetup, Paint, Sides, Stroke, TextStyle } from "./ir.js";

export interface TranspileOptions extends ConvertOptions {
  /** Extra CSS applied after the document's own `<style>` elements. */
  css?: string;
  /** Root font size in pt (browser default: 16px = 12pt). */
  rootFontSize?: number;
  /** Throw a `TranspileError` instead of returning warnings. Default: false. */
  strict?: boolean;
}

/** Thrown in strict mode when the input uses HTML/CSS that cannot be rendered faithfully. */
export class TranspileError extends Error {
  override name = "TranspileError";
  constructor(readonly warnings: string[]) {
    super(`HTML/CSS not fully supported:\n- ${warnings.join("\n- ")}`);
  }
}

export interface TranspileResult {
  /** Typst source ready for `typst-compiler`. */
  source: string;
  /** The intermediate representation, for inspection and tests. */
  document: Document;
  /** Everything that was dropped or approximated. */
  warnings: string[];
  /** Image sources referenced by the document, to resolve into virtual files. */
  assets: string[];
  /** Fonts declared with `@font-face` that Typst can load (TTF/OTF): CSS family and URL. */
  fontFaces: FontFace[];
}

export interface FontFace {
  family: string;
  url: string;
}

/** Picks the TrueType/OpenType source of each `@font-face`; Typst cannot read WOFF. */
function usableFontFaces(faces: Stylesheet["fontFaces"], warnings: Set<string>): FontFace[] {
  const out: FontFace[] = [];
  for (const face of faces) {
    const src = face.sources.find((s) =>
      s.format ? /^(truetype|opentype)$/.test(s.format) : !/\.woff2?(?:[?#]|$)|^data:(?:font|application)\/(?:x-)?font-woff/i.test(s.url),
    );
    if (src) out.push({ family: face.family, url: src.url });
    else warnings.add(`@font-face ${face.family} ignored: only TTF and OTF fonts are supported (not WOFF/WOFF2)`);
  }
  return out;
}

export function htmlToTypst(html: string, options: TranspileOptions = {}): TranspileResult {
  const doc = parse(html);
  // Minimal user-agent defaults for presentational tags not mapped to IR nodes.
  // User-agent rules go in the first (weakest) cascade layer, below every author rule.
  const sheet = parseStylesheet(`@layer user-agent { ${UA_CSS} }`);
  for (const style of findAll(doc, "style")) {
    parseStylesheet(style.childNodes.filter(isText).map((t) => t.value).join(""), sheet);
  }
  if (options.css) parseStylesheet(options.css, sheet);

  const htmlEl = findFirst(doc, "html")!;
  const body = findFirst(doc, "body")!;
  const rootFontSize = options.rootFontSize ?? 12;
  const media = pageMedia(sheet.page, rootFontSize);
  const cascade = new Cascade(sheet, rootFontSize, media, pageArea(sheet.page, media, rootFontSize, hasMarginBoxes(sheet)));
  const converter = new Converter(cascade, options);

  const htmlStyle = converter.style(htmlEl, undefined);
  const bodyStyle = converter.style(body, htmlStyle);

  const text: TextStyle = { size: { value: round(bodyStyle.fontSize), unit: "pt" } };
  const font = converter.fontFamily(bodyStyle.props.get("font-family") ?? "");
  if (font.length) text.font = font;
  const color = parseColor(bodyStyle.props.get("color") ?? "");
  if (color) text.fill = color;

  converter.baseLineHeight = bodyStyle.props.get("line-height");
  const document: Document = { text, children: converter.blocks(body, bodyStyle) };
  const lineHeight = lineHeightOf(converter.baseLineHeight, bodyStyle);
  if (lineHeight !== undefined && lineHeight !== "normal") document.lineHeight = lineHeight;
  const ctx = { fontSize: bodyStyle.fontSize, rootFontSize: cascade.rootFontSize };
  const page = pageSetup(sheet.page, ctx, converter.warnings) ?? {};
  // Paged media paints the canvas with the root/body background.
  const fill = page.fill ?? paintOf(bodyStyle.own) ?? paintOf(htmlStyle.own);
  if (fill) page.fill = fill;
  const bandsOf = (boxes: Record<string, Declaration[]>) => marginBands(boxes, converter, bodyStyle.fontSize, cascade.rootFontSize);
  const bands = bandsOf(sheet.pageBoxes);
  if (bands.header) page.header = bands.header;
  if (bands.footer) page.footer = bands.footer;
  // Margin boxes live in the page margin: without one there is no room for them.
  for (const [band, side] of [["header", "top"], ["footer", "bottom"]] as const) {
    if (bands[band] && page.margin?.[side]?.value === 0) {
      converter.warnings.add(`@page ${side} margin boxes are not drawn: margin-${side} is 0`);
    }
  }
  // Without `@page { margin }` the page has none, as in Chrome's page.pdf()
  // (Puppeteer, Playwright), unless there are margin boxes to make room for.
  if (!hasMarginBoxes(sheet)) page.margin = { ...NO_MARGIN, ...page.margin };
  const first = sheet.namedPages[":first"];
  if (first) {
    const setup = pageSetup(first.page, ctx, converter.warnings, true);
    const fb = bandsOf({ ...sheet.pageBoxes, ...first.pageBoxes });
    page.first = {};
    if (setup?.fill) page.first.fill = setup.fill;
    if (!same(fb.header, bands.header)) page.first.header = fb.header ?? null;
    if (!same(fb.footer, bands.footer)) page.first.footer = fb.footer ?? null;
    if (!Object.keys(page.first).length) delete page.first;
  }
  // Named pages: each run overrides the default setup where its @page rule says so.
  document.children = resolveRuns(document.children, true, (name) => {
    const rule = sheet.namedPages[name];
    if (!rule) return undefined;
    const setup = pageSetup(rule.page, ctx, converter.warnings) ?? {};
    const nb = bandsOf({ ...sheet.pageBoxes, ...rule.pageBoxes });
    if (!same(nb.header, bands.header)) setup.header = nb.header ?? null;
    if (!same(nb.footer, bands.footer)) setup.footer = nb.footer ?? null;
    return Object.keys(setup).length ? setup : undefined;
  }, converter.warnings);
  for (const selector of Object.keys(sheet.namedPages)) {
    if (/.:first$/.test(selector)) converter.warnings.add(`Unsupported @page selector ignored: @page ${selector}`);
  }
  if (converter.foreground.length) page.foreground = converter.foreground;
  if (Object.keys(page).length) document.page = page;
  for (const w of sheet.warnings) converter.warnings.add(w);
  const lang = attr(htmlEl, "lang")?.split("-")[0]?.toLowerCase();
  if (lang && /^[a-z]{2,3}$/.test(lang)) document.lang = lang;

  const fontFaces = usableFontFaces(sheet.fontFaces, converter.warnings);
  const warnings = [...new Set([...converter.warnings, ...cascade.warnings])];
  if (options.strict && warnings.length) throw new TranspileError(warnings);

  // Every image the document references: <img> and CSS background images.
  const found = new Set<string>();
  mapImages(document, (src) => (found.add(src), src));
  const assets = [...found];
  return { source: emitDocument(document), document, warnings, assets, fontFaces };
}

/**
 * Attaches named page setups to page runs. A page setup can only change
 * between top-level blocks, so runs nested in styled containers are unwrapped.
 */
function resolveRuns(
  blocks: Block[],
  topLevel: boolean,
  setupOf: (name: string) => PageSetup | undefined,
  warnings: Set<string>,
): Block[] {
  return blocks.flatMap((b): Block[] => {
    if (b.kind === "page-run") {
      const children = resolveRuns(b.children, topLevel, setupOf, warnings);
      if (!topLevel) {
        warnings.add(`page: ${b.name} ignored: named pages only apply to top-level elements (not inside styled containers)`);
        return children;
      }
      const page = b.name ? setupOf(b.name) : undefined;
      return [{ ...b, ...(page ? { page } : {}), children }];
    }
    if (b.kind === "box" || b.kind === "styled-block" || b.kind === "keep" || b.kind === "place" || b.kind === "transform" || b.kind === "pad" || b.kind === "columns") {
      b.children = resolveRuns(b.children, false, setupOf, warnings);
    }
    if (b.kind === "list") b.items = b.items.map((i) => resolveRuns(i, false, setupOf, warnings));
    if (b.kind === "grid") b.cells = b.cells.map((c) => resolveRuns(c, false, setupOf, warnings));
    if (b.kind === "flow") for (const item of b.items) item.children = resolveRuns(item.children, false, setupOf, warnings);
    if (b.kind === "table") {
      for (const rows of [b.header, b.body, b.footer]) {
        for (const row of rows ?? []) for (const cell of row.cells) cell.children = resolveRuns(cell.children, false, setupOf, warnings);
      }
    }
    return [b];
  });
}

/** Browser defaults (Chrome's user-agent stylesheet) for what the converter does not hard-code. */
const UA_CSS = `
  h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0 }
  h2 { font-size: 1.5em; font-weight: bold; margin: 0.83em 0 }
  h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0 }
  h4 { font-size: 1em; font-weight: bold; margin: 1.33em 0 }
  h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0 }
  h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0 }
  p, ul, ol, dl, pre, figure { margin: 1em 0 }
  ul, ol { padding-left: 40px }
  li ul, li ol { margin: 0 }
  blockquote { margin: 1em 40px }
  hr { margin: 0.5em 0 }
  small { font-size: smaller }
  big { font-size: larger }
  mark { background-color: yellow }
  center { text-align: center }
`;

const PAPER: Record<string, string> = {
  a3: "a3", a4: "a4", a5: "a5", a6: "a6", b4: "iso-b4", b5: "iso-b5", "jis-b4": "jis-b4", "jis-b5": "jis-b5",
  letter: "us-letter", legal: "us-legal", ledger: "us-tabloid",
};

/** Paper sizes in mm (width × height, portrait). */
const PAPER_MM: Record<string, [number, number]> = {
  a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], "iso-b4": [250, 353], "iso-b5": [176, 250],
  "jis-b4": [257, 364], "jis-b5": [182, 257], "us-letter": [215.9, 279.4], "us-legal": [215.9, 355.6], "us-tabloid": [279.4, 431.8],
};

/** The page box in CSS px, which media queries are evaluated against (as Chrome does when printing). */
function pageMedia(decls: Declaration[], rootFontSize: number): MediaContext {
  const page = pageSetup(decls.filter((d) => d.property === "size"), { fontSize: rootFontSize, rootFontSize }, new Set()) ?? {};
  const pt = (l: Length | undefined) => (l && toPt(l)) ?? undefined;
  let [w, h] = (PAPER_MM[page.paper ?? "a4"] ?? PAPER_MM.a4!).map((mm) => (mm * 72) / 25.4) as [number, number];
  if (page.width) [w, h] = [pt(page.width) ?? w, pt(page.height) ?? h];
  if (page.flipped) [w, h] = [h, w];
  return { width: (w * 4) / 3, height: (h * 4) / 3 };
}

function hasMarginBoxes(sheet: Stylesheet): boolean {
  return Object.keys({ ...sheet.pageBoxes, ...sheet.namedPages[":first"]?.pageBoxes }).length > 0;
}

const ZERO: Length = { value: 0, unit: "pt" };
const NO_MARGIN = { top: ZERO, right: ZERO, bottom: ZERO, left: ZERO };

/** The page area in pt (the page box minus its margins): what viewport units measure when printing. */
function pageArea(decls: Declaration[], media: MediaContext, rootFontSize: number, boxes: boolean): { width: number; height: number } {
  const m = pageSetup(decls.filter((d) => /^margin/.test(d.property)), { fontSize: rootFontSize, rootFontSize }, new Set())?.margin ?? {};
  // Typst's default margin (2.5/21 of the shorter side) where margin boxes need room.
  const fallback = boxes ? ((2.5 / 21) * Math.min(media.width, media.height) * 3) / 4 : 0;
  const pt = (l: Length | undefined) => (l ? toPt(l) ?? 0 : fallback);
  return {
    width: (media.width * 3) / 4 - pt(m.left) - pt(m.right),
    height: (media.height * 3) / 4 - pt(m.top) - pt(m.bottom),
  };
}

function pageSetup(decls: Declaration[], ctx: LengthContext, warnings: Set<string>, first = false): PageSetup | undefined {
  const page: PageSetup = {};
  const background = new Map<string, string>();
  const frame = new Map<string, string>();
  for (const d of decls) {
    if (first && !/^background/.test(d.property)) {
      warnings.add(`Unsupported @page :first property ignored: ${d.property} (only backgrounds and margin boxes)`);
      continue;
    }
    if (d.property === "size") {
      const tokens = splitValue(d.value.toLowerCase());
      const lengths: Length[] = [];
      for (const t of tokens) {
        const l = parseLength(t, ctx);
        if (t === "landscape") page.flipped = true;
        else if (t === "portrait" || t === "auto") continue;
        else if (PAPER[t]) page.paper = PAPER[t];
        else if (l && l.unit !== "%") lengths.push(l);
        else warnings.add(`Unsupported @page size ignored: ${t}`);
      }
      if (lengths.length >= 1) {
        page.width = lengths[0]!;
        page.height = lengths[1] ?? lengths[0]!;
        delete page.paper;
      }
    } else if (d.property === "margin") {
      const box = expandBox(splitValue(d.value));
      const ls = box?.map((v) => parseLength(v, ctx));
      if (ls && ls.every((l) => l && l.unit !== "%")) {
        page.margin = { top: ls[0]!, right: ls[1]!, bottom: ls[2]!, left: ls[3]! };
      } else warnings.add(`Unsupported @page margin ignored: ${d.value}`);
    } else if (/^background(-color|-image|-size|-position|-repeat)?$/.test(d.property)) {
      for (const [p, v] of expandShorthand(d.property, d.value)) background.set(p, v);
    } else if (/^(border|padding)(-(top|right|bottom|left))?(-(width|style|color))?$/.test(d.property)) {
      // A frame around the page area, with padding inside it (CSS paged media).
      for (const [p, v] of expandShorthand(d.property, d.value)) frame.set(p, v);
    } else if (/^margin-(top|right|bottom|left)$/.test(d.property)) {
      const l = parseLength(d.value, ctx);
      if (l && l.unit !== "%") page.margin = { ...page.margin, [d.property.slice(7)]: l };
      else warnings.add(`Unsupported @page ${d.property} ignored: ${d.value}`);
    } else {
      warnings.add(`Unsupported @page property ignored: ${d.property}`);
    }
  }
  if (frame.size) {
    const sidesOf = <T>(f: (side: "top" | "right" | "bottom" | "left") => T | undefined): Sides<T> | undefined => {
      const out: Sides<T> = {};
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const v = f(side);
        if (v !== undefined) out[side] = v;
      }
      return Object.keys(out).length ? out : undefined;
    };
    const stroke = sidesOf<Stroke>((side) => borderStroke(frame, side, ctx));
    const padding = sidesOf<Length>((side) => {
      const l = parseLength(frame.get(`padding-${side}`) ?? "", ctx);
      return l && l.unit !== "%" && l.value > 0 ? l : undefined;
    });
    if (stroke || padding) page.frame = { ...(stroke ? { stroke } : {}), ...(padding ? { padding } : {}) };
  }
  if (background.size) {
    const fill = paintOf(background);
    if (fill) page.fill = fill;
    const image = backgroundImage(background, ctx);
    if (image) page.image = image;
    const repeat = background.get("background-repeat");
    if (background.has("background-other") || (repeat && repeat !== "no-repeat") || (!fill && !image)) {
      warnings.add(`Unsupported @page background ignored: ${[...background.values()].join(" ")}`);
    }
  }
  return Object.keys(page).length ? page : undefined;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function paintOf(props: ReadonlyMap<string, string>): Paint | undefined {
  const gradient = parseGradient(props.get("background-image") ?? "");
  if (gradient) return gradient;
  const color = parseColor(props.get("background-color") ?? "");
  return color && color !== "#00000000" ? color : undefined;
}

const BAND_SLOTS: Record<string, ["header" | "footer", keyof MarginBand]> = {
  "top-left": ["header", "left"], "top-center": ["header", "center"], "top-right": ["header", "right"],
  "bottom-left": ["footer", "left"], "bottom-center": ["footer", "center"], "bottom-right": ["footer", "right"],
};

/** Builds header/footer bands from `@page` margin boxes. */
function marginBands(
  boxes: Record<string, Declaration[]>,
  converter: Converter,
  bodySize: number,
  rootSize: number,
): { header?: MarginBand; footer?: MarginBand } {
  const out: { header?: MarginBand; footer?: MarginBand } = {};
  for (const [name, decls] of Object.entries(boxes)) {
    const slot = BAND_SLOTS[name];
    if (!slot) {
      converter.warnings.add(`Unsupported @page margin box ignored: @${name}`);
      continue;
    }
    const box = marginBox(decls, converter, bodySize, rootSize);
    if (box) (out[slot[0]] ??= {})[slot[1]] = box;
  }
  return out;
}

function marginBox(decls: Declaration[], converter: Converter, bodySize: number, rootSize: number): MarginBox | undefined {
  const get = (p: string) => decls.filter((d) => d.property === p).at(-1)?.value;
  const content = get("content");
  if (!content || content === "none" || content === "normal") return undefined;

  const box: MarginBox = {};
  const inlines: Inline[] = [];
  let blocks: Block[] | undefined;
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|counter\(\s*(page|pages)\s*\)|element\(\s*([-\w]+)\s*\)|(\S+\([^)]*\)|\S+)/g;
  for (const m of content.matchAll(re)) {
    const text = m[1] ?? m[2];
    if (text !== undefined) inlines.push({ kind: "text", value: text.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, h: string | undefined, c: string | undefined) => (h ? String.fromCodePoint(parseInt(h, 16)) : c!)) });
    else if (m[3]) inlines.push({ kind: "page-counter", which: m[3] as "page" | "pages" });
    else if (m[4]) {
      blocks = converter.running.get(m[4]);
      if (!blocks) converter.warnings.add(`No element with position: running(${m[4]}) for @page margin box`);
    } else if (m[5]) converter.warnings.add(`Unsupported @page content value ignored: ${m[5]}`);
  }
  if (blocks) box.blocks = blocks;
  else if (inlines.length) box.inlines = inlines;
  else return undefined;

  const style: TextStyle = {};
  const color = parseColor(get("color") ?? "");
  if (color) style.fill = color;
  const size = get("font-size") && parseFontSize(get("font-size")!, bodySize, rootSize);
  if (size) style.size = { value: round(size), unit: "pt" };
  const weight = get("font-weight");
  if (weight === "bold" || weight === "bolder") style.weight = "bold";
  else if (weight && /^[1-9]00$/.test(weight)) style.weight = Number(weight);
  if (get("font-style") === "italic") style.style = "italic";
  const family = get("font-family");
  if (family) {
    const f = converter.fontFamily(family);
    if (f.length) style.font = f;
  }
  if (Object.keys(style).length) box.style = style;
  return box;
}
