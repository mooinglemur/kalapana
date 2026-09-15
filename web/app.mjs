// Page logic: find the room's game and matching world bundle, collect any files the world needs,
// run the tracker in a worker, and render what it reports.
import { loadDatapackages, saveDatapackage } from "./datapackage-cache.mjs";

const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

// Exposed for automated tests.
const ui = (window.kalapanaState = {
  phase: "loading",
  entry: null,
  bootTimings: null,
  connection: { state: "idle", text: "" },
  trackerLines: [],
  labels: {},
  maps: [],
  markers: 0,
  markerUpdates: 0,
  mapImageLoaded: false,
  logs: [],
  updates: [],
  error: null,
});

let catalog = null;
let pending = null;
let worker = null;
// An apworld the player chose to track with. Offered once a room check has found the slot's game, whether
// or not the catalog matches, so a newer apworld with the same datapackage but different logic can be used.
// A chosen file takes precedence over the catalog. Withdrawn when the connection details change.
let uploadOffered = false;
let apworldFile = null;
const images = new Map();
const markerNodes = new Map();
let markerBorder = 8;

// --- remembered entries -------------------------------------------------------------------------
// The server, slot and password survive a reload, and the last few combinations that actually
// connected are offered from the Recent menu. All of it stays in this browser's localStorage.

const STORAGE_KEYS = { fields: "kalapana.connection", recent: "kalapana.recent" };
const RECENT_MAX = 5;

function loadStored(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    // Storage can be unavailable or hold junk; the page works without it.
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Unstorable, so it lasts until the page is left.
  }
}

function currentFields() {
  return { address: serverAddress.trim(), slot: $("slot").value.trim(), password: $("password").value };
}

function fillFields({ address = "", slot = "", password = "" }) {
  serverAddress = address;
  showAddress();
  $("slot").value = slot;
  $("password").value = password;
  store(STORAGE_KEYS.fields, currentFields());
}

function sameCombination(a, b) {
  return a.address === b.address && a.slot === b.slot && (a.password ?? "") === (b.password ?? "");
}

function rememberSuccess(entry) {
  const recent = loadStored(STORAGE_KEYS.recent, []).filter((item) => !sameCombination(item, entry));
  recent.unshift({ ...entry, at: Date.now() });
  store(STORAGE_KEYS.recent, recent.slice(0, RECENT_MAX));
  renderRecent();
}

function ago(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function renderRecent() {
  const recent = loadStored(STORAGE_KEYS.recent, []);
  $("recent-button").hidden = recent.length === 0;
  $("recent-list").replaceChildren(...recent.map((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("span");
    title.textContent = `${entry.slot} on ${hidePorts(entry.address)}`;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.textContent = [entry.game, ago(entry.at)].filter(Boolean).join(" · ");
    button.append(title, detail);
    button.addEventListener("click", () => {
      $("recent").hidePopover();
      if (sameCombination(entry, currentFields())) return;
      // Picking another connection while tracking switches to it.
      const switching = isTracking();
      if (switching) stopTracking();
      fillFields(entry);
      abandonCheckedRoom();
      withdrawUpload();
      if (switching) onConnect();
    });
    const li = document.createElement("li");
    li.append(button);
    return li;
  }));
}

// --- streamer mode ------------------------------------------------------------------------------
// Hides the room's port, which is enough to join it, from the address field and the status line.
// The field holds the real address only while it has focus; `serverAddress` is the source of truth.

const STREAMER_KEY = "kalapana.streamer";
let streamerMode = loadStored(STREAMER_KEY, false) === true;
let serverAddress = "";

// Best effort: masks anything shaped like host:port.
function hidePorts(text) {
  return streamerMode ? text.replace(/([\w\-.\]]):\d{1,5}(?!\d)/g, "$1:•••••") : text;
}

function showAddress() {
  const input = $("address");
  input.value = document.activeElement === input ? serverAddress : hidePorts(serverAddress);
}

// --- the status line ----------------------------------------------------------------------------
// The dot and the sentence always change together. state: "idle" (muted), "connecting", "up", "down".

function setStatus(state, text, { error = false } = {}) {
  ui.connection = { state, text };
  if (error) ui.error = text;
  $("link").className = state === "up" ? "link-state up" : state === "down" ? "link-state down" : "link-state";
  $("status").className = state === "down" ? "warning status" : "notice status";
  $("message").textContent = hidePorts(text);
}

// --- markup -------------------------------------------------------------------------------------

function unescapeMarkup(text) {
  return text.replaceAll("&bl;", "[").replaceAll("&br;", "]").replaceAll("&amp;", "&");
}

// A color name from the bridge (a UT status or Archipelago text color) or a raw hex value.
function colorValue(token) {
  if (/^[0-9a-fA-F]{6}$/.test(token)) return `#${token}`;
  if (/^[a-z_]+$/.test(token)) return `var(--c-${token}, currentColor)`;
  return null;
}

// Renders [color=...]...[/color] markup; other markup tags are dropped.
function renderMarkup(target, text) {
  target.replaceChildren();
  const pattern = /\[color=#?([0-9A-Za-z_]+)\]([\s\S]*?)\[\/color\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(unescapeMarkup(text.slice(last, match.index)));
    const span = document.createElement("span");
    const color = colorValue(match[1]);
    if (color) span.style.color = color;
    span.textContent = unescapeMarkup(match[2]);
    target.append(span);
    last = match.index + match[0].length;
  }
  target.append(unescapeMarkup(text.slice(last)));
}

// Lines are kept as received and masked when drawn, so turning streamer mode on or off can redraw them.
function logLine({ level, text, markup }) {
  const li = document.createElement("li");
  li.className = level;
  if (markup !== undefined) renderMarkup(li, hidePorts(markup));
  else li.textContent = hidePorts(text);
  return li;
}

const LOG_MAX = 2000;

function addLog(level, { text, markup }) {
  const entry = { level, text: text ?? unescapeMarkup(markup.replace(/\[\/?color[^\]]*\]/g, "")), markup };
  ui.logs.push(entry);
  const lines = $("log-lines");
  const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 40;
  lines.append(logLine(entry));
  if (ui.logs.length > LOG_MAX) {
    ui.logs.shift();
    const oldest = lines.firstElementChild;
    const height = oldest.offsetHeight;
    oldest.remove();
    // Someone reading back through the log keeps their place.
    if (!atBottom) lines.scrollTop -= height;
  }
  if (atBottom) lines.scrollTop = lines.scrollHeight;
}

// --- finding the room's game --------------------------------------------------------------------

// Opens a short-lived connection to learn the room's datapackage checksums and the slot's game.
function probeUrl(url, slot, password) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const finish = (settle, value) => {
      clearTimeout(timer);
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out connecting to ${url}`)), 15_000);
    socket.onerror = () => finish(reject, new Error(`Couldn't connect to ${url}`));
    socket.onclose = () => finish(reject, new Error(`${url} closed the connection`));
    let roomInfo = null;
    socket.onmessage = (event) => {
      for (const packet of JSON.parse(event.data)) {
        if (packet.cmd === "RoomInfo") {
          roomInfo = packet;
          const games = (packet.games ?? []).filter((game) => game !== "Archipelago");
          if (games.length === 1) return finish(resolve, { roomInfo, game: games[0] });
          const [major, minor, build] = catalog.archipelagoVersion.split(".").map(Number);
          socket.send(JSON.stringify([{
            cmd: "Connect",
            password,
            name: slot,
            version: { major, minor, build, class: "Version" },
            tags: ["Tracker", "NoText"],
            items_handling: 0,
            uuid: crypto.randomUUID(),
            game: "",
            slot_data: false,
          }]));
        } else if (packet.cmd === "Connected") {
          return finish(resolve, { roomInfo, game: packet.slot_info[String(packet.slot)].game });
        } else if (packet.cmd === "ConnectionRefused") {
          const reasons = (packet.errors ?? []).join(", ") || "no reason given";
          const err = new Error(`The server refused slot "${slot}": ${reasons}`);
          err.refused = true;
          return finish(reject, err);
        }
      }
    };
  });
}

async function probe(address, slot, password) {
  const urls = /^wss?:\/\//.test(address)
    ? [address]
    : location.protocol === "https:" ? [`wss://${address}`] : [`wss://${address}`, `ws://${address}`];
  let lastError;
  for (const url of urls) {
    try {
      return { url, ...(await probeUrl(url, slot, password)) };
    } catch (err) {
      if (err.refused) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

// --- datapackages -------------------------------------------------------------------------------
// The page, not the worker, owns the datapackage cache (see datapackage-cache.mjs).

// Fetches datapackages straight from the room, which answers GetDataPackage without a login.
function downloadDatapackages(url, games) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const received = {};
    let replies = 0;
    const finish = (settle, value) => {
      clearTimeout(timer);
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out downloading datapackages from ${url}`)), 60_000);
    socket.onerror = () => finish(reject, new Error(`Couldn't connect to ${url}`));
    socket.onclose = () => finish(reject, new Error(`${url} closed the connection`));
    socket.onmessage = (event) => {
      for (const packet of JSON.parse(event.data)) {
        if (packet.cmd === "RoomInfo") {
          // One game per request keeps each reply small.
          socket.send(JSON.stringify(games.map((game) => ({ cmd: "GetDataPackage", games: [game] }))));
        } else if (packet.cmd === "DataPackage") {
          Object.assign(received, packet.data?.games);
          if (++replies === games.length) return finish(resolve, received);
        }
      }
    };
  });
}

// Returns [game, checksum, JSON text, fromCache] for the room's other games. Anything that can't be
// supplied is left for the tracker to download as usual.
async function gatherDatapackages({ url, checksums, game }) {
  const wanted = Object.fromEntries(
    Object.entries(checksums).filter(([name, checksum]) => checksum && name !== game && name !== "Archipelago"),
  );
  const entries = [];
  const { found, rejected } = await loadDatapackages(wanted);
  for (const name of rejected) {
    addLog("WARNING", { text: `Ignored this browser's cached ${name} datapackage because it failed its integrity check.` });
  }
  for (const [name, text] of Object.entries(found)) entries.push([name, wanted[name], text, true]);
  const missing = Object.keys(wanted).filter((name) => !(name in found));
  if (!missing.length) return entries;
  try {
    const downloaded = await downloadDatapackages(url, missing);
    const names = [];
    for (const name of missing) {
      const data = downloaded[name];
      if (data?.checksum !== wanted[name]) continue;
      const text = JSON.stringify(data);
      entries.push([name, wanted[name], text, false]);
      names.push(name);
      saveDatapackage(name, wanted[name], text);
    }
    if (names.length) addLog("INFO", { text: `Downloaded the datapackages for ${names.join(", ")}.` });
  } catch {
    // The tracker downloads whatever is still missing.
  }
  return entries;
}

function isTracking() {
  return ui.phase === "booting" || ui.phase === "tracking";
}

// One button: Connect when idle, Disconnect while a tracker is running (including while it retries).
function onSubmit(event) {
  event.preventDefault();
  if (isTracking()) stopTracking();
  else onConnect();
}

const runtimeInfo = () => ({ pyodide: catalog.pyodide, core: catalog.core, tracker: catalog.tracker });

function discardWorker() {
  worker?.terminate();
  worker = null;
}

// The server gives the worker a Content Security Policy that only allows kalapana and this room.
function spawnWorker(roomUrl) {
  discardWorker();
  const started = new Worker(`worker.mjs?${new URLSearchParams({ room: new URL(roomUrl).host })}`, { type: "module" });
  worker = started;
  // Messages a stopped worker queued before it was terminated are dropped.
  started.onmessage = (event) => worker === started && onWorkerMessage(event);
  return started;
}

function askForFiles(entry) {
  $("yaml-field").hidden = !entry.needsYaml;
  $("pack-field").hidden = !entry.map?.externalPack;
  $("files").hidden = false;
  const asks = [entry.needsYaml && "your player YAML", entry.map?.externalPack && "optionally its poptracker pack for the map"].filter(Boolean);
  setStatus("idle", `${pending.description}. Add ${asks.join(" and ")}, then start tracking.`);
  ui.phase = "files";
  $("connect").disabled = false;
}

// The worker loads the player's apworld and reports its worlds; onInspected decides whether it fits.
async function inspectUpload(attempt) {
  setStatus("connecting", `Loading ${apworldFile.name}…`);
  const bytes = new Uint8Array(await apworldFile.arrayBuffer());
  if (attempt !== checkAttempt) return;
  spawnWorker(pending.url).postMessage({ type: "inspect", runtime: runtimeInfo(), apworld: { name: apworldFile.name, bytes } }, [bytes.buffer]);
}

function onInspected(result) {
  if (ui.phase !== "checking" || !pending) return;
  const name = apworldFile?.name ?? "The apworld";
  const fail = (text) => {
    discardWorker();
    ui.phase = "ready";
    $("connect").disabled = false;
    setStatus("down", text, { error: true });
  };
  if (!result.ok) {
    addLog("ERROR", { text: result.error });
    return fail(`${name} couldn't be loaded. See the Log view.`);
  }
  const { game, slot } = pending;
  const world = result.worlds.find((candidate) => candidate.game === game);
  if (!world) return fail(`${name} is for ${result.worlds.map((candidate) => candidate.game).join(", ")}, but slot "${slot}" plays ${game}.`);
  if (world.checksum !== pending.checksum) {
    return fail(`${name} doesn't match this room's ${game} datapackage, so it's probably not the version the room was generated with.`);
  }
  if (world.disable_ut) return fail(`The author of ${game} has asked Universal Tracker not to track it.`);

  const entry = {
    module: result.module,
    version: result.version ?? null,
    source: "upload",
    checksum: world.checksum,
    packages: [],
    needsYaml: world.needs_yaml,
    disableUt: world.disable_ut,
    map: world.map && { externalPack: world.map.external_pack, internalPack: world.map.internal_pack },
  };
  pending.entry = entry;
  pending.description = `${game}${entry.version ? ` ${entry.version}` : ""} from ${name}`;
  ui.entry = entry;
  if (entry.needsYaml || entry.map?.externalPack) return askForFiles(entry);
  startTracking().catch((err) => setStatus("down", err.message, { error: true }));
}

// Counts connection checks, so a check that finishes after the details changed is ignored.
let checkAttempt = 0;

// A room being checked, or checked and waiting for its files, no longer applies once the details change.
function abandonCheckedRoom() {
  if (ui.phase !== "checking" && ui.phase !== "files") return;
  checkAttempt++;
  discardWorker();
  pending = null;
  ui.entry = null;
  ui.phase = "ready";
  $("files").hidden = true;
  $("connect").disabled = false;
  setStatus("idle", "The connection details changed. Connect again to check them.");
}

async function onConnect() {
  const { address, slot, password } = currentFields();
  const attempt = ++checkAttempt;
  store(STORAGE_KEYS.fields, currentFields());
  ui.phase = "checking";
  ui.error = null;
  $("connect").disabled = true;
  discardWorker();
  // Files picked for an earlier room may belong to a different game.
  pending = null;
  $("files").hidden = true;
  $("yaml").value = "";
  $("pack").value = "";
  setStatus("connecting", `Checking ${address}…`);
  try {
    const { url, roomInfo, game } = await probe(address, slot, password || null);
    if (attempt !== checkAttempt) return;
    const checksum = roomInfo.datapackage_checksums?.[game];
    pending = {
      url, address, slot, password: password || null, game, checksum, entry: null, description: game,
      checksums: roomInfo.datapackage_checksums ?? {},
    };

    offerUpload();
    if (apworldFile) return await inspectUpload(attempt);
    const candidates = catalog.games[game] ?? [];
    const matches = candidates.filter((candidate) => candidate.checksum === checksum);
    if (!matches.length) {
      if (!candidates.length) throw new Error(`${game} isn't in the tracker catalog. If you have its apworld, you can use it instead.`);
      // The catalog lists newest first; people read version lists oldest first.
      const known = [...new Set(candidates.map((candidate) => candidate.version))].reverse().join(", ");
      throw new Error(`No ${game} version in the catalog matches this room's datapackage (${String(checksum).slice(0, 12)}…). Known versions: ${known}. If you have the apworld the room was generated with, you can use it instead.`);
    }
    // The catalog sorts each game's versions newest first, numerically, so this is the latest match.
    const entry = matches[0];
    if (entry.disableUt) throw new Error(`The author of ${game} has asked Universal Tracker not to track it.`);

    pending.entry = entry;
    ui.entry = entry;
    const sameData = matches.length > 1 ? ` (${matches.length} versions share this datapackage; using the newest)` : "";
    pending.description = `${game} ${entry.version}${sameData}`;
    if (entry.needsYaml || entry.map?.externalPack) return askForFiles(entry);
    await startTracking();
  } catch (err) {
    if (attempt !== checkAttempt) return;
    ui.phase = "ready";
    setStatus("down", err.message, { error: true });
    $("connect").disabled = false;
  }
}

// The apworld controls stay usable: choosing or removing one while tracking switches to it.
const LOCKED_WHILE_TRACKING = ["address", "slot", "password"];

async function startTracking() {
  const { entry } = pending;
  const yamlFile = $("yaml").files[0];
  if (entry.needsYaml && !yamlFile) {
    setStatus("down", `${pending.game} needs your player YAML before tracking can start.`, { error: true });
    return;
  }
  const fileEntry = async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  const yamls = yamlFile ? [await fileEntry(yamlFile)] : [];
  const packFile = $("pack").files[0];
  const pack = packFile ? await fileEntry(packFile) : null;

  resetView({ clearLog: true });
  ui.entry = entry;
  for (const id of LOCKED_WHILE_TRACKING) $(id).disabled = true;
  $("connect").textContent = "Disconnect";
  $("connect").disabled = false;
  ui.phase = "booting";
  setStatus("connecting", `Starting the tracker for ${pending.description}…`);

  // An uploaded apworld's worker is already running from the inspection.
  if (!worker) spawnWorker(pending.url).postMessage({ type: "boot", runtime: runtimeInfo(), entry });
  const session = worker;
  const { url, slot, password, checksums, game } = pending;
  document.title = `UT: ${slot}`;
  // Gathered while the worker boots.
  const datapackages = await gatherDatapackages({ url, checksums, game });
  if (worker !== session) return;
  const transfer = [...yamls, ...(pack ? [pack] : [])].map((file) => file.bytes.buffer);
  worker.postMessage({
    type: "start",
    yamls,
    pack,
    datapackages,
    connect: { address: url, slot, password },
  }, transfer);
  sendVisibility();
}

// The whole worker goes, so no Python state (loaded worlds, UT's generation, files) outlives the
// session. The log is kept so a failure can still be read; it is cleared when tracking starts again.
function stopTracking({ state = "idle", text = "Disconnected.", error = false } = {}) {
  discardWorker();
  pending = null;
  document.title = "Universal Tracker";
  resetView();
  for (const id of LOCKED_WHILE_TRACKING) $(id).disabled = false;
  $("connect").textContent = "Connect";
  $("connect").disabled = false;
  ui.phase = "ready";
  setStatus(state, text, { error });
}

function resetView({ clearLog = false } = {}) {
  for (const url of images.values()) URL.revokeObjectURL(url);
  images.clear();
  markerNodes.clear();
  markerBorder = 8;
  $("files").hidden = true;
  $("tracker-lines").replaceChildren();
  $("labels").replaceChildren();
  $("map-select").replaceChildren();
  $("current-map").textContent = "";
  $("map").replaceChildren();
  $("map").removeAttribute("viewBox");
  setMapTabShown(false);
  $("command").value = "";
  $("command").disabled = true;
  commandNames = null;
  hideSuggestions();
  Object.assign(ui, {
    entry: null, bootTimings: null, trackerLines: [], labels: {}, maps: [],
    markers: 0, markerUpdates: 0, mapImageLoaded: false, updates: [], error: null,
  });
  if (clearLog) {
    $("log-lines").replaceChildren();
    ui.logs = [];
  }
}

// The bridge decides reconnects, so it needs to know whether anyone is looking at the page.
function sendVisibility() {
  worker?.postMessage(JSON.stringify({ type: "visibility", visible: document.visibilityState === "visible" }));
}

// --- the map ------------------------------------------------------------------------------------

function svgElement(name, attributes, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent?.append(node);
  return node;
}

function drawMarkers(markers) {
  const svg = $("map");
  const layer = svg.querySelector("#markers") ?? svgElement("g", { id: "markers" }, svg);
  layer.replaceChildren();
  markerNodes.clear();
  for (const marker of markers) {
    const { x, y, size } = marker;
    const half = size / 2;
    const group = svgElement("g", marker.kind === "deferred" ? { transform: `rotate(45 ${x} ${y})` } : {}, layer);
    svgElement("rect", {
      x: x - half - markerBorder, y: y - half - markerBorder,
      width: size + 2 * markerBorder, height: size + 2 * markerBorder, fill: "#000",
    }, group);
    const title = svgElement("title", {}, group);
    const shapes = marker.kind === "split"
      ? [
          [x, y, x - half, y - half, x + half, y - half],
          [x, y, x + half, y - half, x + half, y + half],
          [x, y, x - half, y + half, x + half, y + half],
          [x, y, x - half, y - half, x - half, y + half],
        ].map((points) => svgElement("polygon", { points: points.join(" "), fill: "#DD00FF" }, group))
      : [svgElement("rect", { x: x - half, y: y - half, width: size, height: size, fill: "#DD00FF" }, group)];
    markerNodes.set(marker.id, { shapes, title });
  }
  ui.markers = markers.length;
}

function updateMarkers(updates) {
  for (const { id, colors, tooltip } of updates) {
    const node = markerNodes.get(id);
    if (!node) continue;
    // Quadrants are drawn top, right, bottom, left; UT's first color is its most important status.
    const order = node.shapes.length === 4 ? [1, 2, 0, 3] : [0];
    node.shapes.forEach((shape, i) => {
      shape.style.fill = colorValue(colors[order[i]] ?? colors[0]) ?? "#DD00FF";
    });
    node.title.textContent = tooltip;
  }
  ui.markerUpdates += updates.length;
}

function showMapImage(source) {
  const url = images.get(source);
  if (!url) return;
  const probeImage = new Image();
  probeImage.onload = () => {
    if (images.get(source) !== url) return;
    const svg = $("map");
    svg.setAttribute("viewBox", `0 0 ${probeImage.naturalWidth} ${probeImage.naturalHeight}`);
    const image = svg.querySelector("image") ?? svgElement("image", {});
    image.setAttribute("href", url);
    image.setAttribute("width", probeImage.naturalWidth);
    image.setAttribute("height", probeImage.naturalHeight);
    svg.prepend(image);
    ui.mapImageLoaded = true;
  };
  probeImage.src = url;
}

// --- messages from the tracker ------------------------------------------------------------------

function onWorkerMessage({ data }) {
  if (typeof data !== "string") {
    // Map image bytes arrive as a plain object so they skip JSON encoding.
    images.set(data.source, URL.createObjectURL(new Blob([data.bytes])));
    return;
  }
  const message = JSON.parse(data);
  switch (message.type) {
    case "ready":
      ui.phase = "tracking";
      ui.bootTimings = message.timings;
      $("command").disabled = false;
      break;
    case "names":
      commandNames = message;
      if (document.activeElement === $("command")) updateSuggestions();
      break;
    case "inspected":
      onInspected(message);
      break;
    case "fatal":
      stopTracking({ state: "down", text: "The tracker failed to start. See the Log view.", error: true });
      ui.phase = "failed";
      addLog("ERROR", { text: message.text });
      break;
    case "connection":
      setStatus(message.state, message.text);
      if (message.state === "up" && pending) {
        rememberSuccess({ address: pending.address, slot: pending.slot, password: pending.password ?? "", game: message.game ?? pending.game });
      }
      break;
    case "log":
      addLog(message.level, message);
      break;
    case "tracker":
      ui.trackerLines = message.lines;
      $("tracker-lines").replaceChildren(...message.lines.map((line) => {
        const li = document.createElement("li");
        renderMarkup(li, line);
        return li;
      }));
      applyTrackerFilter();
      break;
    case "label": {
      ui.labels[message.name] = message.text;
      let node = document.querySelector(`[data-label="${message.name}"]`);
      if (!node) {
        node = document.createElement("span");
        node.dataset.label = message.name;
        $("labels").append(node);
      }
      renderMarkup(node, message.text);
      break;
    }
    case "show_map":
      ui.maps = message.maps;
      $("map-select").replaceChildren(...message.maps.map((name) => new Option(name, name)));
      setMapTabShown(message.maps.length > 0);
      break;
    case "current_map":
      $("current-map").textContent = message.name;
      break;
    case "map_markers":
      markerBorder = message.border;
      drawMarkers(message.markers);
      break;
    case "marker_status":
      updateMarkers(message.updates);
      break;
    case "map_image":
      showMapImage(message.source);
      break;
    case "timing":
      ui.updates.push({ at: Date.now(), ...message });
      break;
  }
}

// --- wiring -------------------------------------------------------------------------------------

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.tab === name)));
  for (const tab of ["tracker", "map", "log"]) $(`tab-${tab}`).hidden = tab !== name;
  // A hidden list loses its scroll position, so the log reopens at its newest line.
  if (name === "log") $("log-lines").scrollTop = $("log-lines").scrollHeight;
}

// The Map tab exists only while UT has a map loaded, from the world or a pack.
function setMapTabShown(shown) {
  $("map-tab").hidden = !shown;
  if (!shown && !$("tab-map").hidden) showTab("tracker");
}

document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));

// Puna's filter semantics: a trimmed, case-insensitive substring of each line's rendered text, so what
// you can see is what you can search. Applied again whenever the tracker redraws its lines.
function applyTrackerFilter() {
  const needle = $("tracker-filter").value.trim().toLowerCase();
  for (const line of $("tracker-lines").children) {
    line.hidden = needle !== "" && !line.textContent.toLowerCase().includes(needle);
  }
}

$("tracker-filter").addEventListener("input", applyTrackerFilter);
// Not every browser clears a search field on Escape by itself.
$("tracker-filter").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !event.target.value) return;
  event.preventDefault();
  event.target.value = "";
  applyTrackerFilter();
});
$("address").addEventListener("focus", showAddress);
$("address").addEventListener("blur", showAddress);
// Registered before the shared listener below, which saves the fields.
$("address").addEventListener("input", (event) => {
  serverAddress = event.target.value;
});
$("streamer").checked = streamerMode;
$("streamer").addEventListener("change", (event) => {
  streamerMode = event.target.checked;
  store(STREAMER_KEY, streamerMode);
  showAddress();
  $("message").textContent = hidePorts(ui.connection.text);
  renderRecent();
  $("log-lines").replaceChildren(...ui.logs.map(logLine));
});
function showApworldChoice() {
  $("apworld-button").hidden = !uploadOffered || Boolean(apworldFile);
  $("apworld-choice").hidden = !apworldFile;
  $("apworld-name").textContent = apworldFile ? `Using ${apworldFile.name}` : "";
}

function offerUpload() {
  uploadOffered = true;
  showApworldChoice();
}

function withdrawUpload() {
  uploadOffered = false;
  apworldFile = null;
  showApworldChoice();
}

// Checks the room again with the current choice, leaving a running tracker first.
function recheckWithChoice() {
  if (isTracking()) stopTracking();
  else abandonCheckedRoom();
  onConnect();
}

$("apworld-button").addEventListener("click", () => $("apworld").click());
$("apworld").addEventListener("change", (event) => {
  apworldFile = event.target.files[0] ?? null;
  // Cleared so that choosing the same file again still counts as a change.
  event.target.value = "";
  showApworldChoice();
  if (apworldFile) recheckWithChoice();
});
$("apworld-clear").addEventListener("click", () => {
  apworldFile = null;
  showApworldChoice();
  // After a Disconnect there is nothing to switch back from, so removing only clears the choice.
  if (isTracking() || pending) recheckWithChoice();
});
$("connect-form").addEventListener("submit", onSubmit);
for (const id of ["address", "slot", "password"]) {
  $(id).addEventListener("input", () => {
    store(STORAGE_KEYS.fields, currentFields());
    abandonCheckedRoom();
    withdrawUpload();
  });
}
$("start").addEventListener("click", () => startTracking().catch((err) => setStatus("down", err.message, { error: true })));
$("map-select").addEventListener("change", (event) => worker?.postMessage(JSON.stringify({ type: "load_map", map: event.target.value })));
// --- name suggestions ---------------------------------------------------------------------------
// As in puna's moderation form: the game's own names, offered while a command that takes one is
// typed. The bridge sends the lists (see post_names in ui_bridge.py).

const NAME_COMMANDS = { "!hint": "hint_items", "!hint_location": "hint_locations", "!getitem": "items", "/explain": "explain" };
const SUGGESTIONS_MAX = 100;
let commandNames = null;
// navigated: a name was picked with the arrow keys, so Enter takes it instead of sending.
const suggesting = { command: "", matches: [], active: 0, navigated: false };

function hideSuggestions() {
  $("suggestions").hidden = true;
  $("command").setAttribute("aria-expanded", "false");
  $("command").removeAttribute("aria-activedescendant");
  suggesting.matches = [];
}

function updateSuggestions() {
  const typed = /^(\S+) (.*)$/s.exec($("command").value);
  const names = typed && commandNames?.[NAME_COMMANDS[typed[1].toLowerCase()]];
  if (!names) return hideSuggestions();
  const query = typed[2].trim().toLowerCase();
  // Names that start with what was typed come first, then names that contain it.
  const starting = [];
  const containing = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(query)) starting.push(name);
    else if (lower.includes(query)) containing.push(name);
  }
  const matches = [...starting, ...containing].slice(0, SUGGESTIONS_MAX);
  if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === query)) return hideSuggestions();

  Object.assign(suggesting, { command: typed[1], matches, navigated: false });
  $("suggestions").replaceChildren(...matches.map((name, index) => {
    const option = document.createElement("li");
    option.id = `suggestion-${index}`;
    option.setAttribute("role", "option");
    option.textContent = name;
    // mousedown rather than click, so the box keeps focus and doesn't close the list first.
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      completeSuggestion(index);
    });
    return option;
  }));
  $("suggestions").hidden = false;
  $("command").setAttribute("aria-expanded", "true");
  highlightSuggestion(0);
}

function highlightSuggestion(index) {
  const options = [...$("suggestions").children];
  suggesting.active = (index + options.length) % options.length;
  options.forEach((option, i) => option.setAttribute("aria-selected", String(i === suggesting.active)));
  $("command").setAttribute("aria-activedescendant", options[suggesting.active].id);
  options[suggesting.active].scrollIntoView({ block: "nearest" });
}

function completeSuggestion(index = suggesting.active) {
  $("command").value = `${suggesting.command} ${suggesting.matches[index]}`;
  hideSuggestions();
}

$("command").addEventListener("input", updateSuggestions);
$("command").addEventListener("blur", hideSuggestions);
$("command").addEventListener("keydown", (event) => {
  if (!$("suggestions").hidden) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      return completeSuggestion();
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      suggesting.navigated = true;
      return highlightSuggestion(suggesting.active + (event.key === "ArrowDown" ? 1 : -1));
    }
    if (event.key === "Escape") {
      event.preventDefault();
      return hideSuggestions();
    }
    if (event.key === "Enter" && suggesting.navigated) {
      event.preventDefault();
      return completeSuggestion();
    }
  }
  if (event.key !== "Enter" || !event.target.value) return;
  hideSuggestions();
  // Replies and chat only appear in the log.
  showTab("log");
  worker?.postMessage(JSON.stringify({ type: "command", text: event.target.value }));
  event.target.value = "";
});

// Menus open under their buttons: Recent from its left edge, settings from its right edge.
function placeMenu(menuId, buttonId, align) {
  $(menuId).addEventListener("toggle", (event) => {
    if (event.newState !== "open") return;
    const anchor = $(buttonId).getBoundingClientRect();
    const menu = $(menuId);
    const left = align === "right" ? anchor.right - menu.offsetWidth : anchor.left;
    menu.style.top = `${anchor.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8))}px`;
  });
}
placeMenu("recent", "recent-button", "left");
placeMenu("settings", "settings-button", "right");
$("recent-clear").addEventListener("click", () => {
  store(STORAGE_KEYS.recent, []);
  renderRecent();
  $("recent").hidePopover();
});

document.addEventListener("visibilitychange", sendVisibility);
window.addEventListener("online", () => worker?.postMessage(JSON.stringify({ type: "online" })));

// Server and slot may come from the query string (never the password), and otherwise from last time.
const params = new URLSearchParams(location.search);
fillFields(loadStored(STORAGE_KEYS.fields, {}));
if (params.has("slot")) $("slot").value = params.get("slot");
if (params.has("address")) {
  serverAddress = params.get("address");
  showAddress();
}
renderRecent();

try {
  const response = await fetch("/catalog.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  catalog = await response.json();
  $("version").textContent +=
    `, Archipelago ${catalog.archipelagoVersion}, Universal Tracker ${catalog.tracker.version}, Pyodide ${catalog.pyodide.version}`;
  ui.phase = "ready";
  setStatus("idle", `Ready: ${Object.keys(catalog.games).length} games available for Archipelago ${catalog.archipelagoVersion}.`);
  $("connect").disabled = false;
} catch {
  setStatus("down", "The tracker catalog isn't available yet. Try again in a few minutes.", { error: true });
}
