"""Builds the Archipelago core bundles from the pinned AP source mounted at /apsrc.

core-src.zip keeps .py sources for the analyzer; core.zip holds precompiled .pyc for browsers.
Both contain AP's core modules under ap/, and vendored wheels plus kalapana's runtime modules under
site-packages/.
"""
import os
import shutil
import sys
import zipfile

sys.path.insert(0, "/tasks")
from bundling import PACKAGE_MODULES, BundleWriter, failure, walk_files, write_result

# Top-level modules nothing on the tracker's import path loads. ModuleUpdate is replaced by a stub.
EXCLUDED_MODULES = {"kvui.py", "setup.py", "WebHost.py", "conftest.py", "ModuleUpdate.py"}
EXCLUDED_PACKAGES = {"WebHostLib", "test", "worlds"}
# Client frameworks under worlds/ that several worlds import (BizHawk games need worlds._bizhawk).
# SC2's needs packages Pyodide doesn't have.
EXCLUDED_WORLD_SUPPORT = {"_sc2common"}


def core_files():
    for name in sorted(os.listdir("/apsrc")):
        path = os.path.join("/apsrc", name)
        if os.path.isfile(path) and name.endswith(".py") and name not in EXCLUDED_MODULES:
            yield f"ap/{name}", path
        elif os.path.isdir(path) and name not in EXCLUDED_PACKAGES and os.path.exists(os.path.join(path, "__init__.py")):
            for file in walk_files(path):
                if file.endswith(".py"):
                    yield "ap/" + os.path.relpath(file, "/apsrc"), file
    # worlds/ itself, without any worlds except the generic one every multiworld includes.
    for name in sorted(os.listdir("/apsrc/worlds")):
        path = os.path.join("/apsrc/worlds", name)
        if os.path.isfile(path) and name.endswith(".py"):
            yield f"ap/worlds/{name}", path
    for file in walk_files("/apsrc/worlds/generic"):
        yield "ap/" + os.path.relpath(file, "/apsrc"), file
    for name in sorted(os.listdir("/apsrc/worlds")):
        path = os.path.join("/apsrc/worlds", name)
        if name.startswith("_") and name not in EXCLUDED_WORLD_SUPPORT and os.path.exists(os.path.join(path, "__init__.py")):
            for file in walk_files(path):
                yield "ap/" + os.path.relpath(file, "/apsrc"), file


def site_package_files():
    for wheel in sorted(os.listdir("/wheels")):
        with zipfile.ZipFile(os.path.join("/wheels", wheel)) as archive:
            for info in archive.infolist():
                if not info.is_dir() and ".dist-info/" not in info.filename:
                    yield f"site-packages/{info.filename}", archive.read(info)
    for name in sorted(os.listdir("/runtime")):
        if name.endswith(".py"):
            with open(os.path.join("/runtime", name), "rb") as f:
                yield f"site-packages/{name}", f.read()


def build(path, compiled):
    writer = BundleWriter(path, compiled)
    count = 0
    for archive_path, file in core_files():
        with open(file, "rb") as f:
            writer.add(archive_path, f.read())
        count += 1
    for archive_path, data in site_package_files():
        writer.add(archive_path, data)
        count += 1
    writer.close()
    return count


def smoke_test():
    """Imports the core the way the browser will, and reports which Pyodide packages it needs."""
    for leftover in ("/ap", "/site-packages"):
        shutil.rmtree(leftover, ignore_errors=True)
    with zipfile.ZipFile("/job/core-src.zip") as bundle:
        bundle.extractall("/")
    sys.path.insert(0, "/site-packages")
    import kalapana_boot

    kalapana_boot.prepare()
    import CommonClient  # noqa: F401
    import Generate  # noqa: F401
    import worlds  # noqa: F401

    return sorted({package for module, package in PACKAGE_MODULES.items() if module in sys.modules})


try:
    files = build("/job/core-src.zip", compiled=False)
    build("/job/core.zip", compiled=True)
    write_result({
        "ok": True,
        "files": files,
        "packages": smoke_test(),
        "bytes": os.path.getsize("/job/core.zip"),
    })
except Exception:
    write_result(failure())
