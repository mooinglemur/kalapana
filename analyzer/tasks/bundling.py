"""Helpers shared by analyzer tasks: writing reproducible bundles the browser unpacks at /."""
import importlib._bootstrap_external as bootstrap_external
import importlib.util
import json
import os
import traceback
import zipfile

# Modules whose presence in sys.modules means a world needs the matching Pyodide package.
PACKAGE_MODULES = {
    "yaml": "pyyaml",
    "orjson": "orjson",
    "requests": "requests",
    # urllib3 (under requests) needs the real ssl module rather than kalapana's stub.
    "urllib3": "ssl",
    "pkg_resources": "setuptools",
    "setuptools": "setuptools",
    "jinja2": "jinja2",
    "attr": "attrs",
    "attrs": "attrs",
    "docutils": "docutils",
}

SKIPPED_DIRS = {"__pycache__"}


def write_result(result: dict) -> None:
    with open("/job/result.json", "w") as f:
        json.dump(result, f)


def failure(error: BaseException | None = None) -> dict:
    return {"ok": False, "error": traceback.format_exc()[-6000:] if error is None else str(error)}


def compile_to_pyc(source: bytes, runtime_path: str) -> bytes:
    code = compile(source, runtime_path, "exec", dont_inherit=True)
    # An unchecked hash-based .pyc has reproducible bytes and needs no source file at runtime.
    return bytes(bootstrap_external._code_to_hash_pyc(code, importlib.util.source_hash(source), checked=False))


def walk_files(root: str):
    """Yields files under root in a stable order, skipping bytecode caches."""
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS)
        for name in sorted(files):
            yield os.path.join(directory, name)


class BundleWriter:
    def __init__(self, path: str, compiled: bool):
        self.archive = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9)
        self.compiled = compiled

    def add(self, archive_path: str, data: bytes) -> None:
        if self.compiled and archive_path.endswith(".py"):
            try:
                self._write(archive_path + "c", compile_to_pyc(data, "/" + archive_path))
                return
            except SyntaxError:
                # Ship files that don't compile as source; importing them reports the error as usual.
                pass
        self._write(archive_path, data)

    def _write(self, name: str, data: bytes) -> None:
        # Fixed timestamps keep bundle bytes reproducible.
        info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        self.archive.writestr(info, data)

    def close(self) -> None:
        self.archive.close()
