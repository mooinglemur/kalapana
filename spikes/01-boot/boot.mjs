// Spike 1: boot Pyodide with an Archipelago source snapshot and time the core imports.
// Usage: node boot.mjs <ap-snapshot.zip> [comma-separated worlds to keep]
import { bootRuntime, timer } from "../lib/runtime.mjs";

const [apZip, keepWorlds] = process.argv.slice(2);
if (!apZip) {
  console.error("usage: node boot.mjs <ap-snapshot.zip> [world,world,...]");
  process.exit(2);
}

const { t, mark } = timer();
const py = await bootRuntime({ apZip, keepWorlds });

async function timedRun(label, code) {
  const start = t();
  try {
    await py.runPythonAsync(code);
    mark(label, start);
  } catch (err) {
    mark(`${label} (FAILED)`, start);
    console.log(String(err));
  }
}

await timedRun("import worlds", `
import worlds
from worlds.AutoWorld import AutoWorldRegister
print("registered worlds:", len(AutoWorldRegister.world_types))
print("failed world loads:", sorted(worlds.failed_world_loads))
`);
await timedRun("import CommonClient", "import CommonClient");
await timedRun("import Generate", "import Generate");

const heapMB = py._module.HEAPU8.length / 2 ** 20;
console.log(`[mem] wasm heap: ${heapMB.toFixed(0)} MB, node rss: ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`);
