import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  allowPrivateNetwork: boolean;
  isHostAllowed: (host: string) => boolean;
  signal?: AbortSignal | undefined;
}

export class AssetFetchError extends Error {
  override name = "AssetFetchError";
}

/**
 * GETs a URL with SSRF protection. Addresses are checked inside the socket's
 * `lookup`, i.e. for the exact IP being connected to, which also defeats DNS
 * rebinding. Redirects are followed manually and re-validated at every hop.
 */
export async function fetchBytes(url: string, limits: FetchLimits): Promise<Uint8Array> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await request(current, limits);
    if (res.redirect) {
      if (hop >= limits.maxRedirects) throw new AssetFetchError(`Too many redirects for ${url}`);
      current = new URL(res.redirect, current);
      continue;
    }
    return res.body!;
  }
}

function request(url: URL, limits: FetchLimits): Promise<{ redirect?: string; body?: Uint8Array }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new AssetFetchError(`Unsupported protocol: ${url.protocol}`));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!limits.isHostAllowed(host)) return Promise.reject(new AssetFetchError(`Host not allowed: ${host}`));
  if (!limits.allowPrivateNetwork && isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new AssetFetchError(`Blocked private address: ${host}`));
  }

  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      {
        timeout: limits.timeoutMs,
        signal: limits.signal,
        headers: { accept: "image/*", "user-agent": "typdf" },
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
            if (err) return callback(err, "", 0);
            const usable = limits.allowPrivateNetwork
              ? addresses
              : addresses.filter((a) => !isPrivateAddress(a.address));
            if (usable.length === 0) {
              return callback(new AssetFetchError(`Blocked private address for ${hostname}`), "", 0);
            }
            if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
            else callback(null, usable[0]!.address, usable[0]!.family);
          });
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return reject(new AssetFetchError(`HTTP ${status} for ${url.href}`));
        }
        const declared = Number(res.headers["content-length"]);
        if (declared > limits.maxBytes) {
          res.destroy();
          return reject(new AssetFetchError(`Asset exceeds ${limits.maxBytes} bytes: ${url.href}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limits.maxBytes) {
            res.destroy(new AssetFetchError(`Asset exceeds ${limits.maxBytes} bytes: ${url.href}`));
          } else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ body: new Uint8Array(Buffer.concat(chunks)) }));
      },
    );
    req.on("timeout", () => req.destroy(new AssetFetchError(`Timed out after ${limits.timeoutMs} ms: ${url.href}`)));
    req.on("error", reject);
  });
}

/** Loopback, private, link-local, CGNAT, multicast, reserved and unspecified ranges. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return (
    v6 === "::" || v6 === "::1" ||
    /^f[cd]/.test(v6) ||          // fc00::/7 unique local
    /^fe[89ab]/.test(v6) ||       // fe80::/10 link local
    /^ff/.test(v6) ||             // multicast
    v6.startsWith("64:ff9b:") ||  // NAT64
    v6.startsWith("2001:db8:")    // documentation
  );
}
