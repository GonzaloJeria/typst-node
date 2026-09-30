import { accessSync, chmodSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Finds the `typst-sidecar` binary: `$TYPST_SIDECAR_PATH`, else the prebuilt
 * binary from the `@gjeria/typst-sidecar-<platform>-<arch>` optional
 * dependency installed alongside this package. Returns `undefined` when none
 * is available (unsupported platform, or optional dependencies skipped).
 */
export function resolveSidecarBinary(): string | undefined {
  const fromEnv = process.env.TYPST_SIDECAR_PATH;
  if (fromEnv) return fromEnv;
  const name = `@gjeria/typst-sidecar-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${name}/package.json`);
    const binary = path.join(path.dirname(manifest), "bin", process.platform === "win32" ? "typst-sidecar.exe" : "typst-sidecar");
    try {
      accessSync(binary, constants.X_OK);
    } catch {
      // Some installers drop the executable bit; restore it when we can.
      chmodSync(binary, 0o755);
    }
    return binary;
  } catch {
    return undefined;
  }
}
