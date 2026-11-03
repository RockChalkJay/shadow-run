import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";

/**
 * A directory only this user can enter, made if missing. The GM process trusts its working directory
 * without asking, so a directory another user made, or a link to one, is refused: in a shared
 * temp directory someone else could otherwise make it first and leave settings in it.
 */
export async function privateDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a plain directory; remove it and start again.`);
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`${dir} belongs to another user; remove it and start again.`);
  await chmod(dir, 0o700);
  return dir;
}

/** Writes a file only this user can read, replacing any earlier one. */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
  // The mode above applies only when the file is created.
  await chmod(path, 0o600);
}
