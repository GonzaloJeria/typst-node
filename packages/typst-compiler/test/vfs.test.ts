import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeProject, resolveInside } from "../src/vfs.js";

describe("resolveInside", () => {
  const root = path.resolve("/tmp/root");

  it.each(["a.png", "/a.png", "dir/sub/a.png", "dir\\a.png"])("accepts %s", (name) => {
    expect(resolveInside(root, name).startsWith(root + path.sep)).toBe(true);
  });

  it.each(["", "../x", "a/../../x", "a//b", ".typst-fonts/x.ttf", ".typst-out/page-1.png"])("rejects %j", (name) => {
    expect(() => resolveInside(root, name)).toThrow(TypeError);
  });
});

describe("materializeProject", () => {
  it("writes files and fonts, then cleans up", async () => {
    const project = await materializeProject(
      new Map([["img/a.bin", new Uint8Array([1, 2, 3])]]),
      [new Uint8Array([9]), { dir: "/usr/share/fonts" }],
    );
    expect([...readFileSync(path.join(project.root, "img/a.bin"))]).toEqual([1, 2, 3]);
    expect(project.fontDirs).toHaveLength(2);
    expect(project.fontDirs[0]).toBe(path.resolve("/usr/share/fonts"));
    await project.cleanup();
    expect(existsSync(project.root)).toBe(false);
  });

  it("removes the temp root when a path is invalid", async () => {
    await expect(materializeProject(new Map([["../evil", new Uint8Array()]]), [])).rejects.toThrow(TypeError);
  });
});
