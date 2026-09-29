import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AssetFetchError, fetchBytes } from "./net.js";

export interface AssetOptions {
  /** Directory that relative and `file:` sources resolve against. Local files are refused without it. */
  baseDir?: string;
  /** Allow http(s) sources. Default: false. */
  allowRemote?: boolean;
  /** When set, only these hosts (exact names or patterns) may be fetched. */
  allowedHosts?: readonly (string | RegExp)[];
  /** Allow loopback/private/link-local addresses. Default: false (SSRF protection). */
  allowPrivateNetwork?: boolean;
  /** Per-request timeout. Default: 10 000 ms. */
  timeoutMs?: number;
  /** Max size of a single asset. Default: 10 MiB. */
  maxAssetBytes?: number;
  /** Max combined size of all assets. Default: 50 MiB. */
  maxTotalBytes?: number;
  /** Default: 3. */
  maxRedirects?: number;
  /**
   * Custom resolver consulted first. Return bytes to use them, or `undefined`
   * to fall back to the built-in handling.
   */
  resolve?: (src: string) => Promise<Uint8Array | undefined> | Uint8Array | undefined;
  /** `throw` fails the render; `skip` drops the image with a warning. Default: `throw`. */
  onError?: "throw" | "skip";
}

export interface ResolvedAssets {
  /** Virtual files for the Typst backend. */
  files: Map<string, Uint8Array>;
  /** Original `src` → virtual path, or `null` when skipped. */
  mapping: Map<string, string | null>;
  warnings: string[];
}

export class AssetError extends Error {
  override name = "AssetError";
  constructor(readonly src: string, message: string, options?: { cause?: unknown }) {
    super(`Cannot load image ${truncate(src)}: ${message}`, options);
  }
}

const MiB = 1024 * 1024;

export async function resolveAssets(
  sources: readonly string[],
  options: AssetOptions = {},
  signal?: AbortSignal,
): Promise<ResolvedAssets> {
  const files = new Map<string, Uint8Array>();
  const mapping = new Map<string, string | null>();
  const warnings: string[] = [];
  const maxTotal = options.maxTotalBytes ?? 50 * MiB;
  let total = 0;

  const results = await Promise.allSettled(sources.map((src) => loadOne(src, options, signal)));
  results.forEach((r, i) => {
    const src = sources[i]!;
    try {
      if (r.status === "rejected") throw r.reason;
      const bytes = r.value;
      total += bytes.length;
      if (total > maxTotal) throw new AssetError(src, `total asset size exceeds ${maxTotal} bytes`);
      const ext = sniffImage(bytes);
      if (!ext) throw new AssetError(src, "unsupported or unrecognized image format");
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const virtualPath = `assets/${hash}.${ext}`;
      files.set(virtualPath, bytes);
      mapping.set(src, virtualPath);
    } catch (err) {
      const error = err instanceof AssetError ? err : new AssetError(src, (err as Error).message, { cause: err });
      if ((options.onError ?? "throw") === "throw") throw error;
      warnings.push(error.message);
      mapping.set(src, null);
    }
  });
  return { files, mapping, warnings };
}

async function loadOne(src: string, o: AssetOptions, signal?: AbortSignal): Promise<Uint8Array> {
  const custom = await o.resolve?.(src);
  if (custom) return custom;

  const trimmed = src.trim();
  if (/^data:/i.test(trimmed)) return decodeDataUri(trimmed, o.maxAssetBytes ?? 10 * MiB);

  if (/^https?:/i.test(trimmed)) {
    if (!o.allowRemote) throw new AssetError(src, "remote assets are disabled (set assets.allowRemote)");
    return fetchBytes(trimmed, {
      timeoutMs: o.timeoutMs ?? 10_000,
      maxBytes: o.maxAssetBytes ?? 10 * MiB,
      maxRedirects: o.maxRedirects ?? 3,
      allowPrivateNetwork: o.allowPrivateNetwork ?? false,
      isHostAllowed: (host) =>
        !o.allowedHosts || o.allowedHosts.some((h) => (typeof h === "string" ? h.toLowerCase() === host.toLowerCase() : h.test(host))),
      signal,
    }).catch((err: unknown) => {
      throw new AssetError(src, err instanceof AssetFetchError ? err.message : String((err as Error).message ?? err), { cause: err });
    });
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^file:/i.test(trimmed)) {
    throw new AssetError(src, "unsupported URL scheme");
  }
  if (!o.baseDir) throw new AssetError(src, "local assets are disabled (set assets.baseDir)");
  return readLocal(src, trimmed, o.baseDir, o.maxAssetBytes ?? 10 * MiB);
}

async function readLocal(src: string, ref: string, baseDir: string, maxBytes: number): Promise<Uint8Array> {
  const base = await realpath(baseDir);
  // `file:` URLs are absolute; anything else is web-style, rooted at baseDir.
  const candidate = /^file:/i.test(ref)
    ? fileURLToPath(ref)
    : path.join(base, decodeURIComponent(ref.split(/[?#]/)[0]!));
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new AssetError(src, "file not found");
  }
  // realpath resolves symlinks, so a link pointing outside baseDir is caught too.
  if (real !== base && !real.startsWith(base + path.sep)) throw new AssetError(src, "path escapes baseDir");
  const bytes = await readFile(real);
  if (bytes.length > maxBytes) throw new AssetError(src, `exceeds ${maxBytes} bytes`);
  return new Uint8Array(bytes);
}

function decodeDataUri(uri: string, maxBytes: number): Uint8Array {
  const comma = uri.indexOf(",");
  if (comma === -1) throw new AssetError(uri, "malformed data URI");
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const bytes = /;base64$/i.test(meta)
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  if (bytes.length > maxBytes) throw new AssetError(uri, `exceeds ${maxBytes} bytes`);
  return new Uint8Array(bytes);
}

/** Detects formats Typst can embed by magic bytes; never trusts extensions or MIME types. */
export function sniffImage(b: Uint8Array): "png" | "jpg" | "gif" | "webp" | "svg" | undefined {
  const ascii = (start: number, end: number) => Buffer.from(b.subarray(start, end)).toString("latin1");
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  const head = Buffer.from(b.subarray(0, 1024)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return undefined;
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
