import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/transpile-worker.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  shims: true,
});
