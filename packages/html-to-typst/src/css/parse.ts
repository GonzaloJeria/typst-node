/**
 * CSS parser: style rules (with CSS nesting), `@page`, `@media`, `@supports`,
 * `@layer` and `@property`. Media queries are kept on the rules and evaluated
 * by the cascade, which knows the page size; `@supports` is decided here.
 */
import { supportsCondition } from "./conditions.js";

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

export interface StyleRule {
  selectors: string[];
  declarations: Declaration[];
  /** Cascade layer index into `Stylesheet.layers`; undefined when unlayered. */
  layer?: number;
  /** Media queries that must all match for the rule to apply. */
  media?: string[];
}

export interface RegisteredProperty {
  inherits: boolean;
  initial?: string;
}

export interface Stylesheet {
  rules: StyleRule[];
  page: Declaration[];
  /** `@page` margin boxes by name, e.g. `top-center` → declarations. */
  pageBoxes: Record<string, Declaration[]>;
  /** `@page name`, `@page :first` and `@page name:first` rules, by selector. */
  namedPages: Record<string, PageRule>;
  /** Layer names in cascade order (earlier = weaker). */
  layers: string[];
  /** Custom properties registered with `@property`. */
  properties: Record<string, RegisteredProperty>;
  /** `@font-face` rules: a family name and its `src` URLs with their formats. */
  fontFaces: { family: string; sources: { url: string; format?: string }[] }[];
  warnings: string[];
}

export interface PageRule {
  page: Declaration[];
  pageBoxes: Record<string, Declaration[]>;
}

export function emptyStylesheet(): Stylesheet {
  return { rules: [], page: [], pageBoxes: {}, namedPages: {}, layers: [], properties: {}, fontFaces: [], warnings: [] };
}

export function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of splitTopLevel(text, ";")) {
    const i = part.indexOf(":");
    if (i === -1) continue;
    const property = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    // Custom properties are case-sensitive and may be empty (`--x: ;`).
    if (property.startsWith("--")) out.push({ property, value, important });
    else if (property && value) out.push({ property: property.toLowerCase(), value, important });
  }
  return out;
}

interface Context {
  /** Selectors of the enclosing style rule, for nested rules and `&`. */
  selectors?: string[];
  layer?: string;
  media: string[];
}

let anonymousLayers = 0;

export function parseStylesheet(css: string, into: Stylesheet = emptyStylesheet()): Stylesheet {
  parseBlock(css.replace(/\/\*[\s\S]*?\*\//g, ""), into, { media: [] });
  return into;
}

/** Parses a block's items: declarations (inside a style rule), nested rules and at-rules. */
function parseBlock(src: string, into: Stylesheet, ctx: Context): void {
  let decls = "";
  const flush = () => {
    if (ctx.selectors && decls.trim()) addRule(into, ctx, ctx.selectors, parseDeclarations(decls));
    decls = "";
  };
  for (const item of blockItems(src)) {
    if (item.body === undefined) {
      const text = item.prelude.trim();
      if (text.startsWith("@")) statementAtRule(text, into, ctx);
      else decls += `${item.prelude};`;
      continue;
    }
    flush();
    const prelude = item.prelude.trim();
    if (prelude.startsWith("@")) atRule(prelude, item.body, into, ctx);
    else {
      const own = splitTopLevel(prelude, ",").map((s) => s.trim()).filter(Boolean);
      const selectors = ctx.selectors ? own.flatMap((s) => nestSelector(s, ctx.selectors!)) : own;
      if (selectors.length) parseBlock(item.body, into, { ...ctx, selectors });
    }
  }
  flush();
}

function addRule(into: Stylesheet, ctx: Context, selectors: string[], declarations: Declaration[]): void {
  if (!declarations.length) return;
  const rule: StyleRule = { selectors, declarations };
  if (ctx.layer !== undefined) rule.layer = layerIndex(into, ctx.layer);
  if (ctx.media.length) rule.media = ctx.media;
  into.rules.push(rule);
}

function layerIndex(into: Stylesheet, name: string): number {
  const i = into.layers.indexOf(name);
  return i === -1 ? into.layers.push(name) - 1 : i;
}

function layerName(ctx: Context, name: string): string {
  return ctx.layer === undefined ? name : `${ctx.layer}.${name}`;
}

/** Resolves a nested selector against its parent rule's selectors. */
function nestSelector(selector: string, parents: string[]): string[] {
  // Without `&`, a nested selector (or one starting with a combinator) is relative to its parent.
  const parent = parents.length === 1 ? parents[0]! : `:is(${parents.join(", ")})`;
  if (selector.includes("&")) return [selector.replace(/&/g, parent)];
  return [`${parent} ${selector}`];
}

function statementAtRule(text: string, into: Stylesheet, ctx: Context): void {
  const m = /^@([-\w]+)\s*(.*)$/s.exec(text);
  if (m?.[1]?.toLowerCase() !== "layer") return; // @import, @charset, @namespace…
  // `@layer a, b;` only declares the order of layers.
  for (const name of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) layerIndex(into, layerName(ctx, name));
}

function atRule(prelude: string, body: string, into: Stylesheet, ctx: Context): void {
  const m = /^@([-\w]+)\s*(.*)$/s.exec(prelude);
  const name = m?.[1]?.toLowerCase() ?? "";
  const rest = m?.[2]?.trim() ?? "";
  switch (name) {
    case "media":
      return parseBlock(body, into, { ...ctx, media: [...ctx.media, rest] });
    case "supports":
      if (supportsCondition(rest)) parseBlock(body, into, ctx);
      return;
    case "layer": {
      const layer = layerName(ctx, rest || `#anonymous-${anonymousLayers++}`);
      layerIndex(into, layer);
      return parseBlock(body, into, { ...ctx, layer });
    }
    case "page": {
      const selector = rest.replace(/\s+/g, "");
      if (!selector) parsePageBody(body, into);
      else if (/^(-?[_a-zA-Z][-\w]*)?(:first)?$/i.test(selector)) {
        parsePageBody(body, (into.namedPages[selector.toLowerCase()] ??= { page: [], pageBoxes: {} }));
      } else into.warnings.push(`Unsupported @page selector ignored: @page ${selector}`);
      return;
    }
    case "property": {
      const decls = new Map(parseDeclarations(body).map((d) => [d.property.toLowerCase(), d.value]));
      const registered: RegisteredProperty = { inherits: decls.get("inherits") === "true" };
      const initial = decls.get("initial-value");
      if (initial !== undefined) registered.initial = initial;
      into.properties[rest] = registered;
      return;
    }
    case "font-face": {
      const decls = new Map(parseDeclarations(body).map((d) => [d.property.toLowerCase(), d.value]));
      const family = decls.get("font-family")?.trim().replace(/^(["'])(.*)\1$/, "$2");
      const src = decls.get("src");
      if (!family || !src) return;
      const sources = splitTopLevel(src, ",").flatMap((part) => {
        const url = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i.exec(part);
        if (!url) return [];
        const format = /format\(\s*["']?([-\w]+)["']?\s*\)/i.exec(part)?.[1]?.toLowerCase();
        return [{ url: (url[1] ?? url[2] ?? url[3])!, ...(format ? { format } : {}) }];
      });
      if (sources.length) into.fontFaces.push({ family, sources });
      return;
    }
    case "container":
      into.warnings.push(`Unsupported at-rule ignored: @container ${rest}`);
      return;
    // @font-face, @keyframes, @counter-style, @starting-style… have no effect here.
  }
}

interface BlockItem {
  prelude: string;
  /** Block contents; undefined for a declaration or statement ending in `;`. */
  body?: string;
}

/** Splits a block into `;`-terminated statements and `prelude { body }` items. */
function blockItems(src: string): BlockItem[] {
  const out: BlockItem[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === "\\") {
        cur += ch + (src[++i] ?? "");
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "\\") {
      cur += ch + (src[++i] ?? "");
      continue;
    } else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth <= 0 && ch === ";") {
      if (cur.trim()) out.push({ prelude: cur });
      cur = "";
      continue;
    } else if (depth <= 0 && ch === "{") {
      const close = matchingBrace(src, i);
      out.push({ prelude: cur, body: src.slice(i + 1, close) });
      cur = "";
      i = close;
      continue;
    } else if (ch === "}") continue; // Stray brace: skip, as browsers do.
    cur += ch;
  }
  if (cur.trim()) out.push({ prelude: cur });
  return out;
}

function matchingBrace(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === "\\") j++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "\\") j++;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return j;
  }
  return src.length;
}

/** Splits on `sep` outside parentheses and quotes. */
export function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      cur += ch + (text[++i] ?? "");
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Splits an `@page` body into its declarations and nested margin boxes. */
function parsePageBody(body: string, into: PageRule): void {
  let rest = "";
  for (const item of blockItems(body)) {
    if (item.body === undefined) rest += `${item.prelude};`;
    else {
      const name = item.prelude.trim().replace(/^@/, "").toLowerCase();
      (into.pageBoxes[name] ??= []).push(...parseDeclarations(item.body));
    }
  }
  into.page.push(...parseDeclarations(rest));
}
