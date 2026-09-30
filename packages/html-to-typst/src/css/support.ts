import { parseColor, parseFontSize, parseGradient, parseLength, parseShadows, parseTransform } from "./values.js";

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
  [`border-${side}-style`, oneOf("none", "hidden", "solid", "dashed", "dotted")],
  [`border-${side}-color`, isColor],
] as const);

const SUPPORTED: Record<string, (value: string) => boolean> = {
  ...Object.fromEntries(SIDE_PROPS),
  color: isColor,
  "background-color": isColor,
  "background-image": (v) => v === "none" || parseGradient(v) !== undefined,
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
  "white-space": oneOf("normal", "pre", "pre-wrap", "pre-line", "break-spaces"),
  "line-height": (v) => v === "normal" || /^\d*\.?\d+$/.test(v) || isLength(v),
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
  "border-collapse": oneOf("collapse"),
  "box-sizing": oneOf("border-box"),
  "break-before": oneOf("auto", "page", "always", "left", "right", "avoid"),
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
  "flex-wrap": oneOf("nowrap"),
  "grid-template-columns": any,
  gap: any,
  "column-gap": any,
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
  "box-shadow": (v) => parseShadows(v, ctx) !== undefined,
};

export const LIST_STYLES = new Set([
  "none", "disc", "circle", "square", "decimal", "lower-alpha", "lower-latin",
  "upper-alpha", "upper-latin", "lower-roman", "upper-roman",
]);

/** Properties with no visual effect on paper: ignored without a warning. */
const QUIET = /^(?:-(?:webkit|moz|ms|o)-|cursor$|pointer-events$|user-select$|transition|animation|will-change$|scroll-|touch-action$|resize$|caret-color$|outline-offset$)/;

/** Returns a warning for `property: value`, or undefined when it is supported. */
export function checkDeclaration(property: string, value: string, where: string): string | undefined {
  if (QUIET.test(property)) return undefined;
  if (value === "inherit" || value === "initial" || value === "unset") return undefined;
  const validate = SUPPORTED[property];
  if (!validate) return `Unsupported CSS ignored: ${displayName(property)}: ${value} (<${where}>)`;
  if (!validate(value.trim())) return `Unsupported CSS value ignored: ${displayName(property)}: ${value} (<${where}>)`;
  return undefined;
}

function displayName(property: string): string {
  if (property === "background-other") return "background";
  if (property === "list-style-other") return "list-style";
  return property;
}
