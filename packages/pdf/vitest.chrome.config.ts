import { defineConfig } from "vitest/config";

/** `pnpm test:chrome`: compares the library's output with Chrome (needs Chromium and Typst). */
export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    include: ["test/chrome/*.compare.ts"],
    testTimeout: 120_000,
  },
});
