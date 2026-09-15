"""Imports libraries an apworld ships inside its own folder.

Some apworlds carry a library their requirements.txt names (Super Junkoid carries
super_junkoid_randomizer) and import it by its top-level name. Desktop AP makes that work by extracting
it from the zipped .apworld or by installing the requirement, but worlds here are unpacked folders and
nothing is installed. So, as a last resort, a top-level import is answered from a world's folder when that
world's requirements.txt names the package and the folder contains it. Nothing else in a world's folder
becomes importable.
"""
import importlib.abc
import importlib.util
import os
import re
import sys

WORLDS_ROOT = "/ap/worlds"
_REQUIREMENT_NAME = re.compile(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _required_names(path: str) -> set[str]:
    """Requirement names from a requirements.txt, normalized the way import names are spelled."""
    names = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                match = _REQUIREMENT_NAME.match(line.split("#", 1)[0])
                if match:
                    names.add(re.sub(r"[-.]+", "_", match.group(1)).lower())
    except OSError:
        pass
    return names


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if "." in fullname or not os.path.isdir(WORLDS_ROOT):
            return None
        for world in sorted(os.listdir(WORLDS_ROOT)):
            package = os.path.join(WORLDS_ROOT, world, fullname)
            # Browser bundles hold compiled modules only.
            init = next((os.path.join(package, name) for name in ("__init__.py", "__init__.pyc")
                         if os.path.isfile(os.path.join(package, name))), None)
            if init and fullname.lower() in _required_names(os.path.join(WORLDS_ROOT, world, "requirements.txt")):
                return importlib.util.spec_from_file_location(fullname, init, submodule_search_locations=[package])
        return None


def install() -> None:
    """Adds the finder last on the meta path, so anything importable the normal way wins."""
    if not any(isinstance(finder, _Finder) for finder in sys.meta_path):
        sys.meta_path.append(_Finder())
