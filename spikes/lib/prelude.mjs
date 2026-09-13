// Runtime pieces shared by the Node and browser spikes. No Node-only imports here.

export const PYODIDE_VERSION = "0.29.4";

export const PYODIDE_PACKAGES = ["micropip", "pyyaml", "jinja2", "markupsafe", "orjson", "ssl", "requests", "setuptools"];

// Pure-Python pins from Archipelago's requirements.txt.
export const PYPI_PACKAGES = [
  "colorama==0.4.6",
  "websockets==13.1",
  "schema==0.7.8",
  "platformdirs==4.10.1",
  // Unpinned: Pyodide's requests package already brings its own certifi, and the browser does TLS anyway.
  "certifi",
  "typing_extensions==4.15.0",
  "pathspec==1.0.4",
];

// Expects the AP snapshot at /ap and a `keep_worlds` global (comma-separated, empty keeps all).
export const PRELUDE = String.raw`
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
