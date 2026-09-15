"""Imports Universal Tracker Addons with the tracker in place and bundles it.

An addon registers commands with the tracker rather than World classes, and imports worlds.tracker as it
loads, so it can't be analyzed like a world.
Input: module (the addon's folder name). Reads /job/input.apworld, the core bundles at /core and the
tracker's analysis at /tracker. Writes /job/bundle.zip (precompiled files under ap/worlds/<module>/) and
/job/result.json.
"""
import importlib
import os
import sys
import zipfile

sys.path.insert(0, "/tasks")
from bundling import PACKAGE_MODULES, BundleWriter, failure, walk_files, write_result


def analyze(module: str) -> dict:
    with zipfile.ZipFile("/core/core-src.zip") as core:
        core.extractall("/")
    with zipfile.ZipFile("/tracker/bundle.zip") as tracker:
        tracker.extractall("/")
    sys.path.insert(0, "/site-packages")
    import kalapana_boot

    kalapana_boot.prepare()
    import world_info

    folder, manifest = world_info.extract_apworld("/job/input.apworld")
    if folder != module:
        raise ValueError(f"expected the apworld to hold worlds/{module}, found worlds/{folder}")
    before = set(sys.modules)

    import worlds  # noqa: F401  (loads every world folder, the tracker first)

    # Importing directly surfaces an error that worlds' own loader would only log.
    importlib.import_module(f"worlds.{folder}")
    packages = sorted({package for mod, package in PACKAGE_MODULES.items() if mod in sys.modules and mod not in before})

    writer = BundleWriter("/job/bundle.zip", compiled=True)
    addon_root = f"/ap/worlds/{folder}"
    for file in walk_files(addon_root):
        with open(file, "rb") as f:
            writer.add(f"ap/worlds/{folder}/{os.path.relpath(file, addon_root)}", f.read())
    writer.close()

    return {
        "ok": True,
        "module": folder,
        "manifest": manifest,
        "worlds": [],
        "packages": packages,
        "bytes": os.path.getsize("/job/bundle.zip"),
    }


try:
    write_result(analyze(task_input["module"]))
except BaseException:
    write_result(failure())
