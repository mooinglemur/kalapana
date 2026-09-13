"""Imports one world in isolation and records what the browser needs to know about it.

Input: kind ("apworld" or "core") and module (the index's world name). Core worlds are read from the
AP source at /apsrc; apworlds from /job/input.apworld. /core holds the core bundles.
Writes /job/bundle.zip (precompiled world files under ap/worlds/<module>/) and /job/result.json.
"""
import importlib
import json
import os
import shutil
import sys
import zipfile

sys.path.insert(0, "/tasks")
from bundling import PACKAGE_MODULES, BundleWriter, failure, walk_files, write_result

# Worlds' own test suites are never imported by the tracker.
SKIPPED_TOP_LEVEL = {"test", "tests"}


def extract_world(kind: str, module: str):
    """Places the world's files at /ap/worlds/<folder> and returns (folder, manifest)."""
    if kind == "core":
        # The generic world is already part of the core bundle.
        if not os.path.exists(f"/ap/worlds/{module}"):
            shutil.copytree(f"/apsrc/worlds/{module}", f"/ap/worlds/{module}", ignore=shutil.ignore_patterns("__pycache__"))
        return module, {}

    with zipfile.ZipFile("/job/input.apworld") as apworld:
        names = [name for name in apworld.namelist() if not name.endswith("/") and not name.startswith("__MACOSX/")]
        folders = {name.split("/", 1)[0] for name in names if "/" in name}
        if len(folders) != 1:
            raise ValueError(f"an apworld must hold exactly one top-level folder, found {sorted(folders)}")
        folder = folders.pop()
        root_manifest = None
        for name in names:
            if "/" not in name:
                # Newer apworld builds put archipelago.json beside the world folder; other root files are ignored.
                if name == "archipelago.json":
                    root_manifest = apworld.read(name)
                continue
            relative = name.split("/", 1)[1]
            if ".." in relative.split("/"):
                raise ValueError(f"unsafe path in apworld: {name}")
            target = os.path.join("/ap/worlds", folder, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(apworld.read(name))
    manifest_path = f"/ap/worlds/{folder}/archipelago.json"
    # Folder worlds only read the manifest from inside the folder, so the bundle carries it there.
    if root_manifest is not None and not os.path.exists(manifest_path):
        with open(manifest_path, "wb") as f:
            f.write(root_manifest)
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    return folder, manifest


def describe(world_class, datapackage):
    tracker_world = getattr(world_class, "tracker_world", None)
    world_map = None
    if isinstance(tracker_world, dict):
        external = bool(tracker_world.get("external_pack_key"))
        world_map = {"external_pack": external, "internal_pack": bool(tracker_world.get("map_page_folder")) and not external}
    return {
        "game": world_class.game,
        "checksum": datapackage.get(world_class.game, {}).get("checksum"),
        "needs_yaml": not getattr(world_class, "ut_can_gen_without_yaml", False),
        "disable_ut": bool(getattr(world_class, "disable_ut", False)),
        "map": world_map,
    }


def analyze(kind: str, module: str) -> dict:
    with zipfile.ZipFile("/core/core-src.zip") as core:
        core.extractall("/")
    sys.path.insert(0, "/site-packages")
    import kalapana_boot

    kalapana_boot.prepare()
    folder, manifest = extract_world(kind, module)
    before = set(sys.modules)

    import worlds
    from worlds.AutoWorld import AutoWorldRegister

    if folder in worlds.failed_world_loads:
        # Import again directly to surface the original exception with its traceback.
        importlib.import_module(f"worlds.{folder}")

    classes = [cls for cls in AutoWorldRegister.world_types.values() if cls.__module__.split(".")[:2] == ["worlds", folder]]
    if not classes:
        raise ValueError(f"worlds.{folder} registered no World classes")
    datapackage = worlds.network_data_package["games"]
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
        "worlds": [describe(cls, datapackage) for cls in classes],
        "packages": packages,
        "bytes": os.path.getsize("/job/bundle.zip"),
    }


try:
    write_result(analyze(task_input["kind"], task_input["module"]))
except BaseException:
    write_result(failure())
