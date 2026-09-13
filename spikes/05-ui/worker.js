// Spike 5 worker: Universal Tracker in Pyodide, talking to the page through ui_bridge.py.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.mjs";
import { PRELUDE, PYODIDE_PACKAGES, PYPI_PACKAGES } from "../lib/prelude.mjs";

// Stand-ins for files the app would host itself or offer from the curated index.
const HOSTED = {
  apSnapshot: "/data/ap-1e1efa3f.zip",
  tracker: "/data/tracker.apworld",
};
// Used when TUNIC is tracked without an uploaded pack, so the automated drivers need no uploads.
const DEFAULT_TUNIC_PACK = "/data/tunic-pack.zip";
const PACK_PATH = "/ap/packs/pack.zip";

const post = (message) => postMessage(JSON.stringify(message));
const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const fetchText = async (url) => (await fetch(url)).text();

let bridge;
let ready;

// config: { world, yamls: [{ name, bytes }], pack: { name, bytes } | null }
async function boot(config) {
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

  let hasPack = false;
  await time("files", async () => {
    py.unpackArchive(await fetchBytes(HOSTED.apSnapshot), "zip", { extractDir: "/ap" });
    py.FS.mkdirTree("/ap/custom_worlds");
    py.FS.writeFile("/ap/custom_worlds/tracker.apworld", await fetchBytes(HOSTED.tracker));

    py.FS.mkdirTree("/ap/Players");
    for (const yaml of config.yamls) {
      py.FS.writeFile(`/ap/Players/${yaml.name}`, yaml.bytes);
    }

    const pack = config.pack?.bytes ?? (config.world === "tunic" ? await fetchBytes(DEFAULT_TUNIC_PACK) : null);
    if (pack) {
      py.FS.mkdirTree("/ap/packs");
      py.FS.writeFile(PACK_PATH, pack);
      hasPack = true;
    }

    py.globals.set("keep_worlds", config.world);
    py.runPython(PRELUDE);
    py.FS.writeFile("/stubs/browser_websocket.py", await fetchText("../lib/browser_websocket.py"));
    py.FS.writeFile("/stubs/ui_bridge.py", await fetchText("../lib/ui_bridge.py"));
  });

  py.globals.set("pack_path", hasPack ? PACK_PATH : null);
  await time("start tracker", () => py.runPythonAsync(`
import sys
# UT and CommonClient decide GUI mode from argv when Utils is first imported.
sys.argv = ["UniversalTracker", "--nogui"]

import browser_websocket
browser_websocket.install()

import ui_bridge
if pack_path:
    ui_bridge.UPLOADS["poptracker_pack"] = pack_path
ui_bridge.start()
`));
  bridge = py.pyimport("ui_bridge");
  post({ type: "ready", timings, yamls: config.yamls.map((y) => y.name), pack: hasPack });
}

self.onmessage = async ({ data }) => {
  if (typeof data === "object" && data.type === "boot") {
    ready = boot(data).catch((err) => post({ type: "fatal", text: String(err?.stack ?? err) }));
    return;
  }
  await ready;
  try {
    bridge.handle(data);
  } catch (err) {
    post({ type: "log", level: "ERROR", text: String(err) });
  }
};
