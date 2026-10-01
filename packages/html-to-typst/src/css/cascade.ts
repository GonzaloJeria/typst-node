import { attr, selectorElement, type Element } from "../dom.js";
import { mediaMatches, type MediaContext } from "./conditions.js";
import { parseDeclarations, type Declaration, type Stylesheet } from "./parse.js";
import { compareSpecificity, matches, parseSelector, type Selector } from "./selector.js";
import { isValidValue, LIST_STYLES } from "./support.js";
import { expandBox, parseColor, parseFontSize, parseNumber, splitValue } from "./values.js";

/** Properties that inherit from the parent when not set (custom properties always do). */
const INHERITED = new Set([
  "color", "font-family", "font-weight", "font-style", "text-align", "line-height",
  "letter-spacing", "white-space", "list-style-type", "visibility", "text-transform",
  "font-variant-numeric", "text-indent",
]);

const SHORTHAND_BREAKS: Record<string, string> = {
  "page-break-before": "break-before",
  "page-break-after": "break-after",
  "page-break-inside": "break-inside",
};

export type PseudoElement = "before" | "after";

export interface ComputedStyle {
  /** Final value per property: own cascaded values plus inherited ones. */
  props: ReadonlyMap<string, string>;
  /** Longhands declared on this element itself (after `var()` substitution). */
  own: ReadonlyMap<string, string>;
  /** Computed font size in pt. */
  fontSize: number;
  rootFontSize: number;
  /** Page area in pt, for viewport units. */
  viewport?: { width: number; height: number };
}

interface CompiledRule {
  selector: Selector;
  declarations: Declaration[];
  /** Layer rank: earlier layers are weaker; unlayered rules rank highest. */
  layer: number;
  order: number;
}

const MAX_VAR_DEPTH = 16;

/** Pseudo-elements with no counterpart on paper: their rules are skipped silently. */
const QUIET_PSEUDO = /^(?:placeholder|selection|backdrop|file-selector-button|cue|grammar-error|spelling-error|target-text|highlight|scroll-marker|-(?:webkit|moz|ms)-.*)$/;

export class Cascade {
  /** Rules indexed by the subject's `#id`, `.class` or tag; `*` holds the rest. */
  readonly #index = new Map<string, CompiledRule[]>();
  readonly #pseudoRules: CompiledRule[] = [];
  readonly #registered: Stylesheet["properties"];
  readonly warnings: string[] = [];

  constructor(sheet: Stylesheet, readonly rootFontSize: number, media: MediaContext = A4_MEDIA, readonly viewport?: { width: number; height: number }) {
    this.#registered = sheet.properties;
    const unlayered = sheet.layers.length;
    let order = 0;
    for (const rule of sheet.rules) {
      if (rule.media && !rule.media.every((q) => mediaMatches(q, media))) continue;
      for (const text of rule.selectors) {
        const selector = parseSelector(text);
        if (!selector) {
          this.warnings.push(`Unsupported selector ignored: ${text}`);
          continue;
        }
        const pe = selector.pseudoElement;
        if (pe && pe !== "before" && pe !== "after") {
          if (!QUIET_PSEUDO.test(pe)) this.warnings.push(`Unsupported selector ignored: ${text}`);
          continue;
        }
        const compiled = { selector, declarations: rule.declarations, layer: rule.layer ?? unlayered, order: order++ };
        if (pe) this.#pseudoRules.push(compiled);
        else {
          const key = selector.key ?? "*";
          let bucket = this.#index.get(key);
          if (!bucket) this.#index.set(key, (bucket = []));
          bucket.push(compiled);
        }
      }
    }
  }

  /** True when some rule targets `::before`/`::after` of this element. */
  hasPseudo(el: Element, pseudo: PseudoElement): boolean {
    const target = selectorElement(el);
    return this.#pseudoRules.some((r) => r.selector.pseudoElement === pseudo && matches(r.selector, target));
  }

  #candidates(el: Element): CompiledRule[] {
    const out: CompiledRule[] = [...(this.#index.get("*") ?? []), ...(this.#index.get(el.tagName) ?? [])];
    const id = attr(el, "id");
    if (id) out.push(...(this.#index.get(`#${id}`) ?? []));
    for (const cls of new Set((attr(el, "class") ?? "").split(/\s+/).filter(Boolean))) out.push(...(this.#index.get(`.${cls}`) ?? []));
    return out;
  }

  /**
   * Cascades author rules and the `style` attribute for `el` (or for one of
   * its pseudo-elements, in which case `parent` is the element's own style).
   */
  compute(
    el: Element,
    parent: ComputedStyle | undefined,
    inlineStyle: string | undefined,
    pseudo?: PseudoElement,
  ): ComputedStyle {
    const target = selectorElement(el);
    const matched = (pseudo ? this.#pseudoRules.filter((r) => r.selector.pseudoElement === pseudo) : this.#candidates(el))
      .filter((r) => matches(r.selector, target));

    // Normal declarations: later layers win, unlayered last. Important ones
    // reverse the layer order. Inline styles beat both.
    const byLayer = (dir: number) => (a: CompiledRule, b: CompiledRule) =>
      dir * (a.layer - b.layer) || compareSpecificity(a.selector.specificity, b.selector.specificity) || a.order - b.order;
    const normal: Declaration[] = [];
    const important: Declaration[] = [];
    for (const r of [...matched].sort(byLayer(1))) for (const d of r.declarations) if (!d.important) normal.push(d);
    for (const r of [...matched].sort(byLayer(-1))) for (const d of r.declarations) if (d.important) important.push(d);
    const inline = inlineStyle && !pseudo ? parseDeclarations(inlineStyle) : [];
    normal.push(...inline.filter((d) => !d.important));
    important.push(...inline.filter((d) => d.important));
    const ordered = [...normal, ...important];

    // Custom properties first: they inherit (unless registered otherwise) and feed var() in everything else.
    const custom = new Map<string, string>();
    for (const [name, reg] of Object.entries(this.#registered)) {
      if (reg.initial !== undefined && (!reg.inherits || !parent)) custom.set(name, reg.initial);
    }
    if (parent) {
      for (const [p, v] of parent.props) {
        if (p.startsWith("--") && this.#registered[p]?.inherits !== false) custom.set(p, v);
      }
    }
    for (const d of ordered) {
      if (!d.property.startsWith("--")) continue;
      const reg = this.#registered[d.property];
      if (d.value === "initial" || d.value === "unset" && reg?.inherits === false) {
        if (reg?.initial !== undefined) custom.set(d.property, reg.initial);
        else custom.delete(d.property);
      } else if (d.value === "inherit" || d.value === "unset") {
        const pv = parent?.props.get(d.property);
        if (pv === undefined) custom.delete(d.property);
        else custom.set(d.property, pv);
      } else custom.set(d.property, d.value);
    }
    for (const [p, v] of custom) {
      const resolved = substituteVars(v, custom, []);
      if (resolved === undefined) custom.delete(p);
      else custom.set(p, resolved);
    }

    const own = new Map<string, string>();
    for (const d of ordered) {
      if (d.property.startsWith("--")) continue;
      const value = substituteVars(d.value, custom, this.warnings);
      // Undefined or empty var(): the declaration is invalid at computed-value time.
      if (value === undefined || value.trim() === "") continue;
      for (const [p, v] of expandShorthand(d.property, value)) {
        // A value we cannot render is dropped like an invalid declaration, so
        // an earlier fallback (`display: block; display: -webkit-box`) still applies.
        if (!d.value.includes("var(") && isValidValue(p, v) === false && own.has(p) && isValidValue(p, own.get(p)!)) {
          continue;
        }
        own.set(p, v);
      }
    }

    const props = new Map<string, string>(custom);
    if (parent) {
      for (const [p, v] of parent.props) if (INHERITED.has(p)) props.set(p, v);
    }
    for (const [p, v] of own) {
      if (v === "inherit" || (v === "unset" && INHERITED.has(p))) {
        const pv = parent?.props.get(p);
        if (pv === undefined) props.delete(p);
        else props.set(p, pv);
      } else if (v === "initial" || v === "unset" || v === "revert" || v === "revert-layer") props.delete(p);
      else props.set(p, v);
    }

    const parentSize = parent?.fontSize ?? this.rootFontSize;
    const fs = own.get("font-size");
    const fontSize = (fs && fs !== "inherit" && parseFontSize(fs, parentSize, this.rootFontSize)) || parentSize;
    return { props, own, fontSize, rootFontSize: this.rootFontSize, ...(this.viewport ? { viewport: this.viewport } : {}) };
  }
}

/** A4 portrait in CSS px: the default media context. */
export const A4_MEDIA: MediaContext = { width: 793.7, height: 1122.5 };

/**
 * Replaces `var(--name, fallback)` references. Returns undefined when a
 * reference cannot be resolved (the declaration is then invalid, as in CSS).
 */
function substituteVars(
  value: string,
  vars: ReadonlyMap<string, string>,
  warnings: string[],
  depth = 0,
): string | undefined {
  if (!value.includes("var(")) return value;
  if (depth > MAX_VAR_DEPTH) {
    warnings.push(`var() nesting too deep or cyclic: ${value}`);
    return value;
  }
  let out = "";
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf("var(", i);
    if (start === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, start);
    const end = closingParen(value, start + 3);
    const inner = value.slice(start + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    const resolved = vars.get(name) ?? fallback;
    if (resolved === undefined) {
      // Guaranteed-invalid: the whole declaration is ignored, as in CSS.
      // Guaranteed-invalid: the whole declaration is ignored, as in CSS.
      warnings.push(`Undefined CSS variable ${name}`);
      return undefined;
    }
    const inner2 = substituteVars(resolved, vars, warnings, depth + 1);
    if (inner2 === undefined) return undefined;
    out += inner2;
    i = end + 1;
  }
  return out.trim();
}

function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")" && --depth === 0) return j;
  }
  return s.length;
}

function topLevelComma(s: string): number {
  let depth = 0;
  for (let j = 0; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") depth--;
    else if (s[j] === "," && depth === 0) return j;
  }
  return -1;
}


const SIDES = ["top", "right", "bottom", "left"] as const;
const BORDER_STYLES = new Set(["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"]);

/**
 * Expands shorthands into longhands at cascade time so later declarations
 * override earlier ones property by property, as in CSS.
 */
export function expandShorthand(property: string, rawValue: string): [string, string][] {
  const value = simplifyNumbers(rawValue);
  const logical = LOGICAL[property];
  if (logical) return logical(value);
  const alias = SHORTHAND_BREAKS[property];
  if (alias) return [[alias, value === "always" ? "page" : value]];

  if (property === "text-decoration") {
    // Only the line matters on paper; color, style and thickness are not drawn.
    const lines = splitValue(value).filter((t) => /^(?:none|underline|overline|line-through|inherit|initial|unset|revert(?:-layer)?)$/.test(t));
    return lines.length ? [["text-decoration-line", lines.join(" ")]] : [];
  }
  if (property === "background") {
    // One layer: color, gradient or url(), plus position / size and repeat.
    const tokens = splitValue(value).map((t) => t.replace(/,$/, ""));
    const color = tokens.find((t) => parseColor(t) !== undefined);
    const image = tokens.find((t) => /^(?:(?:repeating-)?(?:linear|radial)-gradient|url)\(/i.test(t));
    const out: [string, string][] = [];
    if (color) out.push(["background-color", color]);
    if (image) out.push(["background-image", image]);
    let rest = tokens.filter((t) => t !== color && t !== image);
    const repeat = rest.find((t) => /^(?:no-repeat|repeat|repeat-x|repeat-y|space|round)$/.test(t));
    if (repeat) out.push(["background-repeat", repeat]);
    rest = rest.filter((t) => t !== repeat);
    const slash = rest.indexOf("/");
    if (slash !== -1) {
      out.push(["background-size", rest.slice(slash + 1).join(" ")]);
      rest = rest.slice(0, slash);
    }
    const position = rest.filter((t) => /^(?:center|top|bottom|left|right)$/.test(t));
    if (position.length) out.push(["background-position", position.join(" ")]);
    rest = rest.filter((t) => !position.includes(t) && t !== "scroll" && !/^(?:border|padding)-box$/.test(t));
    if (rest.length) out.push(["background-other", rest.join(" ")]);
    return out;
  }
  if (property === "columns") {
    // `columns: <count> <width>?`: only the count maps onto Typst columns.
    const tokens = splitValue(value);
    const count = tokens.find((t) => /^\d+$/.test(t));
    const out: [string, string][] = [["column-count", count ?? "auto"]];
    if (tokens.some((t) => t !== count && t !== "auto")) out.push(["column-width", tokens.filter((t) => t !== count).join(" ")]);
    return out;
  }
  if (property === "margin" || property === "padding") {
    const box = expandBox(splitValue(value));
    return box ? SIDES.map((side, i) => [`${property}-${side}`, box[i]!]) : [];
  }
  if (property === "border") return SIDES.flatMap((side) => borderSide(side, value));
  const sideMatch = /^border-(top|right|bottom|left)$/.exec(property);
  if (sideMatch) return borderSide(sideMatch[1]!, value);
  const partMatch = /^border-(width|style|color)$/.exec(property);
  if (partMatch) {
    const box = expandBox(splitValue(value));
    return box ? SIDES.map((side, i) => [`border-${side}-${partMatch[1]}`, box[i]!]) : [];
  }
  if (property === "inset") {
    const box = expandBox(splitValue(value));
    return box ? SIDES.map((side, i) => [side, box[i]!]) : [];
  }
  if (property === "font") return fontShorthand(value);
  if (property === "place-items" || property === "place-content") {
    const [a, b = a] = splitValue(value);
    return property === "place-items" ? [["align-items", a!], ["justify-items", b!]] : [["align-content", a!], ["justify-content", b!]];
  }
  const radius = /^border-(top|bottom)-(left|right)-radius$/.exec(property);
  if (radius) return [[property, value]];
  if (property === "border-radius") {
    // Elliptical radii (`a / b`) keep only the horizontal ones.
    const corners = ["top-left", "top-right", "bottom-right", "bottom-left"];
    if (/^(?:initial|inherit|unset)$/.test(value)) return corners.map((c) => [`border-${c}-radius`, value]);
    const box = expandBox(splitValue(value.split("/")[0]!.trim()));
    return box ? corners.map((c, i) => [`border-${c}-radius`, box[i]!]) : [[property, value]];
  }
  if (property === "overflow") {
    const [x, y = x] = splitValue(value);
    return [["overflow-x", x!], ["overflow-y", y!]];
  }
  if (property === "list-style") {
    const tokens = splitValue(value);
    const type = tokens.find((t) => LIST_STYLES.has(t.toLowerCase()) || /^(["']).*\1$/.test(t));
    const rest = tokens.filter((t) => t !== type);
    const out: [string, string][] = [];
    if (type) out.push(["list-style-type", type]);
    if (rest.length) out.push(["list-style-other", rest.join(" ")]);
    return out;
  }
  return [[property, value]];
}

/** Writing-mode-relative properties, for horizontal left-to-right text. */
const LOGICAL_SIDES: Record<string, string> = { "block-start": "top", "block-end": "bottom", "inline-start": "left", "inline-end": "right" };
const LOGICAL: Record<string, (value: string) => [string, string][]> = {};
for (const prop of ["margin", "padding", "border", "inset"]) {
  const physical = (side: string, part = "") => (prop === "inset" ? side : `${prop}-${side}${part}`);
  for (const axis of ["block", "inline"] as const) {
    const [start, end] = axis === "block" ? ["top", "bottom"] : ["left", "right"];
    for (const part of prop === "border" ? ["", "-width", "-style", "-color"] : [""]) {
      LOGICAL[`${prop}-${axis}${part}`] = (v) => {
        const [a, b = a] = part || prop === "border" ? [v, v] : splitValue(v);
        return [...expandShorthand(physical(start!, part), a!), ...expandShorthand(physical(end!, part), b!)];
      };
      for (const edge of ["start", "end"]) {
        LOGICAL[`${prop}-${axis}-${edge}${part}`] = (v) => expandShorthand(physical(LOGICAL_SIDES[`${axis}-${edge}`]!, part), v);
      }
    }
  }
}
for (const [logical, physical] of Object.entries({
  "border-start-start-radius": "border-top-left-radius", "border-start-end-radius": "border-top-right-radius",
  "border-end-start-radius": "border-bottom-left-radius", "border-end-end-radius": "border-bottom-right-radius",
  "inline-size": "width", "block-size": "height", "min-inline-size": "min-width", "min-block-size": "min-height",
  "max-inline-size": "max-width", "max-block-size": "max-height",
})) LOGICAL[logical] = (v) => [[physical, v]];

const FONT_KEYWORDS = new Set(["caption", "icon", "menu", "message-box", "small-caption", "status-bar"]);

/** `font: [style] [variant] [weight] [stretch] size[/line-height] family`. */
function fontShorthand(value: string): [string, string][] {
  const longhands = ["font-style", "font-weight", "font-size", "line-height", "font-family"];
  if (/^(?:inherit|initial|unset)$/.test(value)) return longhands.map((p) => [p, value]);
  if (FONT_KEYWORDS.has(value)) return [];
  const tokens = splitValue(value);
  let style = "normal";
  let weight = "normal";
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase();
    if (t === "italic" || t === "oblique") style = t;
    else if (t === "bold" || t === "bolder" || t === "lighter" || /^[1-9]00$/.test(t)) weight = t;
    else if (t === "normal" || t === "small-caps" || /condensed|expanded/.test(t)) continue;
    else break;
  }
  const m = /^(\S+?)(?:\s*\/\s*(\S+))?\s+(.+)$/s.exec(tokens.slice(i).join(" "));
  if (!m) return [];
  const [, size, lineHeight, family] = m;
  return [
    ["font-style", style], ["font-weight", weight], ["font-size", size!],
    ["line-height", lineHeight ?? "normal"], ["font-family", family!],
  ];
}

/**
 * Replaces unitless `calc()`/`min()`/`max()`/`clamp()` with their value, so
 * `line-height: calc(1.25 / 0.875)` reads as a plain number.
 */
function simplifyNumbers(value: string): string {
  if (!/(?:calc|min|max|clamp)\(/i.test(value)) return value;
  return value.replace(/\b(?:calc|min|max|clamp)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gi, (m) => {
    if (/[a-z%]\s*(?:[-+*/,)]|$)/i.test(m.replace(/^\w+\(|(?:calc|min|max|clamp)\(/gi, "("))) return m;
    const n = parseNumber(m);
    return n === undefined ? m : String(Math.round(n * 1e4) / 1e4);
  });
}

function borderSide(side: string, value: string): [string, string][] {
  let width = "medium";
  let style = "none";
  let color = "currentcolor";
  for (const token of splitValue(value)) {
    const t = token.toLowerCase();
    if (BORDER_STYLES.has(t)) style = t;
    else if (parseColor(t) !== undefined || t === "currentcolor") color = t;
    else width = t;
  }
  return [
    [`border-${side}-width`, width],
    [`border-${side}-style`, style],
    [`border-${side}-color`, color],
  ];
}
