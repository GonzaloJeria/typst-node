import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FontSource } from "./types.js";

export interface MaterializedProject {
  root: string;
  /** Directories to pass as `--font-path`. */
  fontDirs: string[];
  cleanup(): Promise<void>;
}

const FONT_DIR = ".typst-fonts";
/** Where page-image output is written; reserved like the font directory. */
export const OUTPUT_DIR = ".typst-out";
const RESERVED = [FONT_DIR, OUTPUT_DIR];

/**
 * Writes the virtual file map (and in-memory fonts) into a fresh temporary
 * directory that becomes the Typst `--root`. The CLI can only see the disk;
 * backends with a real in-memory world will skip this step.
 */
export async function materializeProject(
  files: ReadonlyMap<string, Uint8Array> | undefined,
  fonts: readonly FontSource[] | undefined,
  baseDir: string = tmpdir(),
): Promise<MaterializedProject> {
  const root = await mkdtemp(path.join(baseDir, "typst-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const writes: Promise<void>[] = [];
    for (const [name, data] of files ?? []) {
      const target = resolveInside(root, name);
      writes.push(mkdir(path.dirname(target), { recursive: true }).then(() => writeFile(target, data)));
    }

    const fontDirs: string[] = [];
    const fontBytes: Uint8Array[] = [];
    for (const font of fonts ?? []) {
      if (font instanceof Uint8Array) fontBytes.push(font);
      else fontDirs.push(path.resolve(font.dir));
    }
    if (fontBytes.length > 0) {
      const dir = path.join(root, FONT_DIR);
      await mkdir(dir);
      // The extension is irrelevant to Typst's font loader; it sniffs the data.
      fontBytes.forEach((data, i) => writes.push(writeFile(path.join(dir, `font-${i}.ttf`), data)));
      fontDirs.push(dir);
    }

    await Promise.all(writes);
    return { root, fontDirs, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Maps a virtual path to a real one, refusing anything that escapes `root`. */
export function resolveInside(root: string, name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized === "" || normalized.split("/").some((seg) => seg === ".." || seg === "")) {
    throw new TypeError(`Invalid virtual file path: ${JSON.stringify(name)}`);
  }
  const top = normalized.split("/")[0]!;
  if (RESERVED.includes(top)) {
    throw new TypeError(`Virtual file path uses reserved directory ${top}: ${name}`);
  }
  const target = path.resolve(root, normalized);
  if (!target.startsWith(root + path.sep)) {
    throw new TypeError(`Virtual file path escapes the project root: ${JSON.stringify(name)}`);
  }
  return target;
}
