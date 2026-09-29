import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "typst-compiler",
    include: ["test/**/*.test.ts"],
  },
});
