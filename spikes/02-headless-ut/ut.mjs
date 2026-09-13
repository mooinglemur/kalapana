// Spike 2: run Universal Tracker headless under Pyodide against a live Archipelago server.
// Usage: node ut.mjs <ap-snapshot.zip> <tracker.apworld> <server address> <slot name> [worlds to keep] [player yamls]
import { bootRuntime, timer } from "../lib/runtime.mjs";

const [apZip, trackerApworld, address, slotName, keepWorlds = "", yamls = ""] = process.argv.slice(2);
if (!slotName) {
  console.error("usage: node ut.mjs <ap-snapshot.zip> <tracker.apworld> <address> <slot> [world,...] [yaml,...]");
  process.exit(2);
}

const { t, mark } = timer();
const playerFiles = yamls ? yamls.split(",") : [];
const py = await bootRuntime({ apZip, keepWorlds, customWorlds: [trackerApworld], playerFiles });

py.globals.set("server_address", address);
py.globals.set("slot_name", slotName);

const start = t();
await py.runPythonAsync(`
import asyncio
import logging
import sys
import time

# UT and CommonClient decide GUI mode from argv when Utils is first imported.
sys.argv = ["UniversalTracker", "--nogui"]
logging.basicConfig(level=logging.INFO, format="[py] %(name)s %(levelname)s: %(message)s")

import browser_websocket
browser_websocket.install()

t0 = time.perf_counter()
import worlds
from worlds.tracker.TrackerClient import TrackerGameContext
from worlds.tracker.TrackerCore import TrackerCore
from CommonClient import server_loop
print(f"[time] import worlds + UT: {time.perf_counter() - t0:.2f}s")
print("failed world loads:", sorted(worlds.failed_world_loads))


def timed(cls, name):
    original = getattr(cls, name)

    def wrapper(*args, **kwargs):
        started = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            print(f"[time] {cls.__name__}.{name}: {time.perf_counter() - started:.2f}s")

    setattr(cls, name, wrapper)


for method in ("run_generator", "initalize_tracker_core", "updateTracker"):
    timed(TrackerCore, method)


async def run():
    ctx = TrackerGameContext(server_address, None, print_count=True, print_list=True)
    ctx.auth = slot_name
    ctx.server_task = asyncio.create_task(server_loop(ctx), name="server loop")
    # UT's own main() also starts the stdin console, which needs a thread; skip it.
    ctx.run_generator()
    try:
        await asyncio.wait_for(ctx.exit_event.wait(), 180)
    finally:
        await ctx.shutdown()

await run()
`);
mark("UT session", start);
