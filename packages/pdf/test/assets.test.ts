import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssetError, isPrivateAddress, resolveAssets, sniffImage } from "../src/index.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

describe("sniffImage", () => {
  it.each([
    [PNG, "png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "jpg"],
    [Buffer.from("GIF89a"), "gif"],
    [Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "webp"],
    [SVG, "svg"],
    [Buffer.from("﻿<!-- c -->\n<svg viewBox='0 0 1 1'></svg>"), "svg"],
    [Buffer.from("<html><body>404</body></html>"), undefined],
    [Buffer.from("%PDF-1.7"), undefined],
  ])("%#", (bytes, expected) => {
    expect(sniffImage(new Uint8Array(bytes))).toBe(expected);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    ["127.0.0.1", true], ["10.1.2.3", true], ["172.16.0.1", true], ["172.32.0.1", false],
    ["192.168.1.1", true], ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true],
    ["224.0.0.1", true], ["8.8.8.8", false], ["::1", true], ["fd00::1", true], ["fe80::1", true],
    ["::ffff:127.0.0.1", true], ["::ffff:8.8.8.8", false], ["2606:4700::1111", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("resolveAssets: data and local", () => {
  const base = mkdtempSync(path.join(tmpdir(), "assets-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  writeFileSync(path.join(base, "logo.svg"), SVG);
  writeFileSync(path.join(outside, "secret.png"), PNG);
  symlinkSync(path.join(outside, "secret.png"), path.join(base, "link.png"));

  it("decodes data URIs and dedupes by content hash", async () => {
    const uri = `data:image/png;base64,${PNG.toString("base64")}`;
    const r = await resolveAssets([uri, "data:image/svg+xml," + encodeURIComponent(SVG.toString())]);
    expect([...r.mapping.values()]).toEqual([expect.stringMatching(/^assets\/[0-9a-f]{16}\.png$/), expect.stringMatching(/\.svg$/)]);
    expect(r.files.size).toBe(2);
  });

  it("reads local files inside baseDir only", async () => {
    const ok = await resolveAssets(["logo.svg", "/logo.svg?v=2"], { baseDir: base });
    expect(ok.files.size).toBe(1);
    await expect(resolveAssets(["logo.svg"])).rejects.toThrow(/local assets are disabled/);
    await expect(resolveAssets(["../" + path.basename(outside) + "/secret.png"], { baseDir: base })).rejects.toThrow(/escapes baseDir/);
    await expect(resolveAssets(["link.png"], { baseDir: base })).rejects.toThrow(/escapes baseDir/);
    await expect(resolveAssets(["file://" + path.join(outside, "secret.png")], { baseDir: base })).rejects.toThrow(/escapes baseDir/);
  });

  it("rejects non-images and unknown schemes", async () => {
    await expect(resolveAssets(["data:text/plain,hello"])).rejects.toBeInstanceOf(AssetError);
    await expect(resolveAssets(["ftp://x/y.png"])).rejects.toThrow(/unsupported URL scheme/);
  });

  it("skips failures with warnings when onError is skip", async () => {
    const r = await resolveAssets(["missing.png", "data:,x"], { baseDir: base, onError: "skip" });
    expect([...r.mapping.values()]).toEqual([null, null]);
    expect(r.warnings).toHaveLength(2);
  });

  it("uses the custom resolver first", async () => {
    const r = await resolveAssets(["cms://logo"], { resolve: (src) => (src === "cms://logo" ? PNG : undefined) });
    expect(r.files.size).toBe(1);
  });

  it("enforces size limits", async () => {
    const uri = `data:image/png;base64,${PNG.toString("base64")}`;
    await expect(resolveAssets([uri], { maxAssetBytes: 10 })).rejects.toThrow(/exceeds 10 bytes/);
    await expect(resolveAssets([uri, "logo.svg"], { baseDir: base, maxTotalBytes: 100 })).rejects.toThrow(/total asset size/);
  });
});

describe("resolveAssets: remote", () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/a.png") return res.end(PNG);
      if (req.url === "/big.png") return res.end(Buffer.alloc(2048));
      if (req.url === "/redirect") return res.writeHead(302, { location: "/a.png" }).end();
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/slow") return setTimeout(() => res.end(PNG), 2000);
      res.writeHead(404).end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const open = { allowRemote: true, allowPrivateNetwork: true };

  it("is disabled by default", async () => {
    await expect(resolveAssets([`${origin}/a.png`])).rejects.toThrow(/remote assets are disabled/);
  });

  it("blocks private addresses by IP and by DNS name (SSRF)", async () => {
    await expect(resolveAssets([`${origin}/a.png`], { allowRemote: true })).rejects.toThrow(/Blocked private address/);
    const port = new URL(origin).port;
    await expect(resolveAssets([`http://localhost:${port}/a.png`], { allowRemote: true })).rejects.toThrow(/Blocked private address/);
  });

  it("fetches, follows redirects and enforces limits", async () => {
    const r = await resolveAssets([`${origin}/a.png`, `${origin}/redirect`], open);
    expect(r.files.size).toBe(1);
    await expect(resolveAssets([`${origin}/loop`], open)).rejects.toThrow(/Too many redirects/);
    await expect(resolveAssets([`${origin}/missing`], open)).rejects.toThrow(/HTTP 404/);
    await expect(resolveAssets([`${origin}/big.png`], { ...open, maxAssetBytes: 1024 })).rejects.toThrow(/exceeds 1024 bytes/);
    await expect(resolveAssets([`${origin}/slow`], { ...open, timeoutMs: 100 })).rejects.toThrow(/Timed out/);
  });

  it("applies the host allowlist", async () => {
    await expect(resolveAssets([`${origin}/a.png`], { ...open, allowedHosts: ["cdn.example.com"] })).rejects.toThrow(/Host not allowed/);
    const r = await resolveAssets([`${origin}/a.png`], { ...open, allowedHosts: [/^127\./] });
    expect(r.files.size).toBe(1);
  });
});
