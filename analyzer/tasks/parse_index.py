"""Reads an Archipelago-index checkout mounted at /index into JSON for the server."""
import os
import sys
import tomllib

sys.path.insert(0, "/tasks")
from bundling import failure, write_result


def load(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


try:
    index = load("/index/index.toml")
    index_dir = index.get("index_dir", "index")
    worlds = {}
    errors = {}
    for name in sorted(os.listdir(os.path.join("/index", index_dir))):
        if name.endswith(".toml"):
            try:
                worlds[name[: -len(".toml")]] = load(os.path.join("/index", index_dir, name))
            except Exception as e:
                errors[name] = f"{type(e).__name__}: {e}"
    lock = load("/index/index.lock") if os.path.exists("/index/index.lock") else {}
    write_result({
        "ok": True,
        "archipelago_version": index["archipelago_version"],
        "index_dir": index_dir,
        "worlds": worlds,
        "lock": lock,
        "errors": errors,
    })
except Exception:
    write_result(failure())
