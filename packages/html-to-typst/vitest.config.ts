import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    name: "html-to-typst",
    include: ["test/**/*.test.ts"],
  },
});
