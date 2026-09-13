"""Runs Universal Tracker without Kivy by standing in for the widgets it touches.

Everything UT would draw is sent to the page with postMessage: JSON strings for state,
and plain objects carrying bytes for map images.
"""
import asyncio
import copy
import json
import logging
import pkgutil
import time
import zipfile
from collections import Counter

import js
from pyodide.ffi import to_js

import settings
from CommonClient import server_loop
from worlds.AutoWorld import AutoWorldRegister
from worlds.tracker import TrackerClient
from worlds.tracker.TrackerClient import TrackerGameContext

# Colors from <UTTextColor> in tracker/Tracker.kv.
UT_COLORS = {
    "in_logic": "20ff20",
    "out_of_logic": "cf1010",
    "glitched": "ffff20",
    "collected": "3F3F3F",
    "collected_light": "FFFFFF",
    "in_logic_glitched": "afff20",
    "out_of_logic_glitched": "ef5500",
    "mixed_logic": "ff9f20",
    "hinted": "3040ff",
    "hinted_in_logic": "20ffff",
    "hinted_out_of_logic": "c010ff",
    "hinted_glitched": "ff9f20",
    "excluded": "CFCFCF",
    "excluded_glitched": "ef5500",
    "unconnected": "89F336",
    "error": "FF0000",
    "default": "FFFFFF",
    "ut_status": "FFFFFF",
}

# Paths of files the user has already uploaded, keyed by purpose. UT asks for files synchronously
# in the middle of packet handling, so uploads have to happen before that point.
UPLOADS: dict[str, str] = {}

ctx: "BrowserTrackerContext | None" = None


def post(message: dict) -> None:
    js.postMessage(json.dumps(message))


def get_ut_color(name: str) -> str:
    return UT_COLORS.get(name, "DD00FF")


def read_pack_file(source: str) -> bytes:
    """Resolves UT's `ap:zip:<pack.zip>/<file>` and `ap:<module>/<file>` image sources."""
    if source.startswith("ap:zip:"):
        zip_path, inner = source[len("ap:zip:"):].split(".zip/", 1)
        with zipfile.ZipFile(zip_path + ".zip") as pack:
            return pack.read(inner.lstrip("/"))
    module, inner = source[len("ap:"):].split("/", 1)
    return pkgutil.get_data(module, inner)


class TrackerListStandIn:
    """UT's TrackerView: a list of Kivy-markup lines."""

    def __init__(self):
        self._data: list[dict] = []

    @property
    def data(self) -> list[dict]:
        return self._data

    @data.setter
    def data(self, value: list[dict]) -> None:
        self._data = list(value)
        self.flush()

    def resetData(self) -> None:
        self._data.clear()

    def addLine(self, line: str, sort: bool = False) -> None:
        self._data.append({"text": line})

    def refresh_from_data(self) -> None:
        # UT keeps adding lines after this call, so the context flushes once updateTracker returns.
        pass

    def flush(self) -> None:
        post({"type": "tracker", "lines": [entry["text"] for entry in self._data]})


class LabelStandIn:
    def __init__(self, name: str, text: str):
        self.name = name
        self._text = text

    @property
    def text(self) -> str:
        return self._text

    @text.setter
    def text(self, value: str) -> None:
        if value != self._text:
            self._text = value
            post({"type": "label", "name": self.name, "text": value})


class MarkerStandIn:
    """One poptracker map location: UT's APLocationSplit, APLocationMixed or ApLocationDeferred."""

    _next_id = 0

    def __init__(self, kind: str, sections: list, pos: tuple, size: int):
        MarkerStandIn._next_id += 1
        self.id = MarkerStandIn._next_id
        self.kind = kind
        self.pos = pos
        self.size = size
        self.locationDict = {section: "none" for section in sections}
        self.dirty = True

    def update_status(self, location, status: str) -> None:
        if location in self.locationDict and self.locationDict[location] != status:
            self.locationDict[location] = status
            self.dirty = True

    def colors(self) -> list[str]:
        statuses = list(self.locationDict.values())
        if self.kind == "deferred":
            if "passable" in statuses:
                return [get_ut_color("in_logic")]
            if "impassable" in statuses:
                return [get_ut_color("out_of_logic")]
            return [get_ut_color("collected")]
        if self.kind == "mixed":
            return [get_ut_color(mixed_status(statuses))]
        return [get_ut_color(name) for name in split_statuses(statuses)]

    def tooltip(self, location_names: dict[int, str]) -> str:
        return "\n".join(f"{location_names.get(key, key)}: {status}" for key, status in self.locationDict.items())


def mixed_status(statuses: list[str]) -> str:
    glitches = any(s.endswith("glitched") for s in statuses)
    in_logic = any(s.endswith("in_logic") for s in statuses)
    out_of_logic = any(s.endswith("out_of_logic") for s in statuses)
    hinted = any(s.startswith("hinted") for s in statuses)
    if in_logic and (out_of_logic or (glitches and hinted)):
        return "mixed_logic"
    if glitches and hinted:
        return "hinted_glitched"
    if hinted and out_of_logic:
        return "hinted_out_of_logic"
    if hinted:
        return "hinted"
    if glitches and in_logic:
        return "in_logic_glitched"
    if glitches and out_of_logic:
        return "out_of_logic_glitched"
    if in_logic:
        return "in_logic"
    if out_of_logic:
        return "out_of_logic"
    if glitches:
        return "glitched"
    return "collected"


def split_statuses(statuses: list[str]) -> list[str]:
    """Four quadrant statuses, in UT's order of importance."""
    counts = Counter(s for s in statuses if s != "collected")

    def priority(pair) -> float:
        if pair[0] == "out_of_logic":
            return 0
        if pair[0] == "in_logic":
            return 999999999
        if pair[0] == "hinted_in_logic":
            return 8888888
        return pair[1] + ord(pair[0][0]) / 10

    ordered = [name for name, _ in sorted(counts.items(), key=priority, reverse=True)]
    if not ordered:
        return ["collected"] * 4
    return (ordered * max(2, 4 // len(ordered)))[:4]


class MapPageStandIn:
    def update_location_icon_widgets(self, ctx: "BrowserTrackerContext", location_icons: list) -> None:
        post({
            "type": "map_icons",
            "icons": [{"x": x, "y": y, "source": f"{ctx.root_pack_path}/{ref}"} for x, y, ref in location_icons],
            "size": ctx.ui.loc_icon_size,
        })


class BridgeUI:
    """The subset of UT's TrackerManager (a kvui GameManager) that UT and CommonClient call."""

    def __init__(self, ctx: "BrowserTrackerContext"):
        self.ctx = ctx
        self.loc_size = 65
        self.loc_icon_size = 65
        self.loc_border = 8
        self.last_autofillable_command = ""
        self.auto_tab = True
        self._source = ""
        self._current_map = ""
        self._show_map = False
        self._sent_images: set[str] = set()

    @property
    def source(self) -> str:
        return self._source

    @source.setter
    def source(self, value: str) -> None:
        self._source = value
        if value not in self._sent_images:
            self._sent_images.add(value)
            js.postMessage(to_js({"type": "image", "source": value, "bytes": read_pack_file(value)},
                                 dict_converter=js.Object.fromEntries))
        post({"type": "map_image", "source": value})

    @property
    def current_map(self) -> str:
        return self._current_map

    @current_map.setter
    def current_map(self, value: str) -> None:
        self._current_map = value
        post({"type": "current_map", "name": value})

    @property
    def show_map(self) -> bool:
        return self._show_map

    @show_map.setter
    def show_map(self, value: bool) -> None:
        self._show_map = value
        maps = [m["name"] for m in getattr(self.ctx, "maps", [])] if value else []
        post({"type": "show_map", "value": value, "maps": maps})

    def print_json(self, data: list) -> None:
        post({"type": "log", "level": "INFO", "text": self.ctx.jsontotextparser(copy.deepcopy(data))})

    def update_hints(self) -> None:
        core = self.ctx.tracker_core
        if core.player_id and core.multiworld:
            self.ctx.updateTracker()

    def update_address_bar(self, text: str) -> None:
        post({"type": "address", "text": text})

    def focus_textinput(self) -> None:
        pass

    def enable_energy_link(self) -> None:
        pass

    def set_new_energy_link_value(self) -> None:
        pass

    def stop(self) -> None:
        pass


class BrowserTrackerContext(TrackerGameContext):
    def run_gui(self) -> None:
        self.ui = BridgeUI(self)
        self.tracker_page = TrackerListStandIn()
        self.map_page = MapPageStandIn()
        self.markers: list[MarkerStandIn] = []
        self.map_page_coords_func = self.load_coords
        for name, text in (
            ("tracker_total_locs_label", "Locations: 0/0"),
            ("tracker_logic_locs_label", "In Logic: 0"),
            ("tracker_glitched_locs_label", "Glitched: 0"),
            ("tracker_hinted_locs_label", "Hinted: 0"),
            ("tracker_go_mode_label", "Go Mode: No"),
        ):
            setattr(self, name, LabelStandIn(name, text))

    def gui_error(self, title: str, text) -> None:
        post({"type": "log", "level": "ERROR", "text": f"{title}: {text}"})

    def updateTracker(self):
        started = time.perf_counter()
        result = super().updateTracker()
        logic_seconds = time.perf_counter() - started
        self.tracker_page.flush()
        self.flush_markers()
        post({"type": "timing", "logic": round(logic_seconds, 4), "total": round(time.perf_counter() - started, 4),
              "items": len(self.items_received), "checked": len(self.checked_locations)})
        return result

    def load_coords(self, coords: dict, deferred_coords: dict, event_coords: dict, use_split: bool,
                    default_loc_size: int = 65):
        location_markers, entrance_markers, event_markers = {}, {}, {}
        self.markers = []
        groups = (
            (coords, "split" if use_split else "mixed", location_markers),
            (deferred_coords, "deferred", entrance_markers),
            (event_coords, "deferred", event_markers),
        )
        for group, kind, lookup in groups:
            for pos, (sections, size) in group.items():
                marker = MarkerStandIn(kind, sections, pos, size if size is not None else default_loc_size)
                self.markers.append(marker)
                for section in sections:
                    lookup.setdefault(section, []).append(marker)
        post({
            "type": "map_markers",
            "border": self.ui.loc_border,
            "markers": [{"id": m.id, "kind": m.kind, "x": m.pos[0], "y": m.pos[1], "size": m.size} for m in self.markers],
        })
        return location_markers, entrance_markers, event_markers

    def flush_markers(self) -> None:
        dirty = [m for m in self.markers if m.dirty]
        if not dirty or not self.game:
            return
        names = AutoWorldRegister.world_types[self.game].location_id_to_name
        post({"type": "marker_status",
              "updates": [{"id": m.id, "colors": m.colors(), "tooltip": m.tooltip(names)} for m in dirty]})
        for marker in dirty:
            marker.dirty = False


class PostLogHandler(logging.Handler):
    # CommonClient copies server text to these loggers for its log file and console; the page
    # already gets that text through BridgeUI.print_json.
    SKIPPED_LOGGERS = {"FileLog", "StreamLog"}

    def emit(self, record: logging.LogRecord) -> None:
        if record.name in self.SKIPPED_LOGGERS:
            return
        post({"type": "log", "level": record.levelname, "text": self.format(record)})


def start() -> BrowserTrackerContext:
    global ctx
    settings.no_gui = True
    TrackerClient.get_ut_color = get_ut_color
    TrackerClient.open_filename = lambda *args, **kwargs: UPLOADS.get("poptracker_pack")

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(PostLogHandler())

    ctx = BrowserTrackerContext(None, None)
    ctx.run_generator()
    ctx.run_gui()
    return ctx


def handle(message_json: str) -> None:
    message = json.loads(message_json)
    kind = message["type"]
    if kind == "connect":
        ctx.auth = message["slot"]
        ctx.server_task = asyncio.create_task(server_loop(ctx, message["address"]), name="server loop")
    elif kind == "command":
        ctx.command_processor(ctx)(message["text"])
    elif kind == "load_map":
        ctx.load_map(message["map"])
        ctx.updateTracker()
