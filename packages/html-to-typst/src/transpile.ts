import { parse } from "parse5";
import { Cascade } from "./css/cascade.js";
import { parseStylesheet, type Declaration } from "./css/parse.js";
import { expandBox, parseColor, parseLength, splitValue, type LengthContext } from "./css/values.js";
import { Converter, type ConvertOptions } from "./convert.js";
import { attr, findAll, findFirst, isText } from "./dom.js";
import { emitDocument } from "./emit.js";
import type { Document, Length, PageSetup, TextStyle } from "./ir.js";

export interface TranspileOptions extends ConvertOptions {
  /** Extra CSS applied after the document's own `<style>` elements. */
  css?: string;
  /** Root font size in pt (browser default: 16px = 12pt). */
  rootFontSize?: number;
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

  const document: Document = { text, children: converter.blocks(body, bodyStyle) };
  const page = pageSetup(sheet.page, { fontSize: bodyStyle.fontSize, rootFontSize: cascade.rootFontSize }, converter.warnings);
  if (page) document.page = page;
  const lang = attr(htmlEl, "lang")?.split("-")[0]?.toLowerCase();
  if (lang && /^[a-z]{2,3}$/.test(lang)) document.lang = lang;

  const assets = [...new Set(findAll(doc, "img").map((img) => attr(img, "src")).filter((s): s is string => !!s))];
  return { source: emitDocument(document), document, warnings: [...converter.warnings], assets };
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

function pageSetup(decls: Declaration[], ctx: LengthContext, warnings: Set<string>): PageSetup | undefined {
  const page: PageSetup = {};
  for (const d of decls) {
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
    } else if (/^margin-(top|right|bottom|left)$/.test(d.property)) {
      const l = parseLength(d.value, ctx);
      if (l && l.unit !== "%") page.margin = { ...page.margin, [d.property.slice(7)]: l };
    } else {
      warnings.add(`Unsupported @page property ignored: ${d.property}`);
    }
  }
  return Object.keys(page).length ? page : undefined;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
