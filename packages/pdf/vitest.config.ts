import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    name: "pdf",
    include: ["test/**/*.test.ts"],
  },
});
