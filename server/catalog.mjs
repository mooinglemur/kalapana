// Builds catalog.json: what the browser needs to pick and load bundles for a room.
import { config } from "./config.mjs";
import { compareVersions } from "./semver.mjs";

export function buildCatalog({ core, tracker, items }) {
  const games = {};
  for (const item of items) {
    const analysis = item.analysis;
    if (!analysis?.ok) continue;
    for (const world of analysis.worlds) {
      if (!world.checksum || world.game === "Archipelago") continue;
      const entries = (games[world.game] ??= []);
      const bundle = `/bundles/worlds/${item.analysisKey}.zip`;
      if (entries.some((entry) => entry.bundle === bundle && entry.version === item.version)) continue;
      entries.push({
        module: analysis.module,
        version: item.version,
        source: item.kind === "core" ? "core" : "index",
        checksum: world.checksum,
        bundle,
        packages: analysis.packages,
        needsYaml: world.needs_yaml,
        disableUt: world.disable_ut,
        map: world.map && { externalPack: world.map.external_pack, internalPack: world.map.internal_pack },
      });
    }
  }
  // Newest first: when several versions share a datapackage checksum, the browser takes the first.
  for (const entries of Object.values(games)) entries.sort((a, b) => compareVersions(b.version, a.version));

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    archipelagoVersion: config.inputs.archipelago.version,
    pyodide: {
      version: config.inputs.pyodide.version,
      base: `/runtime/pyodide-${config.inputs.pyodide.version}/`,
      // Every vendored package, for an apworld the player supplies, which hasn't been analyzed.
      packages: config.inputs.pyodide.packages,
    },
    core: { bundle: `/bundles/core/${core.key}.zip`, packages: core.result.packages },
    tracker: {
      version: config.inputs.tracker.version,
      bundle: `/bundles/worlds/${tracker.analysisKey}.zip`,
      packages: tracker.analysis.packages,
    },
    games,
  };
}
