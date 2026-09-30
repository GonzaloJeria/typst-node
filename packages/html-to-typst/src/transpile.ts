import { parse } from "parse5";
import { Cascade } from "./css/cascade.js";
import { parseStylesheet, type Declaration } from "./css/parse.js";
import { expandBox, parseColor, parseFontSize, parseGradient, parseLength, splitValue, type LengthContext } from "./css/values.js";
import { Converter, lineGap, type ConvertOptions } from "./convert.js";
import { attr, findAll, findFirst, isText } from "./dom.js";
import { emitDocument } from "./emit.js";
import type { Block, Document, Inline, Length, MarginBand, MarginBox, PageSetup, Paint, TextStyle } from "./ir.js";

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
}

export function htmlToTypst(html: string, options: TranspileOptions = {}): TranspileResult {
  const doc = parse(html);
  // Minimal user-agent defaults for presentational tags not mapped to IR nodes.
  const sheet = parseStylesheet(UA_CSS);
  for (const style of findAll(doc, "style")) {
    parseStylesheet(style.childNodes.filter(isText).map((t) => t.value).join(""), sheet);
  }
  if (options.css) parseStylesheet(options.css, sheet);

  const htmlEl = findFirst(doc, "html")!;
  const body = findFirst(doc, "body")!;
  const cascade = new Cascade(sheet, options.rootFontSize ?? 12);
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
  const leading = lineGap(converter.baseLineHeight, bodyStyle);
  if (leading && converter.baseLineHeight && converter.baseLineHeight !== "normal") document.leading = leading;
  const ctx = { fontSize: bodyStyle.fontSize, rootFontSize: cascade.rootFontSize };
  const page = pageSetup(sheet.page, ctx, converter.warnings) ?? {};
  // Paged media paints the canvas with the root/body background.
  const fill = page.fill ?? paintOf(bodyStyle.own) ?? paintOf(htmlStyle.own);
  if (fill) page.fill = fill;
  const bandsOf = (boxes: Record<string, Declaration[]>) => marginBands(boxes, converter, bodyStyle.fontSize, cascade.rootFontSize);
  const bands = bandsOf(sheet.pageBoxes);
  if (bands.header) page.header = bands.header;
  if (bands.footer) page.footer = bands.footer;
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

  const warnings = [...converter.warnings, ...cascade.warnings];
  if (options.strict && warnings.length) throw new TranspileError(warnings);

  const assets = [...new Set(findAll(doc, "img").map((img) => attr(img, "src")).filter((s): s is string => !!s))];
  return { source: emitDocument(document), document, warnings, assets };
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
    if (b.kind === "box" || b.kind === "styled-block" || b.kind === "place" || b.kind === "transform" || b.kind === "pad") {
      b.children = resolveRuns(b.children, false, setupOf, warnings);
    }
    if (b.kind === "list") b.items = b.items.map((i) => resolveRuns(i, false, setupOf, warnings));
    if (b.kind === "grid") b.cells = b.cells.map((c) => resolveRuns(c, false, setupOf, warnings));
    if (b.kind === "table") {
      for (const rows of [b.header, b.body, b.footer]) {
        for (const row of rows ?? []) for (const cell of row.cells) cell.children = resolveRuns(cell.children, false, setupOf, warnings);
      }
    }
    return [b];
  });
}

const UA_CSS = `
  small { font-size: smaller }
  big { font-size: larger }
  mark { background-color: yellow }
  center { text-align: center }
`;

const PAPER: Record<string, string> = {
  a3: "a3", a4: "a4", a5: "a5", b4: "iso-b4", b5: "iso-b5", letter: "us-letter", legal: "us-legal", ledger: "us-tabloid",
};

function pageSetup(decls: Declaration[], ctx: LengthContext, warnings: Set<string>, first = false): PageSetup | undefined {
  const page: PageSetup = {};
  for (const d of decls) {
    if (first && !/^background/.test(d.property)) {
      warnings.add(`Unsupported @page :first property ignored: ${d.property} (only backgrounds and margin boxes)`);
      continue;
    }
    if (d.property === "size") {
      const tokens = splitValue(d.value.toLowerCase());
      for (const t of tokens) {
        if (t === "landscape") page.flipped = true;
        else if (t === "portrait" || t === "auto") continue;
        else if (PAPER[t]) page.paper = PAPER[t];
      }
      const lengths = tokens.map((t) => parseLength(t, ctx)).filter((l): l is Length => !!l && l.unit !== "%");
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
      }
    } else if (/^background(-color|-image)?$/.test(d.property)) {
      const fill = paintOf(new Map([[d.property === "background-color" ? "background-color" : "background-image", d.value]]))
        ?? paintOf(new Map([["background-color", splitValue(d.value).find((t) => parseColor(t)) ?? ""]]));
      if (fill) page.fill = fill;
      else warnings.add(`Unsupported @page value ignored: ${d.property}: ${d.value}`);
    } else if (/^margin-(top|right|bottom|left)$/.test(d.property)) {
      const l = parseLength(d.value, ctx);
      if (l && l.unit !== "%") page.margin = { ...page.margin, [d.property.slice(7)]: l };
    } else {
      warnings.add(`Unsupported @page property ignored: ${d.property}`);
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
