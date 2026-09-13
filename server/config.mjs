// Runtime configuration, read once from the environment.
import { readFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

function adminToken() {
  if (env.KALAPANA_ADMIN_TOKEN_FILE) return readFileSync(env.KALAPANA_ADMIN_TOKEN_FILE, "utf8").trim() || null;
  return env.KALAPANA_ADMIN_TOKEN?.trim() || null;
}

const vendorDir = resolve(env.KALAPANA_VENDOR_DIR ?? join(appDir, "vendor"));

export const config = {
  appDir,
  vendorDir,
  webDir: join(appDir, "web"),
  runtimeDir: join(appDir, "runtime"),
  analyzerDir: join(appDir, "analyzer"),
  pyodideDir: join(vendorDir, "pyodide"),
  // Shared between pods (CephFS in production).
  dataDir: resolve(env.KALAPANA_DATA_DIR ?? join(appDir, "data")),
  // Per-pod scratch space for analyzer jobs.
  workDir: resolve(env.KALAPANA_WORK_DIR ?? join(tmpdir(), "kalapana")),
  host: env.KALAPANA_HOST ?? "::",
  port: Number(env.KALAPANA_PORT ?? 8080),
  adminToken: adminToken(),
  indexUrl: env.KALAPANA_INDEX_URL ?? "https://codeload.github.com/ionium-ap/Archipelago-index/tar.gz/refs/heads/main",
  // A local index checkout to use instead of downloading, for development.
  indexPath: env.KALAPANA_INDEX_PATH ? resolve(env.KALAPANA_INDEX_PATH) : null,
  // Comma-separated index world names to limit processing to, for development.
  indexWorlds: env.KALAPANA_INDEX_WORLDS
    ? new Set(env.KALAPANA_INDEX_WORLDS.split(",").map((name) => name.trim()).filter(Boolean))
    : null,
  analyzerConcurrency: Number(env.KALAPANA_ANALYZER_CONCURRENCY ?? Math.max(1, Math.min(4, cpus().length))),
  analyzerTimeoutMs: Number(env.KALAPANA_ANALYZER_TIMEOUT_SECONDS ?? 180) * 1000,
  downloadConcurrency: Number(env.KALAPANA_DOWNLOAD_CONCURRENCY ?? 8),
  refreshOnStartup: env.KALAPANA_REFRESH_ON_STARTUP !== "false",
  podName: env.HOSTNAME ?? "local",
  inputs: JSON.parse(readFileSync(join(vendorDir, "inputs.json"), "utf8")),
};
