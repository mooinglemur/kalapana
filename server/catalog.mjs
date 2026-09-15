// Builds catalog.json: what the browser needs to pick and load bundles for a room.
import { compareVersions } from "./semver.mjs";

// The runtime half of a catalog: the pinned versions and the core, tracker and tracker addons bundles.
// trackerAddons is null when none are pinned or they failed analysis.
function runtimeFields({ inputs, core, tracker, trackerAddons = null }) {
  return {
    archipelagoVersion: inputs.archipelago.version,
    pyodide: {
      version: inputs.pyodide.version,
      base: `/runtime/pyodide-${inputs.pyodide.version}/`,
      // Every vendored package, for an apworld the player supplies, which hasn't been analyzed.
      packages: inputs.pyodide.packages,
    },
    core: { bundle: `/bundles/core/${core.key}.zip`, packages: core.result.packages },
    tracker: {
      version: inputs.tracker.version,
      bundle: `/bundles/worlds/${tracker.analysisKey}.zip`,
      packages: tracker.analysis.packages,
    },
    trackerAddons: trackerAddons && {
      version: inputs.trackerAddons.version,
      bundle: `/bundles/worlds/${trackerAddons.analysisKey}.zip`,
      packages: trackerAddons.analysis.packages,
    },
  };
}

export function buildCatalog({ inputs, core, tracker, trackerAddons, items }) {
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
    ...runtimeFields({ inputs, core, tracker, trackerAddons }),
    games,
  };
}

// The previous catalog's games with a new core and tracker, or null when that mix isn't safe: world
// bundles are compiled for the pinned Archipelago and Pyodide versions, so those must be unchanged.
export function catalogWithRuntime(previous, { inputs, core, tracker, trackerAddons }) {
  const runtime = runtimeFields({ inputs, core, tracker, trackerAddons });
  if (
    previous?.schema !== 1 ||
    previous.archipelagoVersion !== runtime.archipelagoVersion ||
    previous.pyodide?.version !== runtime.pyodide.version
  ) {
    return null;
  }
  return { ...previous, ...runtime };
}
