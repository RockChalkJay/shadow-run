import { chmod, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateDir } from "../../src/gm/privateDir.js";

const base = () => mkdtemp(join(tmpdir(), "sr-priv-"));
const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe("privateDir", () => {
  it("makes a directory only this user can enter", async () => {
    const dir = join(await base(), "a", "b");
    expect(await privateDir(dir)).toBe(dir);
    expect(await mode(dir)).toBe(0o700);
  });

  it("tightens a directory that already exists", async () => {
    const dir = join(await base(), "open");
    await privateDir(dir);
    await chmod(dir, 0o755);
    await privateDir(dir);
    expect(await mode(dir)).toBe(0o700);
  });

  it("refuses a link, which could lead somewhere else", async () => {
    const root = await base();
    const target = join(root, "target");
    await privateDir(target);
    const link = join(root, "link");
    await symlink(target, link);
    await expect(privateDir(link)).rejects.toThrow(/not a plain directory/);
  });

  it("refuses a file in its place", async () => {
    const file = join(await base(), "file");
    await writeFile(file, "x");
    await expect(privateDir(file)).rejects.toThrow();
  });
});
