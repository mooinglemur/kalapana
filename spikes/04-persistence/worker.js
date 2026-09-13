// Spike 4 worker: store user files in IDBFS and OPFS, then verify them after a browser restart.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.mjs";

const FILES = {
  "custom_worlds/tracker.apworld": "/data/tracker.apworld",
  "Players/tunic.yaml": "/data/ap-native/Players/tunic.yaml",
  "packs/tunic-pack.zip": "/data/tunic-pack.zip",
};
const IDBFS_ROOT = "/persist/idbfs";
const OPFS_ROOT = "/persist/opfs";

const log = (message) => postMessage({ type: "log", message });

const VERIFY = String.raw`
import hashlib, json, os, zipfile, zipimport

report = {}
for root in roots:
    entry = {}
    for rel, expected in expected_hashes.items():
        path = f"{root}/{rel}"
        if not os.path.exists(path):
            entry[rel] = "missing"
            continue
        with open(path, "rb") as f:
            entry[rel] = "ok" if hashlib.sha256(f.read()).hexdigest() == expected else "hash mismatch"
    apworld = f"{root}/custom_worlds/tracker.apworld"
    if os.path.exists(apworld):
        importer = zipimport.zipimporter(apworld)
        entry["zipimport finds tracker package"] = importer.find_spec("tracker") is not None
        entry["zipimport get_data Tracker.kv bytes"] = len(importer.get_data("tracker/Tracker.kv"))
    pack = f"{root}/packs/tunic-pack.zip"
    if os.path.exists(pack):
        # Only the files tunic's tracker_world points UT at; other pack JSON may contain comments.
        with zipfile.ZipFile(pack) as z:
            for name in ("maps/maps_pop.json", "locations/locations_pop_er.json", "locations/locations_breakables.json"):
                entry[f"pack {name} entries"] = len(json.loads(z.read(name).decode("utf-8-sig")))
    report[root] = entry
json.dumps(report)
`;

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function syncIdbfs(py, populate) {
  return new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
}

async function run(phase) {
  const started = performance.now();
  const py = await loadPyodide();
  log(`pyodide loaded in ${((performance.now() - started) / 1000).toFixed(2)}s`);

  py.FS.mkdirTree(IDBFS_ROOT);
  py.FS.mount(py.FS.filesystems.IDBFS, {}, IDBFS_ROOT);
  await syncIdbfs(py, true);

  const opfsRoot = await navigator.storage.getDirectory();
  const opfsHandle = await opfsRoot.getDirectoryHandle("kalapana", { create: true });
  const opfs = await py.mountNativeFS(OPFS_ROOT, opfsHandle);

  const fetched = {};
  const expectedHashes = {};
  for (const [rel, url] of Object.entries(FILES)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
    fetched[rel] = new Uint8Array(await response.arrayBuffer());
    expectedHashes[rel] = await sha256Hex(fetched[rel]);
  }

  const result = { phase };
  if (phase === "write") {
    for (const root of [IDBFS_ROOT, OPFS_ROOT]) {
      for (const [rel, bytes] of Object.entries(fetched)) {
        py.FS.mkdirTree(`${root}/${rel.split("/").slice(0, -1).join("/")}`);
        py.FS.writeFile(`${root}/${rel}`, bytes);
      }
    }
    await syncIdbfs(py, false);
    await opfs.syncfs();
    result.persistGranted = navigator.storage.persist ? await navigator.storage.persist() : "unsupported";
    log("files written and synced");
  }

  py.globals.set("roots", py.toPy([IDBFS_ROOT, OPFS_ROOT]));
  py.globals.set("expected_hashes", py.toPy(expectedHashes));
  result.report = JSON.parse(py.runPython(VERIFY));
  result.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : "unsupported";
  const estimate = await navigator.storage.estimate();
  result.storageMB = { usage: +(estimate.usage / 2 ** 20).toFixed(1), quota: +(estimate.quota / 2 ** 20).toFixed(0) };
  return result;
}

self.onmessage = async ({ data }) => {
  try {
    postMessage({ type: "done", result: await run(data.phase) });
  } catch (err) {
    postMessage({ type: "error", message: String(err?.stack ?? err) });
  }
};
