// Spike 5 worker: Universal Tracker in Pyodide, talking to the page through ui_bridge.py.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.mjs";
import { PRELUDE, PYODIDE_PACKAGES, PYPI_PACKAGES } from "../lib/prelude.mjs";

// Stand-ins for files a user would upload or pick from the curated index.
const DATA = {
  apSnapshot: "/data/ap-1e1efa3f.zip",
  tracker: "/data/tracker.apworld",
  tunicPack: "/data/tunic-pack.zip",
};

const post = (message) => postMessage(JSON.stringify(message));
const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const fetchText = async (url) => (await fetch(url)).text();

let bridge;

async function boot() {
  const timings = {};
  const time = async (label, fn) => {
    const start = performance.now();
    const value = await fn();
    timings[label] = +((performance.now() - start) / 1000).toFixed(2);
    return value;
  };

  const py = await time("loadPyodide", () => loadPyodide({ env: { SKIP_REQUIREMENTS_UPDATE: "1" } }));
  await time("packages", async () => {
    await py.loadPackage(PYODIDE_PACKAGES);
    await py.pyimport("micropip").install(PYPI_PACKAGES);
  });
  await time("files", async () => {
    py.unpackArchive(await fetchBytes(DATA.apSnapshot), "zip", { extractDir: "/ap" });
    py.FS.mkdirTree("/ap/custom_worlds");
    py.FS.writeFile("/ap/custom_worlds/tracker.apworld", await fetchBytes(DATA.tracker));
    py.FS.mkdirTree("/ap/packs");
    py.FS.writeFile("/ap/packs/tunic-pack.zip", await fetchBytes(DATA.tunicPack));
    py.globals.set("keep_worlds", "tunic");
    py.runPython(PRELUDE);
    py.FS.writeFile("/stubs/browser_websocket.py", await fetchText("../lib/browser_websocket.py"));
    py.FS.writeFile("/stubs/ui_bridge.py", await fetchText("../lib/ui_bridge.py"));
  });
  await time("start tracker", () => py.runPythonAsync(`
import sys
# UT and CommonClient decide GUI mode from argv when Utils is first imported.
sys.argv = ["UniversalTracker", "--nogui"]

import browser_websocket
browser_websocket.install()

import ui_bridge
ui_bridge.UPLOADS["poptracker_pack"] = "/ap/packs/tunic-pack.zip"
ui_bridge.start()
`));
  bridge = py.pyimport("ui_bridge");
  post({ type: "ready", timings });
}

const ready = boot().catch((err) => post({ type: "fatal", text: String(err?.stack ?? err) }));

self.onmessage = async ({ data }) => {
  await ready;
  try {
    bridge.handle(data);
  } catch (err) {
    post({ type: "log", level: "ERROR", text: String(err) });
  }
};
