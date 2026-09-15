// Runs Universal Tracker in Pyodide and relays messages between it and the page.
//
// Page messages, in order:
// - boot: load the runtime with a catalog world bundle, or inspect: load it with the player's apworld
//   and report what it holds;
// - start: place the player's files and connect;
// - strings: bridge commands.
const post = (message) => postMessage(JSON.stringify(message));

let py = null;
let bridge = null;
let failed = false;
const timings = {};
// One message at a time, so start waits for boot or inspect, and bridge commands wait for start.
let queue = Promise.resolve();

async function time(label, fn) {
  const started = performance.now();
  const value = await fn();
  timings[label] = +((performance.now() - started) / 1000).toFixed(2);
  return value;
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadRuntime(runtime, packages, bundles) {
  const { loadPyodide } = await import(`${runtime.pyodide.base}pyodide.mjs`);
  py = await time("python", () => loadPyodide({ indexURL: runtime.pyodide.base }));
  await time("packages", () => py.loadPackage([...new Set(packages)], { messageCallback: () => {} }));
  await time("bundles", async () => {
    const archives = await Promise.all(bundles.map(fetchBytes));
    for (const bytes of archives) py.unpackArchive(bytes, "zip", { extractDir: "/" });
  });
  await py.runPythonAsync(`
import sys
sys.path.insert(0, "/site-packages")
import kalapana_boot
kalapana_boot.prepare()
`);
}

// The core, the tracker and, when the catalog has them, the tracker addons, in unpacking order.
const runtimeParts = (runtime) => [runtime.core, runtime.tracker, runtime.trackerAddons].filter(Boolean);

async function boot({ runtime, entry }) {
  const parts = runtimeParts(runtime);
  await loadRuntime(
    runtime,
    [...parts.flatMap((part) => part.packages), ...entry.packages],
    [...parts.map((part) => part.bundle), entry.bundle],
  );
}

async function inspect({ runtime, apworld }) {
  const parts = runtimeParts(runtime);
  await loadRuntime(
    runtime,
    [...parts.flatMap((part) => part.packages), ...(runtime.pyodide.packages ?? [])],
    parts.map((part) => part.bundle),
  );
  const result = await time("apworld", async () => {
    py.FS.writeFile("/tmp/upload.apworld", apworld.bytes);
    return py.runPython(`import world_info; world_info.inspect_upload("/tmp/upload.apworld")`);
  });
  post({ type: "inspected", ...JSON.parse(result) });
}

async function start({ yamls, pack, connect, datapackages }) {
  py.pyimport("datapackage_cache").install(py.toPy(datapackages ?? []));
  await time("tracker", async () => {
    py.FS.mkdirTree("/ap/Players");
    for (const yaml of yamls) py.FS.writeFile(`/ap/Players/${yaml.name}`, yaml.bytes);
    if (pack) {
      py.FS.mkdirTree("/ap/packs");
      py.FS.writeFile("/ap/packs/pack.zip", pack.bytes);
    }
    py.globals.set("pack_path", pack ? "/ap/packs/pack.zip" : null);
    await py.runPythonAsync(`
import browser_websocket
browser_websocket.install()

import ui_bridge
ui_bridge.start(pack_path)
`);
  });
  bridge = py.pyimport("ui_bridge");
  post({ type: "ready", timings });
  bridge.handle(JSON.stringify({ type: "connect", ...connect }));
}

const STEPS = { boot, inspect, start };

self.onmessage = ({ data }) => {
  queue = queue
    .then(async () => {
      if (failed) return;
      if (typeof data === "string") bridge?.handle(data);
      else await STEPS[data.type](data);
    })
    .catch((err) => {
      if (typeof data === "string") {
        post({ type: "log", level: "ERROR", text: String(err) });
      } else {
        failed = true;
        post({ type: "fatal", text: String(err?.stack ?? err) });
      }
    });
};
