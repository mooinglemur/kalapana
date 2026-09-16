import { mkdir } from "node:fs/promises";
import { config } from "./config.mjs";
import { startHttp } from "./http.mjs";
import { log } from "./log.mjs";
import { requestRefresh, startRefreshWatcher } from "./refresh.mjs";

log(
  `kalapana ${config.version} starting on pod ${config.podName}: Archipelago ${config.inputs.archipelago.version},`,
  `Pyodide ${config.inputs.pyodide.version}, tracker ${config.inputs.tracker.version},`,
  `tracker addons ${config.inputs.trackerAddons?.version ?? "none"}, data ${config.dataDir}`,
);
if (!config.adminToken) log("no admin token configured; /admin endpoints are disabled");

await mkdir(config.dataDir, { recursive: true });
await mkdir(config.workDir, { recursive: true });

const server = startHttp();
startRefreshWatcher();
if (config.refreshOnStartup) await requestRefresh("startup");

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
