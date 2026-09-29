import type { Image } from "./png.js";

export interface CompareOptions {
  /** Per-channel difference (0–255) below which pixels count as equal; absorbs anti-aliasing noise. */
  channelTolerance?: number;
}

export interface CompareResult {
  sameSize: boolean;
  diffPixels: number;
  /** Fraction of differing pixels, 0–1. */
  diffRatio: number;
  /** Faded copy of `expected` with differing pixels in red. */
  diff: Image;
}

export function compareImages(expected: Image, actual: Image, options: CompareOptions = {}): CompareResult {
  const tolerance = options.channelTolerance ?? 24;
  const width = Math.max(expected.width, actual.width);
  const height = Math.max(expected.height, actual.height);
  const diff = new Uint8Array(width * height * 4);
  let diffPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const e = pixel(expected, x, y);
      const a = pixel(actual, x, y);
      const differs = !e || !a || e.some((v, i) => Math.abs(v - a[i]!) > tolerance);
      if (differs) {
        diffPixels++;
        diff.set([255, 0, 0, 255], o);
      } else {
        const gray = 255 - Math.round((255 - luminance(e)) * 0.25);
        diff.set([gray, gray, gray, 255], o);
      }
    }
  }
  return {
    sameSize: expected.width === actual.width && expected.height === actual.height,
    diffPixels,
    diffRatio: diffPixels / (width * height),
    diff: { width, height, data: diff },
  };
}

function pixel(img: Image, x: number, y: number): number[] | undefined {
  if (x >= img.width || y >= img.height) return undefined;
  const o = (y * img.width + x) * 4;
  // Composite over white so transparent and white backgrounds compare equal.
  const alpha = img.data[o + 3]! / 255;
  return [0, 1, 2].map((i) => Math.round(img.data[o + i]! * alpha + 255 * (1 - alpha)));
}

function luminance([r, g, b]: number[]): number {
  return 0.299 * r! + 0.587 * g! + 0.114 * b!;
}
