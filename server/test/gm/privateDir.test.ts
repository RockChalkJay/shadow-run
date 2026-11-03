import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateDir, writePrivateFile } from "../../src/gm/privateDir.js";

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

describe("writePrivateFile", () => {
  it("writes a file only this user can read", async () => {
    const file = join(await base(), "secret.json");
    await writePrivateFile(file, "one");
    expect(await mode(file)).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("one");
  });

  it("replaces an earlier file and tightens it if it was left open", async () => {
    const file = join(await base(), "secret.json");
    await writeFile(file, "old", { mode: 0o644 });
    await chmod(file, 0o644);
    await writePrivateFile(file, "new");
    expect(await mode(file)).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("new");
  });
});
