// Spike 6: boot from trimmed bundles with a minimal Pyodide package set, then run UT headless.
// Usage: node boot_bundle.mjs <bundle dir> <src|pyc> <world> <tracker.apworld> <address> <slot> [player yaml]
import { loadPyodide } from "pyodide";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { timer } from "../lib/runtime.mjs";

const [bundleDir, variant, world, trackerApworld, address, slot, yaml] = process.argv.slice(2);
if (!slot) {
  console.error("usage: node boot_bundle.mjs <bundle dir> <src|pyc> <world> <tracker.apworld> <address> <slot> [yaml]");
  process.exit(2);
}

const { t, mark } = timer();
const asBytes = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const tBoot = t();
const py = await loadPyodide();
mark("loadPyodide", tBoot);

const tPkgs = t();
await py.loadPackage(["pyyaml", "orjson"]);
mark("packages (pyyaml, orjson)", tPkgs);

const tUnpack = t();
py.unpackArchive(asBytes(await readFile(`${bundleDir}/core-${variant}.zip`)), "zip", { extractDir: "/" });
py.unpackArchive(asBytes(await readFile(`${bundleDir}/world-${world}-${variant}.zip`)), "zip", { extractDir: "/" });
py.FS.mkdirTree("/ap/custom_worlds");
py.FS.writeFile("/ap/custom_worlds/tracker.apworld", asBytes(await readFile(trackerApworld)));
py.FS.mkdirTree("/ap/Players");
if (yaml) py.FS.writeFile(`/ap/Players/${basename(yaml)}`, asBytes(await readFile(yaml)));
py.FS.writeFile("/site-packages/browser_websocket.py", await readFile(new URL("../lib/browser_websocket.py", import.meta.url), "utf8"));
mark("unpack bundles", tUnpack);

py.globals.set("server_address", address);
py.globals.set("slot_name", slot);

const tSession = t();
await py.runPythonAsync(`
import asyncio
import concurrent.futures
import concurrent.futures.thread
import logging
import os
import sys
import time


class InlineExecutor(concurrent.futures.Executor):
    def __init__(self, *args, **kwargs):
        pass

    def submit(self, fn, /, *args, **kwargs):
        future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as e:
            future.set_exception(e)
        return future


concurrent.futures.ThreadPoolExecutor = InlineExecutor
concurrent.futures.thread.ThreadPoolExecutor = InlineExecutor
sys.path[:0] = ["/site-packages", "/ap"]
os.chdir("/ap")
sys.argv = ["UniversalTracker", "--nogui"]
logging.basicConfig(level=logging.WARNING)

import browser_websocket
browser_websocket.install()

t0 = time.perf_counter()
import worlds
from worlds.tracker.TrackerClient import TrackerGameContext
from CommonClient import server_loop
print(f"[time] import worlds + UT: {time.perf_counter() - t0:.2f}s")
print("failed world loads:", sorted(worlds.failed_world_loads))
print("loaded modules from:", sorted({m.split('.')[0] for m in sys.modules if m.split('.')[0] in ('ssl', 'bsdiff4', 'jellyfish', 'jinja2', 'requests')}))


async def run():
    ctx = TrackerGameContext(server_address, None, print_count=True, print_list=False)
    ctx.auth = slot_name
    ctx.server_task = asyncio.create_task(server_loop(ctx), name="server loop")
    ctx.run_generator()
    try:
        await asyncio.wait_for(ctx.exit_event.wait(), 120)
    finally:
        await ctx.shutdown()

await run()
`);
mark("UT session (imports + connect + tracking)", tSession);
const heapMB = py._module.HEAPU8.length / 2 ** 20;
console.log(`[mem] wasm heap: ${heapMB.toFixed(0)} MB`);
