/** True when the template asks for Tailwind: the CDN script, `@import "tailwindcss"`, or Tailwind at-rules. */
export function usesTailwind(html: string, css: string): boolean {
  return /<script[^>]+cdn\.tailwindcss\.com/i.test(html) || /@import\s+["']tailwindcss|@(?:tailwind|theme|apply|utility|custom-variant|variant)\b/.test(css);
}
