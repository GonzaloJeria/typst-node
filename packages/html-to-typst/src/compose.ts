import { emitDocument } from "./emit.js";
import type { Block, Document } from "./ir.js";
import { htmlToTypst, TranspileError, type FontFace, type TranspileOptions, type TranspileResult } from "./transpile.js";

/** Page settings for a layout or a section, written as CSS values. */
export interface PageOptions {
  /** CSS `size`, e.g. `"A4"`, `"letter landscape"`, `"210mm 297mm"`. */
  size?: string;
  /** CSS `margin` shorthand, e.g. `"25mm 18mm"`. */
  margin?: string;
  /** CSS background: a color or gradient. */
  background?: string;
  /**
   * HTML repeated at the top/bottom of every page, or `false` for none.
   * `{{page}}` and `{{pages}}` become the current page and the page count.
   */
  header?: string | false;
  footer?: string | false;
}

/** Shared base for every section: styles and page decoration. */
export interface Layout {
  css?: string;
  page?: PageOptions;
}

/** A part of the document with its own content, styles and page settings. */
export interface Section {
  html: string;
  css?: string;
  /** Overrides the layout's page settings for this section. */
  page?: PageOptions;
}

export interface ComposeInput {
  layout?: Layout;
  sections: Section[];
}

/**
 * Builds one document from independent sections. Each section's CSS only
 * applies to that section, every section starts on a new page, and page
 * counters run across the whole document.
 */
export function composeToTypst(input: ComposeInput, options: TranspileOptions = {}): TranspileResult {
  if (input.sections.length === 0) throw new Error("composeToTypst: at least one section is required");
  const { strict, ...rest } = options;
  const children: Block[] = [];
  const warnings: string[] = [];
  const assets = new Set<string>();
  const fontFaces: FontFace[] = [];
  let lang: string | undefined;

  input.sections.forEach((section, i) => {
    const page = { ...input.layout?.page, ...section.page };
    const decoration = decorationHtml(page);
    const css = [pageCss(page), decoration.css, input.layout?.css, section.css, rest.css].filter(Boolean).join("\n");
    const result = htmlToTypst(injectIntoBody(section.html, decoration.html), { ...rest, css });
    const doc = result.document;
    lang ??= doc.lang;
    children.push({
      kind: "page-run",
      ...(doc.page ? { page: doc.page } : {}),
      ...(doc.text ? { text: doc.text } : {}),
      ...(doc.lineHeight !== undefined ? { lineHeight: doc.lineHeight } : {}),
      ...(doc.lang ? { lang: doc.lang } : {}),
      children: doc.children,
    });
    const label = input.sections.length > 1 ? `[section ${i + 1}] ` : "";
    for (const w of result.warnings) warnings.push(label + w);
    for (const a of result.assets) assets.add(a);
    for (const f of result.fontFaces) if (!fontFaces.some((x) => x.family === f.family && x.url === f.url)) fontFaces.push(f);
  });

  if (strict && warnings.length) throw new TranspileError(warnings);
  const document: Document = { children, ...(lang ? { lang } : {}) };
  return { source: emitDocument(document), document, warnings, assets: [...assets], fontFaces };
}

function pageCss(page: PageOptions): string {
  const decls = [
    page.size && `size: ${page.size};`,
    page.margin && `margin: ${page.margin};`,
    page.background && `background: ${page.background};`,
  ].filter(Boolean);
  return decls.length ? `@page { ${decls.join(" ")} }` : "";
}

/** Headers and footers become running elements placed in the page margin. */
function decorationHtml(page: PageOptions): { html: string; css: string } {
  let html = "";
  const css: string[] = [
    "[data-typst-counter=page]::before { content: counter(page) }",
    "[data-typst-counter=pages]::before { content: counter(pages) }",
  ];
  for (const [slot, value, edge] of [
    ["header", page.header, "top"],
    ["footer", page.footer, "bottom"],
  ] as const) {
    if (value === false) {
      css.push(`@page { @${edge}-left { content: none } @${edge}-center { content: none } @${edge}-right { content: none } }`);
    } else if (value) {
      const name = `layout-${slot}`;
      html += `<div style="position: running(${name})">${counters(value)}</div>`;
      css.push(`@page { @${edge}-center { content: element(${name}) } }`);
    }
  }
  return { html, css: css.join("\n") };
}

function counters(html: string): string {
  return html.replace(/\{\{\s*(page|pages)\s*\}\}/g, (_, which: string) => `<span data-typst-counter="${which}"></span>`);
}

function injectIntoBody(html: string, extra: string): string {
  if (!extra) return html;
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) return html.slice(0, body.index + body[0].length) + extra + html.slice(body.index + body[0].length);
  const head = /<\/head\s*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + extra + html.slice(head.index + head[0].length);
  return extra + html;
}
