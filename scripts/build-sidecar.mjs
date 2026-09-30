// Builds typst-sidecar for this machine and places it in the matching
// npm/typst-sidecar-<platform>-<arch> package, where @gjeria/typst-compiler
// finds it (the same layout the published platform packages have).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkgDir = path.join(root, "npm", `typst-sidecar-${process.platform}-${process.arch}`);
const { typstSidecar } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const target = process.env.SIDECAR_TARGET ?? typstSidecar.target;

execFileSync("cargo", ["build", "--release", "--locked", "--target", target, "--manifest-path", path.join(root, "crates/typst-sidecar/Cargo.toml")], { stdio: "inherit" });
const exe = path.basename(typstSidecar.binary);
const out = path.join(pkgDir, typstSidecar.binary);
mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(path.join(root, "crates/typst-sidecar/target", target, "release", exe), out);
chmodSync(out, 0o755);
console.log(`typst-sidecar → ${path.relative(root, out)}`);
