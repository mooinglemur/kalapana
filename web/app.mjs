// Page logic: find the room's game and matching world bundle, collect any files the world needs,
// run the tracker in a worker, and render what it reports.
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
  return { address: $("address").value.trim(), slot: $("slot").value.trim(), password: $("password").value };
}

function fillFields({ address = "", slot = "", password = "" }) {
  $("address").value = address;
  $("slot").value = slot;
  $("password").value = password;
  store(STORAGE_KEYS.fields, currentFields());
}

function rememberSuccess(entry) {
  const sameCombination = (a) => a.address === entry.address && a.slot === entry.slot && (a.password ?? "") === (entry.password ?? "");
  const recent = loadStored(STORAGE_KEYS.recent, []).filter((item) => !sameCombination(item));
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
    title.textContent = `${entry.slot} on ${entry.address}`;
    const detail = document.createElement("span");
    detail.className = "hint";
    detail.textContent = [entry.game, ago(entry.at)].filter(Boolean).join(" · ");
    button.append(title, detail);
    button.addEventListener("click", () => {
      fillFields(entry);
      abandonCheckedRoom();
      $("recent").hidePopover();
    });
    const li = document.createElement("li");
    li.append(button);
    return li;
  }));
}

// --- the status line ----------------------------------------------------------------------------
// The dot and the sentence always change together. state: "idle" (muted), "connecting", "up", "down".

function setStatus(state, text, { error = false } = {}) {
  ui.connection = { state, text };
  if (error) ui.error = text;
  $("link").className = state === "up" ? "link-state up" : state === "down" ? "link-state down" : "link-state";
  $("status").className = state === "down" ? "warning status" : "notice status";
  $("message").textContent = text;
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

function addLog(level, { text, markup }) {
  ui.logs.push({ level, text: text ?? unescapeMarkup(markup.replace(/\[\/?color[^\]]*\]/g, "")) });
  const lines = $("log-lines");
  const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 40;
  const li = document.createElement("li");
  li.className = level;
  if (markup !== undefined) renderMarkup(li, markup);
  else li.textContent = text;
  lines.append(li);
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

// One button: Connect when idle, Disconnect while a tracker is running (including while it retries).
function onSubmit(event) {
  event.preventDefault();
  if (worker) stopTracking();
  else onConnect();
}

// A checked room waiting for its files no longer applies once the details change.
function abandonCheckedRoom() {
  if (ui.phase !== "files") return;
  pending = null;
  ui.entry = null;
  ui.phase = "ready";
  $("files").hidden = true;
  setStatus("idle", "The connection details changed. Connect again to check them.");
}

async function onConnect() {
  const { address, slot, password } = currentFields();
  store(STORAGE_KEYS.fields, currentFields());
  $("connect").disabled = true;
  // Files picked for an earlier room may belong to a different game.
  pending = null;
  $("files").hidden = true;
  $("yaml").value = "";
  $("pack").value = "";
  setStatus("connecting", `Checking ${address}…`);
  try {
    const { url, roomInfo, game } = await probe(address, slot, password || null);
    const checksum = roomInfo.datapackage_checksums?.[game];
    const candidates = catalog.games[game] ?? [];
    if (!candidates.length) throw new Error(`${game} isn't in the tracker catalog.`);
    const matches = candidates.filter((candidate) => candidate.checksum === checksum);
    if (!matches.length) {
      const known = candidates.map((candidate) => candidate.version).join(", ");
      throw new Error(`No ${game} version in the catalog matches this room's datapackage (${String(checksum).slice(0, 12)}…). Known versions: ${known}.`);
    }
    const entry = matches[0];
    if (entry.disableUt) throw new Error(`The author of ${game} has asked Universal Tracker not to track it.`);

    pending = { url, address, slot, password: password || null, game, entry };
    ui.entry = entry;
    const sameData = matches.length > 1 ? ` (${matches.length} versions share this datapackage; using the newest)` : "";
    if (entry.needsYaml || entry.map?.externalPack) {
      $("yaml-field").hidden = !entry.needsYaml;
      $("pack-field").hidden = !entry.map?.externalPack;
      $("files").hidden = false;
      const asks = [entry.needsYaml && "your player YAML", entry.map?.externalPack && "optionally its poptracker pack for the map"].filter(Boolean);
      setStatus("idle", `${game} ${entry.version}${sameData}. Add ${asks.join(" and ")}, then start tracking.`);
      ui.phase = "files";
      $("connect").disabled = false;
      return;
    }
    await startTracking();
  } catch (err) {
    setStatus("down", err.message, { error: true });
    $("connect").disabled = false;
  }
}

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
  for (const id of ["address", "slot", "password"]) $(id).disabled = true;
  $("recent-button").disabled = true;
  $("connect").textContent = "Disconnect";
  $("connect").disabled = false;
  ui.phase = "booting";
  setStatus("connecting", `Starting the tracker for ${pending.game} ${entry.version}…`);

  const started = new Worker("worker.mjs", { type: "module" });
  worker = started;
  // Messages a stopped worker queued before it was terminated are dropped.
  started.onmessage = (event) => worker === started && onWorkerMessage(event);
  const transfer = [...yamls, ...(pack ? [pack] : [])].map((file) => file.bytes.buffer);
  worker.postMessage({
    type: "boot",
    runtime: { pyodide: catalog.pyodide, core: catalog.core, tracker: catalog.tracker },
    entry,
    yamls,
    pack,
    connect: { address: pending.url, slot: pending.slot, password: pending.password },
  }, transfer);
  sendVisibility();
}

// The whole worker goes, so no Python state (loaded worlds, UT's generation, files) outlives the
// session. The log is kept so a failure can still be read; it is cleared when tracking starts again.
function stopTracking({ state = "idle", text = "Disconnected.", error = false } = {}) {
  worker?.terminate();
  worker = null;
  pending = null;
  resetView();
  for (const id of ["address", "slot", "password"]) $(id).disabled = false;
  $("recent-button").disabled = false;
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
  $("command").value = "";
  $("command").disabled = true;
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

document.querySelectorAll(".tabs button").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    for (const tab of ["tracker", "map", "log"]) $(`tab-${tab}`).hidden = tab !== button.dataset.tab;
  }),
);
$("connect-form").addEventListener("submit", onSubmit);
for (const id of ["address", "slot", "password"]) {
  $(id).addEventListener("input", () => {
    store(STORAGE_KEYS.fields, currentFields());
    abandonCheckedRoom();
  });
}
$("start").addEventListener("click", () => startTracking().catch((err) => setStatus("down", err.message, { error: true })));
$("map-select").addEventListener("change", (event) => worker?.postMessage(JSON.stringify({ type: "load_map", map: event.target.value })));
$("command").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.value) return;
  worker?.postMessage(JSON.stringify({ type: "command", text: event.target.value }));
  event.target.value = "";
});

$("recent").addEventListener("toggle", (event) => {
  if (event.newState !== "open") return;
  const anchor = $("recent-button").getBoundingClientRect();
  const menu = $("recent");
  menu.style.top = `${anchor.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8))}px`;
});
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
for (const field of ["address", "slot"]) if (params.has(field)) $(field).value = params.get(field);
renderRecent();

try {
  const response = await fetch("/catalog.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  catalog = await response.json();
  ui.phase = "ready";
  setStatus("idle", `Ready: ${Object.keys(catalog.games).length} games available for Archipelago ${catalog.archipelagoVersion}.`);
  $("connect").disabled = false;
} catch {
  setStatus("down", "The tracker catalog isn't available yet. Try again in a few minutes.", { error: true });
}
