// Refresh pipeline: fetch the index, download apworlds, analyze new ones in the sandbox, publish the
// catalog. Any pod may request a refresh; whichever pod holds the lease does the work.
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { buildCatalog, catalogWithRuntime } from "./catalog.mjs";
import { config } from "./config.mjs";
import { exists, publishDirectory, readJson, writeFileAtomic } from "./fsutil.mjs";
import { Lease } from "./lease.mjs";
import { log } from "./log.mjs";
import { ANALYZER_VERSION, paths } from "./paths.mjs";
import { limiter, runTask } from "./sandbox.mjs";

const run = promisify(execFile);
const MAX_APWORLD_BYTES = 128 * 2 ** 20;
const MAX_FAILURES_REPORTED = 1000;
// The analyzer loads every vendored Pyodide package, and records which ones a world actually imports.
const ANALYZER_PACKAGES = config.inputs.pyodide.packages;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const status = {
  pod: config.podName,
  running: false,
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  lastError: null,
  counts: {},
  failures: [],
};
let loopActive = false;

export async function requestRefresh(reason) {
  await writeFileAtomic(paths.refreshRequest(), JSON.stringify({ reason, pod: config.podName, at: new Date().toISOString() }));
  void refreshLoop();
}

// Picks up requests that arrived while another pod held the lease, or that a crashed pod left behind.
export function startRefreshWatcher() {
  setInterval(() => {
    exists(paths.refreshRequest())
      .then((pending) => pending && refreshLoop())
      .catch((err) => log("refresh watcher:", err));
  }, 30_000).unref();
}

export async function refreshStatus() {
  return {
    thisPod: status,
    pendingRequest: await readJson(paths.refreshRequest(), null),
    lease: await readJson(paths.lease(), null).catch(() => null),
    lastRefresh: await readJson(paths.lastRefresh(), null),
    lastRefreshWithChanges: await readJson(paths.lastRefreshWithChanges(), null),
  };
}

async function refreshLoop() {
  if (loopActive) return;
  loopActive = true;
  let lease = null;
  try {
    lease = await Lease.acquire(paths.lease(), config.podName);
    if (!lease) {
      const holder = await readJson(paths.lease(), null).catch(() => null);
      const expires = holder?.expires ? new Date(holder.expires).toISOString() : "unknown";
      log(`refresh requested, but another pod holds the refresh lease (${holder?.owner ?? "unknown"}, expires ${expires})`);
      return;
    }
    while (!lease.lost && (await exists(paths.refreshRequest()))) {
      await rm(paths.refreshRequest(), { force: true });
      await refreshOnce(lease);
    }
  } catch (err) {
    log("refresh failed:", err.stack ?? err);
  } finally {
    await lease?.release();
    loopActive = false;
  }
}

function recordFailure(item, error) {
  status.counts.failed = (status.counts.failed ?? 0) + 1;
  const lines = String(error).trim().split("\n");
  const summary = lines[lines.length - 1].slice(0, 500);
  log(`failed: ${item.module} ${item.version}: ${summary}`);
  if (status.failures.length < MAX_FAILURES_REPORTED) {
    status.failures.push({ module: item.module, version: item.version, error: summary });
  }
}

// Logs a progress line every 30 seconds until the returned function is called.
function logProgress(describe) {
  const timer = setInterval(() => log(describe()), 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

const secondsSince = (start) => Math.round((Date.now() - start) / 1000);

async function refreshOnce(lease) {
  Object.assign(status, {
    running: true,
    phase: "starting",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    counts: {},
    failures: [],
  });
  const work = join(config.workDir, `refresh-${randomBytes(4).toString("hex")}`);
  await mkdir(work, { recursive: true });
  const started = Date.now();
  log("refresh started");
  try {
    status.phase = "core";
    const core = await ensureCore(work);

    const context = await analysisContext();
    const withAnalysisKey = (item) => Object.assign(item, { analysisKey: sha256(`${context}:${item.key}`) });

    status.phase = "tracker";
    const trackerFile = join(config.vendorDir, "tracker.apworld");
    const tracker = withAnalysisKey({
      kind: "apworld",
      module: "tracker",
      version: config.inputs.tracker.version,
      key: sha256(await readFile(trackerFile)),
      file: trackerFile,
    });
    tracker.analysis = await ensureAnalysis(tracker, core, work);
    if (!tracker.analysis.ok) throw new Error(`tracker.apworld failed analysis: ${tracker.analysis.error}`);

    log(`tracker ${tracker.version} ready`);

    // Optional: without the addons the tracker still works, just without their commands.
    let trackerAddons = null;
    if (config.inputs.trackerAddons) {
      status.phase = "tracker addons";
      const addonsFile = join(config.vendorDir, "tracker_addons.apworld");
      const addonTask = await readFile(join(config.analyzerDir, "tasks", ADDON_TASK_FILE));
      const addons = withAnalysisKey({
        kind: "addon",
        module: "tracker_addons",
        version: config.inputs.trackerAddons.version,
        // The addons load against this tracker build and are analyzed by their own task, so both are part of the key.
        key: sha256(`${sha256(await readFile(addonsFile))}:${tracker.analysisKey}:${sha256(addonTask)}`),
        file: addonsFile,
        trackerAnalysisKey: tracker.analysisKey,
      });
      addons.analysis = await ensureAnalysis(addons, core, work);
      if (addons.analysis.ok) {
        trackerAddons = addons;
        log(`tracker addons ${addons.version} ready`);
      } else {
        recordFailure(addons, addons.analysis.error);
      }
    }
    await publishRuntime(lease, core, tracker, trackerAddons);

    status.phase = "index";
    const indexStarted = Date.now();
    const indexRoot = await fetchIndex(work);
    const parsed = await runTask("parse_index", { jobDir: join(work, "parse-index"), mounts: { "/index": indexRoot } });
    if (!parsed.ok) throw new Error(`index parse failed: ${parsed.error}`);
    if (parsed.archipelago_version !== config.inputs.archipelago.version) {
      throw new Error(`index targets Archipelago ${parsed.archipelago_version}, but this image has ${config.inputs.archipelago.version}`);
    }
    for (const [file, error] of Object.entries(parsed.errors)) recordFailure({ module: file, version: "-" }, error);
    const items = resolveItems(parsed, indexRoot);
    Object.assign(status.counts, { versions: items.length, downloaded: 0, analyzed: 0, cached: 0 });
    log(`index: ${Object.keys(parsed.worlds).length} worlds, ${items.length} versions to process (${secondsSince(indexStarted)}s)`);

    status.phase = "download";
    const downloadStarted = Date.now();
    const unlocked = await readJson(paths.unlockedDownloads(), {});
    const downloadLimit = limiter(config.downloadConcurrency);
    let downloadsChecked = 0;
    const stopDownloadProgress = logProgress(
      () => `downloading: ${downloadsChecked}/${items.length} checked, ${status.counts.downloaded} new, ${status.counts.failed ?? 0} failed`,
    );
    try {
      await Promise.all(
        items.map((item) =>
          downloadLimit(async () => {
            try {
              // Core worlds come from the AP source in the image.
              if (item.error || item.kind === "core" || lease.lost) return;
              try {
                await ensureDownloaded(item, unlocked);
              } catch (err) {
                item.error = err.message;
              }
              if (item.error) recordFailure(item, item.error);
            } finally {
              downloadsChecked++;
            }
          }),
        ),
      );
    } finally {
      stopDownloadProgress();
    }
    await writeFileAtomic(paths.unlockedDownloads(), JSON.stringify(unlocked, null, 1));
    log(`downloads done: ${status.counts.downloaded} new, ${status.counts.failed ?? 0} failed (${secondsSince(downloadStarted)}s)`);

    status.phase = "analyze";
    const analyzeStarted = Date.now();
    const toAnalyze = items.filter((item) => !item.error);
    const analyzeLimit = limiter(config.analyzerConcurrency);
    let analysesDone = 0;
    const describeAnalysis = () =>
      `${analysesDone}/${toAnalyze.length} (cached ${status.counts.cached}, analyzed ${status.counts.analyzed}, failed ${status.counts.failed ?? 0})`;
    const stopAnalyzeProgress = logProgress(() => `analyzing: ${describeAnalysis()}`);
    try {
      await Promise.all(
        toAnalyze.map((item) =>
          analyzeLimit(async () => {
            if (lease.lost) return;
            item.analysis = await ensureAnalysis(withAnalysisKey(item), core, work);
            analysesDone++;
            if (!item.analysis.ok) recordFailure(item, item.analysis.error);
          }),
        ),
      );
    } finally {
      stopAnalyzeProgress();
    }
    if (lease.lost) throw new Error("the refresh lease was lost to another pod");
    log(`analysis done: ${describeAnalysis()} (${secondsSince(analyzeStarted)}s)`);

    status.phase = "publish";
    const catalog = buildCatalog({ inputs: config.inputs, core, tracker, trackerAddons, items });
    await writeFileAtomic(paths.catalog(), JSON.stringify(catalog));
    const summary = {
      publishedAt: catalog.generatedAt,
      pod: config.podName,
      seconds: Math.round((Date.now() - started) / 1000),
      games: Object.keys(catalog.games).length,
      counts: status.counts,
      failures: status.failures,
    };
    await writeFileAtomic(paths.lastRefresh(), JSON.stringify(summary, null, 1));
    // Every pod start refreshes, and a cache-only run would otherwise hide the last one that did real work.
    if (status.counts.downloaded || status.counts.analyzed) {
      await writeFileAtomic(paths.lastRefreshWithChanges(), JSON.stringify(summary, null, 1));
    }
    log(`catalog published: ${summary.games} games from ${items.length} versions in ${summary.seconds}s`, JSON.stringify(status.counts));
  } catch (err) {
    status.lastError = String(err.message ?? err);
    throw err;
  } finally {
    Object.assign(status, { running: false, phase: "idle", finishedAt: new Date().toISOString() });
    await rm(work, { recursive: true, force: true });
  }
}

// Points the existing catalog at the new core, tracker and addons bundles as soon as they exist. A new
// image serves its page immediately, and without this that page would run against the previous image's
// runtime until the whole index had been processed.
async function publishRuntime(lease, core, tracker, trackerAddons) {
  const previous = await readJson(paths.catalog(), null);
  const updated = previous && catalogWithRuntime(previous, { inputs: config.inputs, core, tracker, trackerAddons });
  if (!updated || lease.lost) return;
  if (
    updated.core.bundle === previous.core?.bundle &&
    updated.tracker.bundle === previous.tracker?.bundle &&
    updated.trackerAddons?.bundle === previous.trackerAddons?.bundle
  ) {
    return;
  }
  await writeFileAtomic(paths.catalog(), JSON.stringify(updated));
  log("catalog now uses the new core and tracker bundles; games follow when this refresh finishes");
}

async function fetchIndex(work) {
  if (config.indexPath) return config.indexPath;
  const response = await fetch(config.indexUrl, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`index download failed: HTTP ${response.status}`);
  const archive = join(work, "index.tar.gz");
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const root = join(work, "index");
  await mkdir(root);
  await run("tar", ["-xzf", archive, "-C", root, "--strip-components=1"]);
  return root;
}

// Mirrors the lobby's apwm rules: disabled worlds are skipped, supported worlds come from the AP
// source, and each version resolves to a local file, its own URL, or default_url.
function resolveItems(parsed, indexRoot) {
  const items = [];
  const indexDir = resolve(indexRoot, parsed.index_dir);
  for (const [module, world] of Object.entries(parsed.worlds)) {
    if (world.disabled) continue;
    if (config.indexWorlds && !config.indexWorlds.has(module)) continue;
    if (world.supported) {
      const version = parsed.archipelago_version;
      items.push({ kind: "core", module, version, key: sha256(`core:${version}:${module}`) });
    }
    for (const [version, origin] of Object.entries(world.versions ?? {})) {
      const item = { kind: "apworld", module, version, lockedSha256: parsed.lock[module]?.[version] ?? null };
      if (origin?.local) {
        item.localPath = resolve(indexDir, origin.local);
        if (relative(indexRoot, item.localPath).startsWith(`..${sep}`)) item.error = "local path points outside the index";
      } else {
        item.url = (origin?.url ?? world.default_url)?.replaceAll("{{version}}", version);
        if (!item.url) item.error = "no URL for this version";
      }
      items.push(item);
    }
  }
  return items;
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_APWORLD_BYTES) throw new Error(`larger than ${MAX_APWORLD_BYTES} bytes`);
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`download failed: ${lastError.message}`);
}

async function ensureDownloaded(item, unlocked) {
  const known = item.lockedSha256 ?? (item.url ? unlocked[item.url] : null);
  if (known && (await exists(paths.apworld(known)))) {
    Object.assign(item, { key: known, file: paths.apworld(known) });
    return;
  }
  const bytes = item.localPath ? await readFile(item.localPath) : await download(item.url);
  const actual = sha256(bytes);
  if (item.lockedSha256 && actual !== item.lockedSha256) {
    throw new Error(`sha256 mismatch: index.lock has ${item.lockedSha256}, got ${actual}`);
  }
  if (!item.lockedSha256 && item.url) unlocked[item.url] = actual;
  await writeFileAtomic(paths.apworld(actual), bytes);
  Object.assign(item, { key: actual, file: paths.apworld(actual) });
  status.counts.downloaded++;
}

// Runtime modules only the browser imports. Editing them rebuilds the core bundle but doesn't
// invalidate apworld analyses.
const BROWSER_ONLY_RUNTIME = new Set(["ui_bridge.py", "browser_websocket.py", "datapackage_cache.py"]);
const ADDON_TASK_FILE = "analyze_addon.py";

async function hashSources(hash, dir, include = () => true) {
  for (const name of (await readdir(dir)).sort()) {
    if (name.endsWith(".py") && include(name)) hash.update(`${name}\n`).update(await readFile(join(dir, name)));
  }
}

// The core bundle depends on the pinned inputs and on all of kalapana's runtime and analyzer code.
async function coreKey() {
  const hash = createHash("sha256").update(`core-v${ANALYZER_VERSION}\n`).update(JSON.stringify(config.inputs));
  await hashSources(hash, config.runtimeDir);
  await hashSources(hash, join(config.analyzerDir, "tasks"));
  return hash.digest("hex");
}

// Analyses depend on everything the analyzer runs, so fixing the analyzer retries earlier failures.
// World analyses never load the tracker addons, so the addons input and task stay out of this hash:
// pinning a new addons release rebuilds only the addons bundle, not every world. The addons key covers them.
async function analysisContext() {
  const { trackerAddons, ...worldInputs } = config.inputs;
  const hash = createHash("sha256").update(`analysis-v${ANALYZER_VERSION}\n`).update(JSON.stringify(worldInputs));
  await hashSources(hash, config.runtimeDir, (name) => !BROWSER_ONLY_RUNTIME.has(name));
  await hashSources(hash, join(config.analyzerDir, "tasks"), (name) => name !== ADDON_TASK_FILE);
  return hash.digest("hex");
}

async function ensureCore(work) {
  const key = await coreKey();
  const dir = paths.coreDir(key);
  const cached = await readJson(join(dir, "result.json"), null);
  if (cached?.ok) {
    log(`core bundle ${key.slice(0, 12)} already built`);
    return { key, result: cached };
  }

  log(`building core bundle ${key.slice(0, 12)}`);
  const coreStarted = Date.now();
  const stopProgress = logProgress(() => `still building core bundle (${secondsSince(coreStarted)}s)`);
  const jobDir = join(work, "core");
  const result = await runTask("build_core", {
    jobDir,
    input: { packages: ANALYZER_PACKAGES },
    mounts: {
      "/apsrc": join(config.vendorDir, "archipelago"),
      "/wheels": join(config.vendorDir, "wheels"),
      "/sources": join(config.vendorDir, "sources"),
      "/runtime": config.runtimeDir,
    },
    timeoutMs: 600_000,
  }).finally(stopProgress);
  if (!result.ok) throw new Error(`core bundle build failed: ${result.error}`);
  log(`core bundle built in ${secondsSince(coreStarted)}s (${result.files} files, ${Math.round(result.bytes / 1024)} KB)`);
  await publishDirectory(dir, ["result.json", "core.zip", "core-src.zip"].map((name) => [join(jobDir, name), name]));
  return { key, result };
}

async function ensureAnalysis(item, core, work) {
  const dir = paths.analysisDir(item.analysisKey);
  const cached = await readJson(join(dir, "result.json"), null);
  if (cached) {
    status.counts.cached = (status.counts.cached ?? 0) + 1;
    return cached;
  }

  const jobDir = join(work, `analyze-${item.key.slice(0, 16)}-${randomBytes(3).toString("hex")}`);
  await mkdir(jobDir, { recursive: true });
  const mounts = { "/core": paths.coreDir(core.key) };
  if (item.kind === "core") mounts["/apsrc"] = join(config.vendorDir, "archipelago");
  else await copyFile(item.file, join(jobDir, "input.apworld"));
  if (item.kind === "addon") mounts["/tracker"] = paths.analysisDir(item.trackerAnalysisKey);

  const result = await runTask(item.kind === "addon" ? "analyze_addon" : "analyze_world", {
    jobDir,
    input: { packages: ANALYZER_PACKAGES, kind: item.kind, module: item.module },
    mounts,
  });
  status.counts.analyzed = (status.counts.analyzed ?? 0) + 1;
  // Crashes and timeouts might be transient, so only completed analyses are cached.
  if (!result.crashed) {
    const files = [[join(jobDir, "result.json"), "result.json"]];
    if (result.ok) files.push([join(jobDir, "bundle.zip"), "bundle.zip"]);
    await publishDirectory(dir, files);
  }
  await rm(jobDir, { recursive: true, force: true });
  return result;
}
