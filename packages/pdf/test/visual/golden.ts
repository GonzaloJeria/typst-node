import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareImages } from "./compare.js";
import { decodePng, encodePng } from "./png.js";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
export const GOLDEN_DIR = path.join(ROOT, "__goldens__");
export const DIFF_DIR = path.join(ROOT, "__diff__");
const VERSION_FILE = path.join(GOLDEN_DIR, "TYPST_VERSION");

/** `UPDATE_VISUAL=1` rewrites goldens; CI never creates missing ones. */
export const updating = process.env.UPDATE_VISUAL === "1";
const isCI = !!process.env.CI;

export function checkGoldenVersion(version: string): string | undefined {
  if (updating) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(VERSION_FILE, `${version}\n`);
    return undefined;
  }
  if (!existsSync(VERSION_FILE)) {
    // First baseline: record the version the goldens are about to be rendered with.
    if (!isCI) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(VERSION_FILE, `${version}\n`);
    }
    return undefined;
  }
  const expected = readFileSync(VERSION_FILE, "utf8").trim();
  return expected === version
    ? undefined
    : `Goldens were rendered with Typst ${expected} but the installed binary is ${version}. ` +
        "Install the pinned version or re-baseline with UPDATE_VISUAL=1 and review the diff.";
}

export interface GoldenOptions {
  /** Max fraction of differing pixels per page. Default 0.001 (0.1 %). */
  maxDiffRatio?: number;
  channelTolerance?: number;
}

/** Compares rendered pages against stored goldens; returns failure messages. */
export function matchGoldens(name: string, pages: Uint8Array[], options: GoldenOptions = {}): string[] {
  const dir = path.join(GOLDEN_DIR, name);
  const diffDir = path.join(DIFF_DIR, name);
  rmSync(diffDir, { recursive: true, force: true });

  if (updating || !existsSync(dir)) {
    if (!updating && isCI) return [`Missing goldens for "${name}" (run with UPDATE_VISUAL=1 locally and commit them)`];
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    pages.forEach((p, i) => writeFileSync(path.join(dir, pageFile(i)), p));
    return [];
  }

  const failures: string[] = [];
  const stored = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  if (stored.length !== pages.length) {
    failures.push(`${name}: expected ${stored.length} page(s), got ${pages.length}`);
  }
  pages.forEach((page, i) => {
    const goldenPath = path.join(dir, pageFile(i));
    if (!existsSync(goldenPath)) return;
    const result = compareImages(decodePng(readFileSync(goldenPath)), decodePng(page), {
      ...(options.channelTolerance !== undefined ? { channelTolerance: options.channelTolerance } : {}),
    });
    const max = options.maxDiffRatio ?? 0.001;
    if (!result.sameSize || result.diffRatio > max) {
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(path.join(diffDir, pageFile(i)), page);
      writeFileSync(path.join(diffDir, pageFile(i).replace(".png", ".diff.png")), encodePng(result.diff));
      failures.push(
        `${name} page ${i + 1}: ${(result.diffRatio * 100).toFixed(3)}% pixels differ` +
          `${result.sameSize ? "" : " (size changed)"} > ${(max * 100).toFixed(3)}% — see ${path.relative(process.cwd(), diffDir)}`,
      );
    }
  });
  return failures;
}

function pageFile(i: number): string {
  return `page-${String(i + 1).padStart(2, "0")}.png`;
}
