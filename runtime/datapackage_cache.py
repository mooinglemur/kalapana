"""Supplies datapackages the page already has, so CommonClient doesn't download them again.

The page keeps datapackages in IndexedDB between sessions and fetches missing ones from the room
(web/datapackage-cache.mjs), then passes the room's entries in before the tracker connects.
"""
import json
import logging

import Utils

_provided: dict[tuple[str, str], tuple[str, bool]] = {}


def install(entries) -> None:
    """entries: [game, checksum, JSON text, whether it came from the browser's cache]."""
    for game, checksum, text, cached in entries:
        _provided[(game, checksum)] = (text, cached)
    original_load = Utils.load_data_package_for_checksum

    def load(game, checksum):
        provided = _provided.get((game, checksum))
        if provided is not None:
            text, cached = provided
            data = json.loads(text)
            if data.get("checksum") == checksum:
                if cached:
                    logging.info(f"Loaded the {game} datapackage from this browser's cache.")
                return data
        return original_load(game, checksum)

    Utils.load_data_package_for_checksum = load
