// Node spike bootstrap: Pyodide + an Archipelago source snapshot + browser compatibility shims.
import { loadPyodide } from "pyodide";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PRELUDE, PYODIDE_PACKAGES, PYPI_PACKAGES } from "./prelude.mjs";

export function timer(log = console.log) {
  const t = () => performance.now();
  return {
    t,
    mark: (label, start) => log(`[time] ${label}: ${((t() - start) / 1000).toFixed(2)}s`),
  };
}

// keepWorlds: comma-separated world folders to keep (generic is always kept); empty keeps all.
// customWorlds: host paths of .apworld files to place in custom_worlds.
// playerFiles: host paths of player YAMLs to place in Players.
export async function bootRuntime({ apZip, keepWorlds = "", customWorlds = [], playerFiles = [] }) {
  const { t, mark } = timer();

  const tBoot = t();
  const py = await loadPyodide({ env: { SKIP_REQUIREMENTS_UPDATE: "1" } });
  mark("loadPyodide", tBoot);

  const tPkgs = t();
  await py.loadPackage(PYODIDE_PACKAGES);
  await py.pyimport("micropip").install(PYPI_PACKAGES);
  mark("packages", tPkgs);

  const tUnpack = t();
  // Pyodide rejects Node's Buffer subclass, so hand it plain Uint8Array views.
  const asBytes = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  py.unpackArchive(asBytes(await readFile(apZip)), "zip", { extractDir: "/ap" });
  py.FS.mkdirTree("/ap/custom_worlds");
  for (const path of customWorlds) {
    py.FS.writeFile(`/ap/custom_worlds/${basename(path)}`, asBytes(await readFile(path)));
  }
  py.FS.mkdirTree("/ap/Players");
  for (const path of playerFiles) {
    py.FS.writeFile(`/ap/Players/${basename(path)}`, asBytes(await readFile(path)));
  }
  mark("unpack AP snapshot", tUnpack);

  py.globals.set("keep_worlds", keepWorlds);
  py.runPython(PRELUDE);
  py.FS.writeFile("/stubs/browser_websocket.py", await readFile(new URL("./browser_websocket.py", import.meta.url), "utf8"));
  return py;
}
