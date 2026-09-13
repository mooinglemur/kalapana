// Runs analyzer tasks in a child Node process under the permission model. Apworld code is arbitrary
// Python, so the child gets no network, no child processes or workers, no environment, read access
// only to what the task needs, and write access only to its job directory.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.mjs";
import { readJson } from "./fsutil.mjs";

const RUNNER = join(config.analyzerDir, "run.mjs");
const OUTPUT_TAIL_BYTES = 8000;

// Resolves to the task's result.json. A crash or timeout yields { ok: false, crashed: true }.
export async function runTask(task, { jobDir, input, mounts = {}, timeoutMs = config.analyzerTimeoutMs }) {
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "input.json"), JSON.stringify({ ...input, pyodideDir: config.pyodideDir, mounts }));

  const args = [
    "--permission",
    `--allow-fs-read=${config.analyzerDir}`,
    `--allow-fs-read=${config.pyodideDir}`,
    ...Object.values(mounts).map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-read=${jobDir}`,
    `--allow-fs-write=${jobDir}`,
    RUNNER,
    task,
    jobDir,
  ];
  const child = spawn(process.execPath, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });

  let output = "";
  const keep = (chunk) => {
    output = (output + chunk).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);

  const result = timedOut ? null : await readJson(join(jobDir, "result.json"), null);
  if (result) return result;
  return {
    ok: false,
    crashed: true,
    error: timedOut ? `timed out after ${timeoutMs / 1000}s` : `analyzer exited with code ${exitCode}\n${output}`,
  };
}

export function limiter(concurrency) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
