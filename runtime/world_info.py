"""Unpacks an apworld and describes its World classes the way Universal Tracker will see them.

Shared by the analyzer, which builds the catalog, and the browser, which checks an apworld the player
supplies. Expects kalapana_boot.prepare() to have run.
"""
import importlib
import json
import os
import traceback
import zipfile

WORLDS_ROOT = "/ap/worlds"


def extract_apworld(path: str) -> tuple[str, dict]:
    """Places the apworld's files at /ap/worlds/<folder> and returns (folder, manifest)."""
    with zipfile.ZipFile(path) as apworld:
        names = [name for name in apworld.namelist() if not name.endswith("/") and not name.startswith("__MACOSX/")]
        folders = {name.split("/", 1)[0] for name in names if "/" in name}
        if len(folders) != 1:
            raise ValueError(f"an apworld must hold exactly one top-level folder, found {sorted(folders)}")
        folder = folders.pop()
        if os.path.exists(os.path.join(WORLDS_ROOT, folder)):
            raise ValueError(f"the apworld's folder {folder!r} is already used by a built-in world")
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
            target = os.path.join(WORLDS_ROOT, folder, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(apworld.read(name))
    manifest_path = os.path.join(WORLDS_ROOT, folder, "archipelago.json")
    # Folder worlds only read the manifest from inside the folder.
    if root_manifest is not None and not os.path.exists(manifest_path):
        with open(manifest_path, "wb") as f:
            f.write(root_manifest)
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    return folder, manifest


def world_classes(folder: str) -> list:
    """Imports worlds and returns the World classes registered from worlds.<folder>."""
    import worlds
    from worlds.AutoWorld import AutoWorldRegister

    if folder in worlds.failed_world_loads:
        # Import again directly to surface the original exception with its traceback.
        importlib.import_module(f"worlds.{folder}")
    classes = [cls for cls in AutoWorldRegister.world_types.values() if cls.__module__.split(".")[:2] == ["worlds", folder]]
    if not classes:
        raise ValueError(f"worlds.{folder} registered no World classes")
    return classes


def describe(world_class) -> dict:
    import worlds

    tracker_world = getattr(world_class, "tracker_world", None)
    world_map = None
    if isinstance(tracker_world, dict):
        external = bool(tracker_world.get("external_pack_key"))
        world_map = {"external_pack": external, "internal_pack": bool(tracker_world.get("map_page_folder")) and not external}
    return {
        "game": world_class.game,
        "checksum": worlds.network_data_package["games"].get(world_class.game, {}).get("checksum"),
        "needs_yaml": not getattr(world_class, "ut_can_gen_without_yaml", False),
        "disable_ut": bool(getattr(world_class, "disable_ut", False)),
        "map": world_map,
    }


def inspect_upload(path: str) -> str:
    """The browser's entry point. Returns JSON, carrying the traceback when the apworld can't be used."""
    try:
        folder, manifest = extract_apworld(path)
        described = [describe(cls) for cls in world_classes(folder)]
        return json.dumps({"ok": True, "module": folder, "version": manifest.get("world_version"), "worlds": described})
    except BaseException:
        return json.dumps({"ok": False, "error": traceback.format_exc()})
