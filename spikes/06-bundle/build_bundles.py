"""Build trimmed Archipelago bundles for the browser runtime and report their sizes.

Produces, for each variant (source .py and sourceless .pyc):
  core-<variant>.zip          AP core modules, vendored pure-Python wheels, and stubs
  world-<name>-<variant>.zip  one world folder each

Run with a CPython matching Pyodide's minor version (3.13), since .pyc files are version-specific.
Usage: python build_bundles.py <ap snapshot.zip> <wheel dir> <out dir> <world> [<world> ...]
"""
import argparse
import gzip
import io
import py_compile
import sys
import tempfile
import zipfile
from pathlib import Path

# Top-level AP modules that nothing on the tracker's import path loads. Launcher, SNIClient, Patch and
# LttPAdjuster look desktop-only but are imported by worlds/ and Utils, so they stay.
# ModuleUpdate is replaced by a stub.
CORE_EXCLUDED_MODULES = {"kvui.py", "setup.py", "WebHost.py", "conftest.py", "ModuleUpdate.py"}

# Top-level AP packages the tracker never imports.
CORE_EXCLUDED_PACKAGES = {"WebHostLib", "test", "worlds"}

STUBS = {
    # UT never patches ROMs; worlds/Files.py only needs the import to succeed.
    "bsdiff4.py": '''
def patch(*args, **kwargs):
    raise NotImplementedError("bsdiff4 is not available in the browser")

def diff(*args, **kwargs):
    raise NotImplementedError("bsdiff4 is not available in the browser")
''',
    # Utils.get_fuzzy_results only needs this one function from the Rust package.
    "jellyfish.py": '''
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
''',
    # CommonClient imports ssl at load time but only uses it for wss://, which the browser handles.
    "ssl.py": '''
class Purpose:
    SERVER_AUTH = "SERVER_AUTH"

class SSLContext:
    pass

def create_default_context(*args, **kwargs):
    raise NotImplementedError("TLS is handled by the browser")
''',
    # ModuleUpdate enforces a Python version range and may try pip; neither applies in the bundle.
    "ModuleUpdate.py": '''
def update(*args, **kwargs):
    pass
''',
}


def compile_source(path: str, source: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "module.py"
        src.write_bytes(source)
        out = Path(tmp) / "module.pyc"
        # Keep docstrings: UT and CommonClient build /help text from them.
        py_compile.compile(str(src), cfile=str(out), dfile=path, doraise=True, optimize=0)
        return out.read_bytes()


def add(archive: zipfile.ZipFile, path: str, data: bytes, variant: str) -> None:
    if variant == "pyc" and path.endswith(".py"):
        archive.writestr(path + "c", compile_source(path, data))
    else:
        archive.writestr(path, data)


def build_core(snapshot: zipfile.ZipFile, wheel_dir: Path, variant: str) -> bytes:
    buffer = io.BytesIO()
    names = set(snapshot.namelist())
    packages = {n.split("/")[0] for n in names if n.count("/") == 1 and n.endswith("/__init__.py")}
    packages -= CORE_EXCLUDED_PACKAGES
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for info in snapshot.infolist():
            name = info.filename
            is_core_module = "/" not in name and name.endswith(".py") and name not in CORE_EXCLUDED_MODULES
            is_core_module |= name.split("/")[0] in packages and name.endswith(".py")
            is_worlds_base = name.startswith("worlds/") and (name.count("/") == 1 or name.startswith("worlds/generic/"))
            if (is_core_module or is_worlds_base) and not info.is_dir():
                add(archive, f"ap/{name}", snapshot.read(info), variant)
        for wheel in sorted(wheel_dir.glob("*.whl")):
            with zipfile.ZipFile(wheel) as whl:
                for info in whl.infolist():
                    if not info.is_dir() and ".dist-info/" not in info.filename:
                        add(archive, f"site-packages/{info.filename}", whl.read(info), variant)
        for name, source in STUBS.items():
            add(archive, f"site-packages/{name}", source.encode(), variant)
    return buffer.getvalue()


def build_world(snapshot: zipfile.ZipFile, world: str, variant: str) -> bytes:
    buffer = io.BytesIO()
    prefix = f"worlds/{world}/"
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for info in snapshot.infolist():
            if info.filename.startswith(prefix) and not info.is_dir() and "/test/" not in info.filename:
                add(archive, f"ap/{info.filename}", snapshot.read(info), variant)
    return buffer.getvalue()


def stored_then_gzipped(bundle: bytes) -> int:
    """Size if files were stored uncompressed in the archive and the whole archive gzipped for transfer."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(bundle)) as source, zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as stored:
        for info in source.infolist():
            stored.writestr(info.filename, source.read(info))
    return len(gzip.compress(buffer.getvalue(), 9))


def main() -> None:
    if sys.version_info[:2] != (3, 13):
        sys.exit(f"needs Python 3.13 to match Pyodide's .pyc format, not {sys.version.split()[0]}")
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("wheels", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("worlds", nargs="+")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(args.snapshot) as snapshot:
        outputs = []
        for variant in ("src", "pyc"):
            outputs.append((f"core-{variant}.zip", build_core(snapshot, args.wheels, variant)))
            for world in args.worlds:
                outputs.append((f"world-{world}-{variant}.zip", build_world(snapshot, world, variant)))

    for name, data in outputs:
        (args.out / name).write_bytes(data)
        print(f"{name:34} zip-deflate {len(data) / 1e6:6.2f} MB   stored+gzip {stored_then_gzipped(data) / 1e6:6.2f} MB")


if __name__ == "__main__":
    main()
