import type { FontFace } from "@typdf/html-to-typst";
import { loadOne, type AssetOptions } from "./assets.js";

export interface ResolvedFonts {
  /** Font files for the Typst backend. */
  fonts: Uint8Array[];
  /** CSS family → family name inside the font, where they differ. */
  aliases: Record<string, string>;
  warnings: string[];
}

/**
 * Loads `@font-face` fonts with the same rules as images (`assets` options).
 * Typst selects fonts by the family name stored in the file, so a CSS name
 * that differs (`font-family: Brand` for "Acme Sans") becomes an alias.
 */
export async function resolveFonts(faces: readonly FontFace[], options: AssetOptions = {}, signal?: AbortSignal): Promise<ResolvedFonts> {
  const fonts: Uint8Array[] = [];
  const aliases: Record<string, string> = {};
  const warnings: string[] = [];
  const seen = new Map<string, string | undefined>();
  await Promise.all(
    faces.map(async (face) => {
      let family = seen.get(face.url);
      if (!seen.has(face.url)) {
        try {
          const bytes = await loadOne(face.url, options, signal);
          family = fontFamilyName(bytes);
          if (!family) throw new Error("not a TrueType/OpenType font");
          fonts.push(bytes);
        } catch (err) {
          const message = `Cannot load font ${face.family} (${truncate(face.url)}): ${(err as Error).message}`;
          if ((options.onError ?? "throw") === "throw") throw new Error(message, { cause: err });
          warnings.push(message);
        }
        seen.set(face.url, family);
      }
      if (family && family.toLowerCase() !== face.family.toLowerCase()) aliases[face.family] = family;
    }),
  );
  return { fonts, aliases, warnings };
}

/**
 * The family name in a TrueType/OpenType file's `name` table (typographic
 * family, else family), or undefined when the bytes are not such a font.
 */
export function fontFamilyName(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) return undefined;
  const tag = view.getUint32(0);
  // 0x00010000 (TrueType), 'OTTO' (CFF), 'true' (old Apple).
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return undefined;
  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > bytes.length) return undefined;
    if (view.getUint32(rec) === 0x6e616d65) nameOffset = view.getUint32(rec + 8); // 'name'
  }
  if (nameOffset < 0 || nameOffset + 6 > bytes.length) return undefined;
  const count = view.getUint16(nameOffset + 2);
  const strings = nameOffset + view.getUint16(nameOffset + 4);
  const found = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > bytes.length) break;
    const platform = view.getUint16(rec);
    const nameId = view.getUint16(rec + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const length = view.getUint16(rec + 8);
    const start = strings + view.getUint16(rec + 10);
    if (start + length > bytes.length) continue;
    const raw = bytes.subarray(start, start + length);
    let text: string;
    if (platform === 0 || platform === 3) {
      text = "";
      for (let j = 0; j + 1 < raw.length; j += 2) text += String.fromCharCode((raw[j]! << 8) | raw[j + 1]!);
    } else if (platform === 1) text = String.fromCharCode(...raw);
    else continue;
    // Prefer Windows/Unicode names over Mac ones.
    if (!found.has(nameId) || platform !== 1) found.set(nameId, text);
  }
  return found.get(16) ?? found.get(1);
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
