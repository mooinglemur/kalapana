// Downloads and verifies the pinned inputs from inputs.json into a vendor directory.
// Needs `tar` and `bzip2` on PATH. Usage: node deploy/fetch-inputs.mjs <vendor dir>
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const vendorDir = process.argv[2];
if (!vendorDir) {
  console.error("usage: node deploy/fetch-inputs.mjs <vendor dir>");
  process.exit(2);
}
const inputs = JSON.parse(await readFile(new URL("./inputs.json", import.meta.url), "utf8"));
const dest = resolve(vendorDir);

async function download(url, sha256) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${actual}`);
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`${url}: ${lastError.message}`);
}

async function extract(archive, flags, into) {
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  await run("tar", [flags, archive, "-C", into, "--strip-components=1"]);
}

await mkdir(dest, { recursive: true });

console.log(`archipelago ${inputs.archipelago.version}`);
const apArchive = join(dest, "archipelago.tar.gz");
await writeFile(apArchive, await download(inputs.archipelago.url, inputs.archipelago.sha256));
await extract(apArchive, "-xzf", join(dest, "archipelago"));
await rm(apArchive);

console.log(`pyodide ${inputs.pyodide.version}`);
const pyodideArchive = join(dest, "pyodide-core.tar.bz2");
const pyodideDir = join(dest, "pyodide");
await writeFile(pyodideArchive, await download(inputs.pyodide.url, inputs.pyodide.sha256));
await extract(pyodideArchive, "-xjf", pyodideDir);
await rm(pyodideArchive);
// The core release ships a Windows CLI and type definitions nobody here uses.
for (const unused of ["python", "python.bat", "python.exe", "python_cli_entry.mjs", "ffi.d.ts", "pyodide.d.ts"]) {
  await rm(join(pyodideDir, unused), { force: true });
}

// Wheels come from Pyodide's full distribution, verified against the hashes in its own lock file.
const lock = JSON.parse(await readFile(join(pyodideDir, "pyodide-lock.json"), "utf8"));
const wanted = new Set();
const pending = [...inputs.pyodide.packages];
while (pending.length) {
  const name = pending.pop();
  if (wanted.has(name)) continue;
  const entry = lock.packages[name];
  if (!entry) throw new Error(`pyodide package ${name} is not in the lock file`);
  wanted.add(name);
  pending.push(...entry.depends);
}
for (const name of [...wanted].sort()) {
  const entry = lock.packages[name];
  console.log(`  ${entry.file_name}`);
  await writeFile(join(pyodideDir, entry.file_name), await download(inputs.pyodide.packageBaseUrl + entry.file_name, entry.sha256));
}

console.log(`tracker ${inputs.tracker.version}`);
await writeFile(join(dest, "tracker.apworld"), await download(inputs.tracker.url, inputs.tracker.sha256));

const wheelDir = join(dest, "wheels");
await rm(wheelDir, { recursive: true, force: true });
await mkdir(wheelDir, { recursive: true });
for (const wheel of inputs.wheels) {
  const name = basename(new URL(wheel.url).pathname);
  console.log(`  ${name}`);
  await writeFile(join(wheelDir, name), await download(wheel.url, wheel.sha256));
}

await writeFile(join(dest, "inputs.json"), JSON.stringify(inputs, null, 2) + "\n");
console.log(`vendor directory ready: ${dest}`);
