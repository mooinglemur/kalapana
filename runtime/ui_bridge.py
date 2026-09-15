"""Runs Universal Tracker without Kivy by standing in for the widgets it touches.

Everything UT would draw is sent to the page with postMessage: JSON strings for state, and plain
objects carrying bytes for map images. Colored text uses Kivy-style markup, [color=<name>]...[/color]
with &amp; &bl; &br; escapes, where <name> is a UT status or an Archipelago text color; the page maps
names to theme-aware colors.

The bridge also owns reconnection, following puna's journal page: jittered backoff while the tab is
visible, no attempts while it is hidden, and an immediate attempt when it is shown again.
"""
import asyncio
import copy
import json
import logging
import math
import os
import pkgutil
import random
import sys
import time
import zipfile
from collections import Counter

import js
from pyodide.ffi import to_js

import CommonClient
from CommonClient import server_loop
from NetUtils import JSONtoTextParser
from worlds.AutoWorld import AutoWorldRegister
from worlds.tracker import TrackerClient
from worlds.tracker.TrackerClient import TrackerGameContext

logger = logging.getLogger("Client")

RETRY_MIN_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
# The browser answers the server's protocol pings itself and never tells the page, so a connection that
# stopped delivering is only noticed by traffic stopping. After this much silence the bridge asks the
# server for something; after the longer one it gives the connection up.
PING_AFTER_SECONDS = 20
DEAD_AFTER_SECONDS = 45

# Paths of files the user supplied before connecting, keyed by purpose. UT asks for files
# synchronously in the middle of packet handling, so they have to be in place beforehand.
UPLOADS: dict[str, str] = {}

ctx: "BrowserTrackerContext | None" = None
_background_tasks: set[asyncio.Task] = set()


def post(message: dict) -> None:
    js.postMessage(json.dumps(message))


def post_connection(state: str, text: str, **details) -> None:
    """state is "connecting", "up" or "down"."""
    post({"type": "connection", "state": state, "text": text, **details})


def display_address(address: str | None) -> str:
    return (address or "").split("://", 1)[-1]


def get_ut_color(name: str) -> str:
    # The page maps status names to theme-aware colors.
    return name


def escape_markup(text: str) -> str:
    return text.replace("&", "&amp;").replace("[", "&bl;").replace("]", "&br;")


def flatten_parts(parts):
    # UT's /explain can hand over lists nested inside the message part list.
    for part in parts:
        if isinstance(part, list):
            yield from flatten_parts(part)
        else:
            yield part


class MarkupJSONtoTextParser(JSONtoTextParser):
    """Renders server messages as markup instead of the console parser's ANSI escapes (as kvui does)."""

    def _handle_color(self, node):
        node["text"] = escape_markup(node["text"])
        for color in node["color"].split(";"):
            if color in self.color_codes:
                node["text"] = f"[color={color}]{node['text']}[/color]"
                break
        return self._handle_text(node)

    def _handle_text(self, node):
        if node.get("type", "text") == "text":
            node["text"] = escape_markup(node["text"])
        return super()._handle_text(node)


def read_pack_file(source: str) -> bytes:
    """Resolves UT's `ap:zip:<pack.zip>/<file>` and `ap:<module>/<file>` image sources."""
    if source.startswith("ap:zip:"):
        zip_path, inner = source[len("ap:zip:"):].split(".zip/", 1)
        with zipfile.ZipFile(zip_path + ".zip") as pack:
            return pack.read(inner.lstrip("/"))
    module, inner = source[len("ap:"):].split("/", 1)
    return pkgutil.get_data(module, inner)


class TrackerListStandIn:
    """UT's TrackerView: a list of markup lines."""

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
        if ctx and ctx.quiet:
            return
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
            if not (ctx and ctx.quiet):
                self.send()

    def send(self) -> None:
        post({"type": "label", "name": self.name, "text": self._text})


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
        self._parser = MarkupJSONtoTextParser(ctx)

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
        markup = self._parser(list(flatten_parts(copy.deepcopy(data))))
        post({"type": "log", "level": "INFO", "markup": markup})

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


class Reconnector:
    """Tab visibility and backoff state for autoreconnect(). The page reports visibility and network
    changes through handle()."""

    def __init__(self):
        self.visible = True
        self.retry = RETRY_MIN_SECONDS
        self.events: asyncio.Queue = asyncio.Queue()

    def reset(self) -> None:
        self.retry = RETRY_MIN_SECONDS

    def notify(self, event: str) -> None:
        if event in ("visible", "hidden"):
            self.visible = event == "visible"
        self.events.put_nowait(event)

    def drain(self) -> None:
        while not self.events.empty():
            self.events.get_nowait()

    async def next_event(self, timeout: float | None = None) -> str | None:
        try:
            return await asyncio.wait_for(self.events.get(), timeout)
        except asyncio.TimeoutError:
            return None


reconnector = Reconnector()


async def autoreconnect(ctx: "BrowserTrackerContext") -> None:
    """Replaces CommonClient.server_autoreconnect, which server_loop schedules after a disconnect that
    wasn't intended."""
    reconnector.drain()
    address = display_address(ctx.server_address)
    while True:
        if not reconnector.visible:
            post_connection("down", "Not connected. Will reconnect when you come back to this tab.")
            if await reconnector.next_event() != "visible":
                continue
            # Coming back to the tab is news about the reader, not the server, so start from a clean backoff.
            reconnector.reset()
            break
        wait = reconnector.retry / 2 + random.random() * reconnector.retry / 2
        reconnector.retry = min(reconnector.retry * 2, RETRY_MAX_SECONDS)
        post_connection("down", f"Disconnected from {address}. Reconnecting in {math.ceil(wait)}s…")
        event = await reconnector.next_event(wait)
        if event is None:
            break
        if event == "online":
            reconnector.reset()
            break
    if ctx.server_address and ctx.server_task is None and not ctx.disconnected_intentionally:
        post_connection("connecting", f"Reconnecting to {address}…")
        ctx.server_task = asyncio.create_task(server_loop(ctx), name="server loop")


async def watch_connection(ctx: "BrowserTrackerContext") -> None:
    last_ping = 0.0
    while True:
        await asyncio.sleep(5)
        socket = ctx.server.socket if ctx.server else None
        if socket is None or not ctx.slot or not getattr(socket, "open", False):
            continue
        now = time.monotonic()
        silence = now - socket.last_heard
        if silence > DEAD_AFTER_SECONDS:
            logger.warning(f"No traffic from the server for {int(silence)}s; treating the connection as lost.")
            socket.abandon()
        elif silence > PING_AFTER_SECONDS and now - last_ping > PING_AFTER_SECONDS:
            last_ping = now
            # Any reply proves the link; this key is one CommonClient already reads.
            await ctx.send_msgs([{"cmd": "Get", "keys": ["_read_race_mode"]}])


class BrowserTrackerContext(TrackerGameContext):
    _loss_message: str | None = None
    # Set while an addon command runs. Some, like /next_progression, update the tracker once per item with
    # that item pretend-collected, so the page only hears the state once the command is done.
    quiet = False

    def run_gui(self) -> None:
        self.ui = BridgeUI(self)
        self.tracker_page = TrackerListStandIn()
        self.map_page = MapPageStandIn()
        self.markers: list[MarkerStandIn] = []
        self.map_page_coords_func = self.load_coords
        self.labels: list[LabelStandIn] = []
        for name, text in (
            ("tracker_total_locs_label", "Locations: 0/0"),
            ("tracker_logic_locs_label", "In Logic: 0"),
            ("tracker_glitched_locs_label", "Glitched: 0"),
            ("tracker_hinted_locs_label", "Hinted: 0"),
            ("tracker_go_mode_label", "Go Mode: No"),
        ):
            label = LabelStandIn(name, text)
            self.labels.append(label)
            setattr(self, name, label)

    def run_addon_command(self, text: str) -> None:
        self.quiet = True
        try:
            self.command_processor(self)(text)
        finally:
            self.quiet = False
        core = self.tracker_core
        if core.player_id and core.multiworld:
            self.updateTracker()
        for label in self.labels:
            label.send()

    def gui_error(self, title: str, text) -> None:
        post({"type": "log", "level": "ERROR", "text": f"{title}: {text}"})

    def handle_connection_loss(self, msg: str) -> None:
        # CommonClient's version also opens a GUI error box; here the banner and the log carry it.
        logger.exception(msg, exc_info=sys.exc_info(), extra={"compact_gui": True})
        self._loss_message = msg

    async def connection_closed(self):
        await super().connection_closed()
        will_retry = self.server_address and self.username and not self.disconnected_intentionally
        if not will_retry:
            post_connection("down", self._loss_message or "Disconnected.")
        self._loss_message = None

    def on_package(self, cmd: str, args: dict):
        super().on_package(cmd, args)
        if cmd == "Connected":
            reconnector.reset()
            slot_name = self.player_names.get(self.slot, self.auth)
            post_connection(
                "up",
                f"Connected to {display_address(self.server_address)} as {slot_name} ({self.game}).",
                slot=slot_name,
                game=self.game,
            )

    def updateTracker(self):
        started = time.perf_counter()
        result = super().updateTracker()
        if self.quiet:
            return result
        logic_seconds = time.perf_counter() - started
        self.tracker_page.flush()
        self.flush_markers()
        self.post_names()
        post({"type": "timing", "logic": round(logic_seconds, 4), "total": round(time.perf_counter() - started, 4),
              "items": len(self.items_received), "checked": len(self.checked_locations)})
        return result

    def post_names(self):
        """The names the page suggests while a command is typed, sent once per generated multiworld.

        Each list is what that command matches against: the server's !hint and !hint_location take
        names or groups, !getitem takes item names, and UT's /explain takes the generated world's
        locations and regions.
        """
        multiworld = self.tracker_core.multiworld
        player = self.tracker_core.player_id
        if multiworld is None or player is None or getattr(self, "_names_sent_for", None) is multiworld:
            return
        world = self.tracker_core.get_current_world()
        if world is None:
            return
        self._names_sent_for = multiworld
        items = set(world.item_name_to_id)
        locations = set(world.location_name_to_id)

        def ordered(names):
            return sorted(names, key=str.casefold)

        post({
            "type": "names",
            "items": ordered(items),
            "hint_items": ordered(items | set(world.item_name_groups)),
            "hint_locations": ordered(locations | set(world.location_name_groups)),
            "explain": ordered(set(multiworld.regions.location_cache[player]) | set(multiworld.regions.region_cache[player])),
        })

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
        message = record.getMessage()
        # CommonClient's own retry estimate; the banner states kalapana's actual wait.
        if message.startswith("... automatically reconnecting in"):
            return
        # Connection losses are expected during reconnects, so they log as one line, like kvui's compact view.
        text = message if getattr(record, "compact_gui", False) else self.format(record)
        post({"type": "log", "level": record.levelname, "text": text})


def start(pack_path: str | None = None) -> BrowserTrackerContext:
    global ctx
    if pack_path:
        UPLOADS["poptracker_pack"] = pack_path
    TrackerClient.get_ut_color = get_ut_color
    TrackerClient.open_filename = lambda *args, **kwargs: UPLOADS.get("poptracker_pack")
    CommonClient.server_autoreconnect = autoreconnect

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(PostLogHandler())

    ctx = BrowserTrackerContext(None, None)
    # Without a YAML there is nothing to generate yet: UT regenerates YAML-less worlds from slot data on
    # connect, and running it now only logs a "no player files" traceback.
    if any(name.endswith((".yaml", ".yml")) for name in os.listdir("Players")):
        ctx.run_generator()
    ctx.run_gui()
    watchdog = asyncio.create_task(watch_connection(ctx), name="connection watchdog")
    _background_tasks.add(watchdog)
    return ctx


def is_addon_command(text: str) -> bool:
    """Whether text runs a command Universal Tracker Addons registered."""
    if not text.startswith("/"):
        return False
    try:
        from worlds.tracker_addons import UT_FUNCTIONS
    except ImportError:
        return False
    # CommandProcessor matches command names case-insensitively.
    return text[1:].split(" ", 1)[0].lower() in UT_FUNCTIONS


def handle(message_json: str) -> None:
    message = json.loads(message_json)
    kind = message["type"]
    if kind == "connect":
        ctx.auth = message["slot"]
        ctx.password = message.get("password") or None
        post_connection("connecting", f"Connecting to {display_address(message['address'])}…")
        ctx.server_task = asyncio.create_task(server_loop(ctx, message["address"]), name="server loop")
    elif kind == "command":
        text = message["text"]
        if is_addon_command(text):
            ctx.run_addon_command(text)
        else:
            ctx.command_processor(ctx)(text)
    elif kind == "load_map":
        ctx.load_map(message["map"])
        ctx.updateTracker()
    elif kind == "visibility":
        reconnector.notify("visible" if message["visible"] else "hidden")
    elif kind == "online":
        reconnector.notify("online")
