// Shared spike bootstrap: Pyodide + an Archipelago source snapshot + browser compatibility shims.
import { loadPyodide } from "pyodide";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const PYODIDE_PACKAGES = ["micropip", "pyyaml", "jinja2", "markupsafe", "orjson", "ssl", "requests", "setuptools"];

// Pure-Python pins from Archipelago's requirements.txt.
const PYPI_PACKAGES = [
  "colorama==0.4.6",
  "websockets==13.1",
  "schema==0.7.8",
  "platformdirs==4.10.1",
  // Unpinned: Pyodide's requests package already brings its own certifi, and the browser does TLS anyway.
  "certifi",
  "typing_extensions==4.15.0",
  "pathspec==1.0.4",
];

const PRELUDE = String.raw`
import concurrent.futures
import concurrent.futures.thread
import os
import shutil
import sys

os.makedirs("/stubs", exist_ok=True)

# UT never patches ROMs; worlds/Files.py only needs the import to succeed.
with open("/stubs/bsdiff4.py", "w") as f:
    f.write('''
def patch(*args, **kwargs):
    raise NotImplementedError("bsdiff4 is not available in the browser")

def diff(*args, **kwargs):
    raise NotImplementedError("bsdiff4 is not available in the browser")
''')

# Utils.get_fuzzy_results only needs this one function from the Rust package.
with open("/stubs/jellyfish.py", "w") as f:
    f.write('''
def damerau_levenshtein_distance(s1, s2):
    d = {}
    for i in range(-1, len(s1) + 1):
        d[(i, -1)] = i + 1
    for j in range(-1, len(s2) + 1):
        d[(-1, j)] = j + 1
    for i in range(len(s1)):
        for j in range(len(s2)):
            cost = 0 if s1[i] == s2[j] else 1
            d[(i, j)] = min(d[(i - 1, j)] + 1, d[(i, j - 1)] + 1, d[(i - 1, j - 1)] + cost)
            if i and j and s1[i] == s2[j - 1] and s1[i - 1] == s2[j]:
                d[(i, j)] = min(d[(i, j)], d[(i - 2, j - 2)] + 1)
    return d[(len(s1) - 1, len(s2) - 1)]
''')


class InlineExecutor(concurrent.futures.Executor):
    """Runs submitted work immediately, since Pyodide cannot start threads."""

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

sys.path[:0] = ["/stubs", "/ap"]
os.chdir("/ap")
# A missing Players folder makes settings fall back to a native folder dialog.
os.makedirs("/ap/Players", exist_ok=True)

if keep_worlds:
    keep = set(keep_worlds.split(",")) | {"generic"}
    for entry in os.scandir("/ap/worlds"):
        if entry.is_dir() and not entry.name.startswith(("_", ".")) and entry.name not in keep:
            shutil.rmtree(entry.path)
`;

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
