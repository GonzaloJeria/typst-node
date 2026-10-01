import type { HelperDelegate, HelperOptions } from "handlebars";

export interface FormatOptions {
  /** BCP 47 locale for numbers, money and dates. Default: `es-CL`. */
  locale?: string;
  /** Default currency for `money`. Default: `CLP`. */
  currency?: string;
  /** Time zone for `date`. Default: the process time zone. */
  timeZone?: string;
}

/** Handlebars passes its options object as the last argument; drop it. */
function args(list: unknown[]): unknown[] {
  const last = list.at(-1) as HelperOptions | undefined;
  return last && typeof last === "object" && "hash" in last ? list.slice(0, -1) : list;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}

function toDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v;
  if (typeof v === "number" || typeof v === "string") {
    // A bare date (`2026-03-01`) is a calendar day, not UTC midnight.
    const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Formats a date with `Intl` presets (`short`, `medium`, `long`, `full`) or a
 * pattern: `yyyy`, `yy`, `MMMM`, `MMM`, `MM`, `M`, `dd`, `d`, `EEEE`, `HH`, `mm`, `ss`, and
 * `'literal text'`.
 */
export function formatDate(value: unknown, pattern: string, opts: FormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return value == null ? "" : String(value);
  const locale = opts.locale ?? "es-CL";
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {};
  if (/^(short|medium|long|full)$/.test(pattern)) {
    return new Intl.DateTimeFormat(locale, { dateStyle: pattern as "short", ...tz }).format(d);
  }
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...o, ...tz }).format(d);
  const num = (o: Intl.DateTimeFormatOptions, key: Intl.DateTimeFormatPartTypes) =>
    new Intl.DateTimeFormat("en-US", { ...o, ...tz, hourCycle: "h23" }).formatToParts(d).find((p) => p.type === key)?.value ?? "";
  const tokens: Record<string, () => string> = {
    yyyy: () => num({ year: "numeric" }, "year"),
    yy: () => num({ year: "2-digit" }, "year"),
    MMMM: () => part({ month: "long" }),
    MMM: () => part({ month: "short" }).replace(/\.$/, ""),
    MM: () => num({ month: "2-digit" }, "month"),
    M: () => num({ month: "numeric" }, "month"),
    dd: () => num({ day: "2-digit" }, "day"),
    d: () => num({ day: "numeric" }, "day"),
    EEEE: () => part({ weekday: "long" }),
    HH: () => num({ hour: "2-digit" }, "hour").padStart(2, "0"),
    mm: () => num({ minute: "2-digit" }, "minute").padStart(2, "0"),
    ss: () => num({ second: "2-digit" }, "second").padStart(2, "0"),
  };
  // Text in single quotes is literal: "d 'de' MMMM".
  return pattern.replace(/'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|HH|mm|ss/g, (t, literal: string | undefined) => literal ?? tokens[t]!());
}

/** Built-in helpers. Every one of them returns plain text, which Handlebars escapes. */
export function builtinHelpers(opts: FormatOptions = {}): Record<string, HelperDelegate> {
  const locale = opts.locale ?? "es-CL";
  const nf = (o: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, o);
  return {
    // ── Formatting ──
    /** `{{money total}}`, `{{money total "USD"}}` */
    money: (...a: unknown[]) => {
      const [v, currency] = args(a);
      const n = toNumber(v);
      return Number.isNaN(n) ? "" : nf({ style: "currency", currency: typeof currency === "string" ? currency : opts.currency ?? "CLP" }).format(n);
    },
    /** `{{number 1234.5}}` → `1.234,5`; `{{number x 2}}` fixes the decimals. */
    number: (...a: unknown[]) => {
      const [v, decimals] = args(a);
      const n = toNumber(v);
      if (Number.isNaN(n)) return "";
      const d = typeof decimals === "number" ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {};
      return nf(d).format(n);
    },
    /** `{{percent 0.1896}}` → `18,96 %` (the value is a fraction). */
    percent: (...a: unknown[]) => {
      const [v, decimals] = args(a);
      const n = toNumber(v);
      const d = typeof decimals === "number" ? decimals : 2;
      return Number.isNaN(n) ? "" : nf({ style: "percent", minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
    },
    /** `{{date fecha "dd/MM/yyyy"}}`, `{{date fecha "long"}}`; without a pattern, `dd-MM-yyyy`. */
    date: (...a: unknown[]) => {
      const [v, pattern] = args(a);
      return formatDate(v, typeof pattern === "string" ? pattern : "dd-MM-yyyy", opts);
    },
    upper: (...a: unknown[]) => String(args(a)[0] ?? "").toLocaleUpperCase(locale),
    lower: (...a: unknown[]) => String(args(a)[0] ?? "").toLocaleLowerCase(locale),
    capitalize: (...a: unknown[]) => {
      const s = String(args(a)[0] ?? "");
      return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
    },
    /** `{{default cliente.telefono "—"}}` */
    default: (...a: unknown[]) => {
      const [v, fallback] = args(a);
      return v === undefined || v === null || v === "" ? fallback : v;
    },
    join: (...a: unknown[]) => {
      const [list, sep] = args(a);
      return Array.isArray(list) ? list.join(typeof sep === "string" ? sep : ", ") : "";
    },
    json: (...a: unknown[]) => JSON.stringify(args(a)[0] ?? null),

    // ── Logic (for {{#if (eq a b)}}) ──
    eq: (...a: unknown[]) => { const [x, y] = args(a); return x === y; },
    ne: (...a: unknown[]) => { const [x, y] = args(a); return x !== y; },
    gt: (...a: unknown[]) => { const [x, y] = args(a); return toNumber(x) > toNumber(y); },
    gte: (...a: unknown[]) => { const [x, y] = args(a); return toNumber(x) >= toNumber(y); },
    lt: (...a: unknown[]) => { const [x, y] = args(a); return toNumber(x) < toNumber(y); },
    lte: (...a: unknown[]) => { const [x, y] = args(a); return toNumber(x) <= toNumber(y); },
    and: (...a: unknown[]) => args(a).every(Boolean),
    or: (...a: unknown[]) => args(a).some(Boolean),
    not: (...a: unknown[]) => !args(a)[0],

    // ── Math ──
    add: (...a: unknown[]) => args(a).reduce<number>((s, v) => s + toNumber(v), 0),
    sub: (...a: unknown[]) => { const [x, y] = args(a); return toNumber(x) - toNumber(y); },
    mul: (...a: unknown[]) => args(a).reduce<number>((s, v) => s * toNumber(v), 1),
    div: (...a: unknown[]) => { const [x, y] = args(a); return toNumber(x) / toNumber(y); },
    round: (...a: unknown[]) => {
      const [v, decimals] = args(a);
      const k = 10 ** (typeof decimals === "number" ? decimals : 0);
      return Math.round(toNumber(v) * k) / k;
    },
    /** `{{sum items "total"}}` adds a field over a list; `{{sum valores}}` adds the list. */
    sum: (...a: unknown[]) => {
      const [list, field] = args(a);
      if (!Array.isArray(list)) return 0;
      return list.reduce<number>((s, item) => s + toNumber(typeof field === "string" ? (item as Record<string, unknown>)?.[field] : item), 0);
    },
    /** `{{#each items}}{{inc @index}}{{/each}}`: 1-based numbering. */
    inc: (...a: unknown[]) => toNumber(args(a)[0]) + 1,
  };
}
