// File helpers for the shared data directory, which other pods read while this one writes.
import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const uniqueSuffix = () => `${process.pid}-${randomBytes(4).toString("hex")}`;

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

// Readers never see a partially written file: write a sibling, then rename over the target.
export async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${uniqueSuffix()}`;
  await writeFile(temp, data);
  await rename(temp, path);
}

// Publishes files as a complete directory. If another pod published the same directory first, its copy wins.
export async function publishDirectory(target, files) {
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.staging-${uniqueSuffix()}`;
  await mkdir(staging);
  try {
    for (const [source, name] of files) await copyFile(source, join(staging, name));
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    if (!["EEXIST", "ENOTEMPTY"].includes(err.code)) throw err;
  }
}
