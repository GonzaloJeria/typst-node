import { selectorElement, type Element } from "../dom.js";
import { parseDeclarations, type Declaration, type Stylesheet } from "./parse.js";
import { matches, parseSelector, type Selector } from "./selector.js";
import { LIST_STYLES } from "./support.js";
import { expandBox, parseColor, parseFontSize, splitValue } from "./values.js";

/** Properties that inherit from the parent when not set (custom properties always do). */
const INHERITED = new Set([
  "color", "font-family", "font-weight", "font-style", "text-align", "line-height",
  "letter-spacing", "white-space", "list-style-type", "visibility", "text-transform",
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
}

interface CompiledRule {
  selector: Selector;
  declarations: Declaration[];
  order: number;
}

const MAX_VAR_DEPTH = 16;

export class Cascade {
  readonly #rules: CompiledRule[] = [];
  readonly warnings: string[] = [];

  constructor(sheet: Stylesheet, readonly rootFontSize: number) {
    let order = 0;
    for (const rule of sheet.rules) {
      for (const text of rule.selectors) {
        const selector = parseSelector(text);
        if (!selector) {
          this.warnings.push(`Unsupported selector ignored: ${text}`);
          continue;
        }
        this.#rules.push({ selector, declarations: rule.declarations, order: order++ });
      }
    }
  }

  /** True when some rule targets `::before`/`::after` of this element. */
  hasPseudo(el: Element, pseudo: PseudoElement): boolean {
    const target = selectorElement(el);
    return this.#rules.some((r) => r.selector.pseudoElement === pseudo && matches(r.selector, target));
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
    const matched = this.#rules
      .filter((r) => r.selector.pseudoElement === pseudo && matches(r.selector, target))
      .sort((a, b) => compareSpecificity(a.selector.specificity, b.selector.specificity) || a.order - b.order);

    const normal: Declaration[] = [];
    const important: Declaration[] = [];
    for (const r of matched) for (const d of r.declarations) (d.important ? important : normal).push(d);
    const inline = inlineStyle && !pseudo ? parseDeclarations(inlineStyle) : [];
    normal.push(...inline.filter((d) => !d.important));
    important.push(...inline.filter((d) => d.important));
    const ordered = [...normal, ...important];

    // Custom properties first: they inherit and feed var() in everything else.
    const custom = new Map<string, string>();
    if (parent) for (const [p, v] of parent.props) if (p.startsWith("--")) custom.set(p, v);
    for (const d of ordered) {
      if (!d.property.startsWith("--")) continue;
      if (d.value === "initial") custom.delete(d.property);
      else if (d.value !== "inherit") custom.set(d.property, d.value);
    }
    for (const [p, v] of custom) custom.set(p, substituteVars(v, custom, this.warnings));

    const own = new Map<string, string>();
    for (const d of ordered) {
      if (d.property.startsWith("--")) continue;
      const value = substituteVars(d.value, custom, this.warnings);
      for (const [p, v] of expandShorthand(d.property, value)) own.set(p, v);
    }

    const props = new Map<string, string>(custom);
    if (parent) {
      for (const [p, v] of parent.props) if (INHERITED.has(p)) props.set(p, v);
    }
    for (const [p, v] of own) {
      if (v === "inherit") {
        const pv = parent?.props.get(p);
        if (pv === undefined) props.delete(p);
        else props.set(p, pv);
      } else if (v === "initial" || v === "unset") props.delete(p);
      else props.set(p, v);
    }

    const parentSize = parent?.fontSize ?? this.rootFontSize;
    const fs = own.get("font-size");
    const fontSize = (fs && fs !== "inherit" && parseFontSize(fs, parentSize, this.rootFontSize)) || parentSize;
    return { props, own, fontSize, rootFontSize: this.rootFontSize };
  }
}

/**
 * Replaces `var(--name, fallback)` references. Returns undefined when a
 * reference cannot be resolved (the declaration is then invalid, as in CSS).
 */
function substituteVars(value: string, vars: ReadonlyMap<string, string>, warnings: string[], depth = 0): string {
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
    if (resolved === undefined) warnings.push(`Undefined CSS variable ${name}`);
    else out += substituteVars(resolved, vars, warnings, depth + 1);
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

function compareSpecificity(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const SIDES = ["top", "right", "bottom", "left"] as const;
const BORDER_STYLES = new Set(["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"]);

/**
 * Expands shorthands into longhands at cascade time so later declarations
 * override earlier ones property by property, as in CSS.
 */
function expandShorthand(property: string, value: string): [string, string][] {
  const alias = SHORTHAND_BREAKS[property];
  if (alias) return [[alias, value === "always" ? "page" : value]];

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
