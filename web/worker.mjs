// Runs Universal Tracker in Pyodide and relays messages between it and the page.
const post = (message) => postMessage(JSON.stringify(message));

let bridge = null;
let ready = null;

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function boot({ runtime, entry, yamls, pack, connect }) {
  const timings = {};
  const time = async (label, fn) => {
    const started = performance.now();
    const value = await fn();
    timings[label] = +((performance.now() - started) / 1000).toFixed(2);
    return value;
  };

  const { loadPyodide } = await import(`${runtime.pyodide.base}pyodide.mjs`);
  const py = await time("python", () => loadPyodide({ indexURL: runtime.pyodide.base }));
  const packages = [...new Set([...runtime.core.packages, ...runtime.tracker.packages, ...entry.packages])];
  await time("packages", () => py.loadPackage(packages, { messageCallback: () => {} }));
  await time("bundles", async () => {
    const bundles = await Promise.all([runtime.core.bundle, runtime.tracker.bundle, entry.bundle].map(fetchBytes));
    for (const bytes of bundles) py.unpackArchive(bytes, "zip", { extractDir: "/" });
    py.FS.mkdirTree("/ap/Players");
    for (const yaml of yamls) py.FS.writeFile(`/ap/Players/${yaml.name}`, yaml.bytes);
    if (pack) {
      py.FS.mkdirTree("/ap/packs");
      py.FS.writeFile("/ap/packs/pack.zip", pack.bytes);
    }
  });

  py.globals.set("pack_path", pack ? "/ap/packs/pack.zip" : null);
  await time("tracker", () => py.runPythonAsync(`
import sys
sys.path.insert(0, "/site-packages")
import kalapana_boot
kalapana_boot.prepare()

import browser_websocket
browser_websocket.install()

import ui_bridge
ui_bridge.start(pack_path)
`));
  bridge = py.pyimport("ui_bridge");
  post({ type: "ready", timings });
  bridge.handle(JSON.stringify({ type: "connect", ...connect }));
}

self.onmessage = async ({ data }) => {
  if (typeof data === "object" && data.type === "boot") {
    ready = boot(data).catch((err) => post({ type: "fatal", text: String(err?.stack ?? err) }));
    return;
  }
  await ready;
  if (!bridge) return;
  try {
    bridge.handle(data);
  } catch (err) {
    post({ type: "log", level: "ERROR", text: String(err) });
  }
};
