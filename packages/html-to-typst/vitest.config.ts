import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "html-to-typst",
    include: ["test/**/*.test.ts"],
  },
});
