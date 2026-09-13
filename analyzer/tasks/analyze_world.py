"""Imports one world in isolation and records what the browser needs to know about it.

Input: kind ("apworld" or "core") and module (the index's world name). Core worlds are read from the
AP source at /apsrc; apworlds from /job/input.apworld. /core holds the core bundles.
Writes /job/bundle.zip (precompiled world files under ap/worlds/<module>/) and /job/result.json.
"""
import os
import shutil
import sys
import zipfile

sys.path.insert(0, "/tasks")
from bundling import PACKAGE_MODULES, BundleWriter, failure, walk_files, write_result

# Worlds' own test suites are never imported by the tracker.
SKIPPED_TOP_LEVEL = {"test", "tests"}


def analyze(kind: str, module: str) -> dict:
    with zipfile.ZipFile("/core/core-src.zip") as core:
        core.extractall("/")
    sys.path.insert(0, "/site-packages")
    import kalapana_boot

    kalapana_boot.prepare()
    import world_info

    if kind == "core":
        folder, manifest = module, {}
        # The generic world is already part of the core bundle.
        if not os.path.exists(f"/ap/worlds/{module}"):
            shutil.copytree(f"/apsrc/worlds/{module}", f"/ap/worlds/{module}", ignore=shutil.ignore_patterns("__pycache__"))
    else:
        folder, manifest = world_info.extract_apworld("/job/input.apworld")
    before = set(sys.modules)

    classes = world_info.world_classes(folder)
    packages = sorted({package for mod, package in PACKAGE_MODULES.items() if mod in sys.modules and mod not in before})

    writer = BundleWriter("/job/bundle.zip", compiled=True)
    world_root = f"/ap/worlds/{folder}"
    for file in walk_files(world_root):
        relative = os.path.relpath(file, world_root)
        if relative.split(os.sep, 1)[0] in SKIPPED_TOP_LEVEL:
            continue
        with open(file, "rb") as f:
            writer.add(f"ap/worlds/{folder}/{relative}", f.read())
    writer.close()

    return {
        "ok": True,
        "module": folder,
        "manifest": manifest,
        "worlds": [world_info.describe(cls) for cls in classes],
        "packages": packages,
        "bytes": os.path.getsize("/job/bundle.zip"),
    }


try:
    write_result(analyze(task_input["kind"], task_input["module"]))
except BaseException:
    write_result(failure())
