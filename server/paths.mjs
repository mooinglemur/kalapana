// Layout of the shared data directory.
import { join } from "node:path";
import { config } from "./config.mjs";

// Bump when analyzer output changes, so results produced by older code are recomputed.
export const ANALYZER_VERSION = 1;

const data = (...parts) => join(config.dataDir, ...parts);

export const paths = {
  catalog: () => data("catalog.json"),
  lastRefresh: () => data("last-refresh.json"),
  refreshRequest: () => data("refresh-requested.json"),
  lease: () => data("refresh.lease"),
  apworld: (sha256) => data("apworlds", `${sha256}.apworld`),
  unlockedDownloads: () => data("apworlds", "unlocked-downloads.json"),
  coreDir: (key) => data(`core-v${ANALYZER_VERSION}`, key),
  analysisDir: (key) => data(`analysis-v${ANALYZER_VERSION}`, key),
};
