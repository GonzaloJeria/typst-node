import { defineConfig } from "tsup";

// `dist` is emptied by the build script: the two builds write to it in parallel.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/transpile-worker.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "node20",
    // `import.meta.url` in the CJS build (worker file, fonts, sidecar binary lookup).
    shims: true,
  },
  {
    entry: ["src/templates/cli.ts"],
    format: ["esm"],
    sourcemap: true,
    clean: false,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
