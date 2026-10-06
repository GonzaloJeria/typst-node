// Builds typst-sidecar for this machine and places it in the matching
// npm/sidecar-<platform>-<arch> package, where @typdf/pdf
// finds it (the same layout the published platform packages have).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// SIDECAR_PKG=sidecar-<platform>-<arch> cross-compiles for another package.
const pkgDir = path.join(root, "npm", process.env.SIDECAR_PKG ?? `sidecar-${process.platform}-${process.arch}`);
const { typstSidecar } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const target = process.env.SIDECAR_TARGET ?? typstSidecar.target;
// SIDECAR_PROFILE=ci compiles several times faster (no LTO) for tests.
const profile = process.env.SIDECAR_PROFILE ?? "release";

// SIDECAR_CARGO=zigbuild links with Zig (cargo-zigbuild), as releases do.
const command = process.env.SIDECAR_CARGO ?? "build";

execFileSync("cargo", [command, "--profile", profile, "--locked", "--target", target, "--manifest-path", path.join(root, "crates/typst-sidecar/Cargo.toml")], { stdio: "inherit" });
const exe = path.basename(typstSidecar.binary);
const out = path.join(pkgDir, typstSidecar.binary);
mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(path.join(root, "crates/typst-sidecar/target", target, profile, exe), out);
chmodSync(out, 0o755);
console.log(`typst-sidecar → ${path.relative(root, out)}`);
