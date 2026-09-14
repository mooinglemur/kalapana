import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, catalogWithRuntime } from "../server/catalog.mjs";

function inputs(archipelago = "0.6.7", pyodide = "0.29.4") {
  return {
    archipelago: { version: archipelago },
    pyodide: { version: pyodide, packages: ["pyyaml"] },
    tracker: { version: "0.3.3" },
  };
}

function runtime(coreKey, trackerKey) {
  return {
    core: { key: coreKey, result: { packages: ["pyyaml"] } },
    tracker: { analysisKey: trackerKey, analysis: { packages: [] } },
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
  const previous = buildCatalog({ inputs: inputs(), ...runtime("old-core", "old-tracker"), items });
  const updated = catalogWithRuntime(previous, { inputs: inputs(), ...runtime("new-core", "new-tracker") });
  assert.equal(updated.core.bundle, "/bundles/core/new-core.zip");
  assert.equal(updated.tracker.bundle, "/bundles/worlds/new-tracker.zip");
  assert.deepEqual(updated.games, previous.games);
  assert.equal(updated.generatedAt, previous.generatedAt);
});

test("no mix when world bundles were built for other pinned versions", () => {
  const next = { inputs: inputs(), ...runtime("new-core", "new-tracker") };
  const olderArchipelago = buildCatalog({ inputs: inputs("0.6.6"), ...runtime("old-core", "old-tracker"), items });
  const olderPyodide = buildCatalog({ inputs: inputs("0.6.7", "0.29.3"), ...runtime("old-core", "old-tracker"), items });
  assert.equal(catalogWithRuntime(olderArchipelago, next), null);
  assert.equal(catalogWithRuntime(olderPyodide, next), null);
  assert.equal(catalogWithRuntime(null, next), null);
});
