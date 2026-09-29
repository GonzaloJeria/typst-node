import { selectorElement, type Element } from "../dom.js";
import { parseDeclarations, type Declaration, type Stylesheet } from "./parse.js";
import { matches, parseSelector, type Selector } from "./selector.js";
import { expandBox, parseColor, parseFontSize, splitValue } from "./values.js";

/** Properties that inherit from the parent when not set. */
const INHERITED = new Set([
  "color", "font-family", "font-weight", "font-style", "text-align", "line-height",
  "letter-spacing", "white-space", "list-style-type", "visibility",
]);

const SHORTHAND_BREAKS: Record<string, string> = {
  "page-break-before": "break-before",
  "page-break-after": "break-after",
  "page-break-inside": "break-inside",
};

export interface ComputedStyle {
  /** Final value per property: own cascaded values plus inherited ones. */
  props: ReadonlyMap<string, string>;
  /** Computed font size in pt. */
  fontSize: number;
  rootFontSize: number;
}

interface CompiledRule {
  selector: Selector;
  declarations: Declaration[];
  order: number;
}

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

  /** Cascades author rules and the `style` attribute for `el`. */
  compute(el: Element, parent: ComputedStyle | undefined, inlineStyle: string | undefined): ComputedStyle {
    const target = selectorElement(el);
    const matched = this.#rules
      .filter((r) => matches(r.selector, target))
      .sort((a, b) => compareSpecificity(a.selector.specificity, b.selector.specificity) || a.order - b.order);

    const normal: Declaration[] = [];
    const important: Declaration[] = [];
    for (const r of matched) for (const d of r.declarations) (d.important ? important : normal).push(d);
    const inline = inlineStyle ? parseDeclarations(inlineStyle) : [];
    normal.push(...inline.filter((d) => !d.important));
    important.push(...inline.filter((d) => d.important));

    const own = new Map<string, string>();
    for (const d of [...normal, ...important]) {
      for (const [p, v] of expandShorthand(d.property, d.value)) own.set(p, v);
    }

    const props = new Map<string, string>();
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
    return { props, fontSize, rootFontSize: this.rootFontSize };
  }
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
    // Only the color component of `background` is supported.
    const color = splitValue(value).find((t) => parseColor(t) !== undefined);
    return color ? [["background-color", color]] : [];
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
