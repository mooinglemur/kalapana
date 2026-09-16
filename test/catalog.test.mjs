import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, catalogWithRuntime } from "../server/catalog.mjs";

function inputs(archipelago = "0.6.7", pyodide = "0.29.4") {
  return {
    archipelago: { version: archipelago },
    pyodide: { version: pyodide, packages: ["pyyaml"] },
    tracker: { version: "0.3.3" },
    trackerAddons: { version: "0.1.1" },
  };
}

function runtime(coreKey, trackerKey, addonsKey = null) {
  return {
    core: { key: coreKey, result: { packages: ["pyyaml"] } },
    tracker: { analysisKey: trackerKey, analysis: { packages: [] } },
    trackerAddons: addonsKey && { analysisKey: addonsKey, analysis: { packages: [] } },
  };
}

const items = [
  {
    kind: "core",
    version: "0.6.7",
    analysisKey: "tunic-key",
    analysis: {
      ok: true,
      module: "tunic",
      packages: [],
      worlds: [{ game: "TUNIC", checksum: "abc", needs_yaml: false, disable_ut: false, map: null }],
    },
  },
];

test("a new core and tracker keep the previous catalog's games", () => {
  const previous = buildCatalog({ inputs: inputs(), ...runtime("old-core", "old-tracker"), version: "0.1.0", items });
  const updated = catalogWithRuntime(previous, {
    inputs: inputs(), ...runtime("new-core", "new-tracker"), version: "0.1.0-abc1234",
  });
  assert.equal(previous.kalapanaVersion, "0.1.0");
  assert.equal(updated.kalapanaVersion, "0.1.0-abc1234");
  assert.equal(updated.core.bundle, "/bundles/core/new-core.zip");
  assert.equal(updated.tracker.bundle, "/bundles/worlds/new-tracker.zip");
  assert.deepEqual(updated.games, previous.games);
  assert.equal(updated.generatedAt, previous.generatedAt);
});

test("tracker addons are listed when built, and dropped when a later runtime has none", () => {
  const withAddons = buildCatalog({ inputs: inputs(), ...runtime("core", "tracker", "addons"), items });
  assert.deepEqual(withAddons.trackerAddons, { version: "0.1.1", bundle: "/bundles/worlds/addons.zip", packages: [] });
  const without = catalogWithRuntime(withAddons, { inputs: inputs(), ...runtime("core", "tracker") });
  assert.equal(without.trackerAddons, null);
});

test("no mix when world bundles were built for other pinned versions", () => {
  const next = { inputs: inputs(), ...runtime("new-core", "new-tracker") };
  const olderArchipelago = buildCatalog({ inputs: inputs("0.6.6"), ...runtime("old-core", "old-tracker"), items });
  const olderPyodide = buildCatalog({ inputs: inputs("0.6.7", "0.29.3"), ...runtime("old-core", "old-tracker"), items });
  assert.equal(catalogWithRuntime(olderArchipelago, next), null);
  assert.equal(catalogWithRuntime(olderPyodide, next), null);
  assert.equal(catalogWithRuntime(null, next), null);
});
