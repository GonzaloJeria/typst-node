import { parseInsetFill, parseUrl, splitValue, parseColor, parseFontSize, parseGradient, parseLength, parseNumber, parseShadows, parseTransform } from "./values.js";

/**
 * Every CSS property the converter understands, with a validator for the
 * values it can actually render. Anything else produces a warning, so nothing
 * is ever dropped silently.
 */
const ctx = { fontSize: 12, rootFontSize: 12 };
const isLength = (v: string) => parseLength(v, ctx) !== undefined;
const isColor = (v: string) => v === "currentcolor" || parseColor(v) !== undefined;
const oneOf = (...values: string[]) => (v: string) => values.includes(v.toLowerCase());
const any = () => true;
const isAbsolute = (v: string) => {
  const l = parseLength(v, ctx);
  return l !== undefined && l.unit !== "%";
};

const SIDE_PROPS = ["top", "right", "bottom", "left"].flatMap((side) => [
  [`padding-${side}`, isLength],
  [`border-${side}-width`, (v: string) => isLength(v) || ["thin", "medium", "thick"].includes(v)],
  [`border-${side}-style`, oneOf("none", "hidden", "solid", "dashed", "dotted", "double")],
  [`border-${side}-color`, isColor],
] as const);

const SUPPORTED: Record<string, (value: string) => boolean> = {
  ...Object.fromEntries(SIDE_PROPS),
  color: isColor,
  "background-color": isColor,
  "background-image": (v) => v === "none" || parseGradient(v) !== undefined || parseUrl(v) !== undefined,
  "background-size": (v) => /^(?:auto|cover|contain)$/.test(v) || splitValue(v).every((t) => t === "auto" || isLength(t)),
  "background-position": (v) => /^(?:(?:center|top|bottom|left|right)\s*){1,2}$/.test(v.trim()),
  "background-repeat": oneOf("no-repeat"),
  height: (v) => v === "auto" || isLength(v),
  "min-height": (v) => v === "auto" || v === "0" || isLength(v),
  "background-other": () => false,
  opacity: (v) => /^(?:0|1|0?\.\d+|1\.0*|\d{1,3}%)$/.test(v.trim()),
  "font-family": any,
  "font-size": (v) => parseFontSize(v, 12, 12) !== undefined,
  "font-weight": (v) => /^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(v),
  "font-style": oneOf("normal", "italic", "oblique"),
  "text-align": oneOf("left", "right", "center", "justify", "start", "end"),
  "text-decoration": (v) => /^(?:none|underline|line-through)(?:\s|$)/.test(v),
  "text-decoration-line": oneOf("none", "underline", "line-through"),
  "text-transform": oneOf("none", "uppercase", "lowercase", "capitalize"),
  "letter-spacing": (v) => v === "normal" || isLength(v),
  "white-space": oneOf("normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"),
  "line-height": (v) => v === "normal" || parseNumber(v) !== undefined || isLength(v),
  display: oneOf(
    "none", "inline", "block", "inline-block", "flex", "grid", "list-item",
    "table", "table-row", "table-cell", "table-row-group", "table-header-group", "table-footer-group",
  ),
  width: (v) => v === "auto" || isLength(v),
  "max-width": (v) => v === "none" || isLength(v),
  "margin-top": (v) => v === "auto" || isLength(v),
  "margin-bottom": (v) => v === "auto" || isLength(v),
  "margin-left": (v) => v === "auto" || isLength(v),
  "margin-right": (v) => v === "auto" || isLength(v),
  "border-radius": isLength,
  "border-top-left-radius": (v) => isLength(splitValue(v)[0] ?? ""),
  "border-top-right-radius": (v) => isLength(splitValue(v)[0] ?? ""),
  "border-bottom-right-radius": (v) => isLength(splitValue(v)[0] ?? ""),
  "border-bottom-left-radius": (v) => isLength(splitValue(v)[0] ?? ""),
  "overflow-x": oneOf("visible", "hidden", "clip", "auto", "scroll"),
  "overflow-y": oneOf("visible", "hidden", "clip", "auto", "scroll"),
  "object-fit": oneOf("fill", "contain", "cover", "none", "scale-down"),
  "object-position": oneOf("center", "50% 50%", "center center"),
  "border-collapse": oneOf("collapse"),
  "box-sizing": oneOf("border-box", "content-box"),
  "text-indent": (v) => !v.includes("%") && !/\b(hanging|each-line)\b/.test(v),
  "font-feature-settings": oneOf("normal"),
  "font-variation-settings": oneOf("normal"),
  "font-variant": oneOf("normal"),
  // Other numeric variants (ordinal, slashed-zero…) have no Typst equivalent and are ignored quietly.
  "font-variant-numeric": () => true,
  "outline": oneOf("none", "0"),
  "outline-style": oneOf("none"),
  "outline-width": oneOf("0", "0px"),
  "break-before": oneOf("auto", "page", "always", "left", "right", "avoid", "avoid-page"),
  widows: (v) => /^[1-9]\d?$/.test(v),
  "break-after": oneOf("auto", "page", "always", "left", "right", "avoid"),
  page: (v) => /^(?:auto|-?[_a-zA-Z][-\w]*)$/.test(v),
  "break-inside": oneOf("auto", "avoid", "avoid-page"),
  "list-style-type": (v) => LIST_STYLES.has(v) || /^(["']).*\1$/.test(v),
  "list-style-other": oneOf("outside"),
  content: any,
  flex: any,
  "flex-grow": (v) => /^\d*\.?\d+$/.test(v),
  "flex-basis": (v) => v === "auto" || isLength(v),
  "flex-direction": oneOf("row", "column", "column-reverse"),
  "justify-content": oneOf("normal", "flex-start", "start", "left", "flex-end", "end", "right", "center", "space-between", "space-around", "space-evenly"),
  "align-items": oneOf("normal", "stretch", "flex-start", "start", "self-start", "center", "flex-end", "end", "self-end"),
  "flex-wrap": oneOf("nowrap", "wrap", "wrap-reverse"),
  "row-gap": (v) => v === "normal" || isLength(v),
  "flex-shrink": (v) => /^\d*\.?\d+$/.test(v),
  "min-width": (v) => v === "auto" || v === "0" || /^0[a-z]+$/.test(v),
  "grid-template-columns": any,
  gap: any,
  "column-gap": any,
  "column-count": (v) => v === "auto" || /^[1-9]\d?$/.test(v),
  "column-fill": oneOf("balance", "auto"),
  "vertical-align": oneOf("baseline"),
  visibility: oneOf("visible"),
  "font-size-adjust": oneOf("none"),
  position: (v) => /^(?:static|relative|absolute|fixed|running\(\s*[-\w]+\s*\))$/.test(v),
  // Percentages would need the containing block's size, which only Typst knows.
  top: (v) => v === "auto" || isAbsolute(v),
  right: (v) => v === "auto" || isAbsolute(v),
  bottom: (v) => v === "auto" || isAbsolute(v),
  left: (v) => v === "auto" || isAbsolute(v),
  transform: (v) => parseTransform(v, ctx) !== undefined,
  "transform-origin": oneOf("center", "50% 50%", "center center"),
  "box-shadow": (v) => parseShadows(v, ctx) !== undefined || parseInsetFill(v) !== undefined,
};

export const LIST_STYLES = new Set([
  "none", "disc", "circle", "square", "decimal", "lower-alpha", "lower-latin",
  "upper-alpha", "upper-latin", "lower-roman", "upper-roman",
]);

/** Properties with no visual effect on paper: ignored without a warning. */
const QUIET = /^(?:-(?:webkit|moz|ms|o)-|cursor$|pointer-events$|user-select$|transition|animation|will-change$|scroll-|touch-action$|resize$|caret-color$|outline-offset$|outline-color$|appearance$|tab-size$|text-size-adjust$|text-rendering$|font-smooth|font-synthesis|font-kerning$|font-optical-sizing$|accent-color$|color-scheme$|print-color-adjust$|color-adjust$|content-visibility$|contain|isolation$|backface-visibility$|perspective|overscroll-behavior|forced-color-adjust$|speak|interpolate-size$|field-sizing$|text-wrap|text-underline-offset$|text-decoration-thickness$|text-decoration-color$|text-decoration-style$|text-overflow$)/;

/** Whether a value is valid for a property this converter knows; undefined for unknown properties. */
export function isValidValue(property: string, value: string): boolean | undefined {
  if (value === "inherit" || value === "initial" || value === "unset" || value === "revert" || value === "revert-layer") return true;
  const validate = SUPPORTED[property];
  return validate ? validate(value.trim()) : undefined;
}

/** Returns a warning for `property: value`, or undefined when it is supported. */
export function checkDeclaration(property: string, value: string, where: string): string | undefined {
  const problem = declarationProblem(property, value);
  if (problem === "property") return `Unsupported CSS ignored: ${displayName(property)}: ${value} (<${where}>)`;
  if (problem === "value") return `Unsupported CSS value ignored: ${displayName(property)}: ${value} (<${where}>)`;
  return undefined;
}

/** Whether a declaration can be rendered; memoized, since the same ones repeat on many elements. */
const problems = new Map<string, "property" | "value" | undefined>();
function declarationProblem(property: string, value: string): "property" | "value" | undefined {
  const key = `${property}\0${value}`;
  if (problems.has(key)) return problems.get(key);
  let out: "property" | "value" | undefined;
  if (QUIET.test(property) || value === "inherit" || value === "initial" || value === "unset") out = undefined;
  else {
    const validate = SUPPORTED[property];
    out = !validate ? "property" : validate(value.trim()) ? undefined : "value";
  }
  if (problems.size >= 5000) problems.clear();
  problems.set(key, out);
  return out;
}

function displayName(property: string): string {
  if (property === "background-other") return "background";
  if (property === "list-style-other") return "list-style";
  return property;
}
