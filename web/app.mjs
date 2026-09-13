// Page logic: find the room's game and matching world bundle, collect any files the world needs,
// then run the tracker in a worker and render what it reports.
const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

// Exposed for automated tests.
const state = (window.kalapanaState = {
  phase: "loading",
  entry: null,
  bootTimings: null,
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

function setStatus(text, { error = false } = {}) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
  if (error) state.error = text;
}

function unescapeMarkup(text) {
  return text.replaceAll("&bl;", "[").replaceAll("&br;", "]").replaceAll("&amp;", "&");
}

// Renders Kivy-style [color=hex]...[/color] markup; other markup tags are dropped.
function renderMarkup(target, text) {
  target.replaceChildren();
  const pattern = /\[color=#?([0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(unescapeMarkup(text.slice(last, match.index)));
    const span = document.createElement("span");
    span.style.color = `#${match[1]}`;
    span.textContent = unescapeMarkup(match[2]);
    target.append(span);
    last = match.index + match[0].length;
  }
  target.append(unescapeMarkup(text.slice(last)));
}

function addLog(level, { text, markup }) {
  state.logs.push({ level, text: text ?? unescapeMarkup(markup.replace(/\[\/?color[^\]]*\]/g, "")) });
  const li = document.createElement("li");
  li.className = level;
  if (markup !== undefined) renderMarkup(li, markup);
  else li.textContent = text;
  $("log-lines").append(li);
}

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

async function onConnect(event) {
  event.preventDefault();
  const address = $("address").value.trim();
  const slot = $("slot").value.trim();
  const password = $("password").value || null;
  $("connect").disabled = true;
  setStatus(`Checking ${address}…`);
  try {
    const { url, roomInfo, game } = await probe(address, slot, password);
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

    pending = { url, slot, password, game, entry };
    state.entry = entry;
    const sameData = matches.length > 1 ? ` (${matches.length} versions share this datapackage; using the newest)` : "";
    if (entry.needsYaml || entry.map?.externalPack) {
      $("yaml-field").hidden = !entry.needsYaml;
      $("pack-field").hidden = !entry.map?.externalPack;
      $("files").hidden = false;
      const asks = [entry.needsYaml && "your player YAML", entry.map?.externalPack && "optionally its poptracker pack for the map"].filter(Boolean);
      setStatus(`${game} ${entry.version}${sameData}. Add ${asks.join(" and ")}, then start tracking.`);
      state.phase = "files";
      return;
    }
    setStatus(`${game} ${entry.version}${sameData}.`);
    await startTracking();
  } catch (err) {
    setStatus(err.message, { error: true });
    $("connect").disabled = false;
  }
}

async function startTracking() {
  const { entry } = pending;
  const yamlFile = $("yaml").files[0];
  if (entry.needsYaml && !yamlFile) {
    setStatus(`${pending.game} needs your player YAML before tracking can start.`, { error: true });
    return;
  }
  const fileEntry = async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  const yamls = yamlFile ? [await fileEntry(yamlFile)] : [];
  const packFile = $("pack").files[0];
  const pack = packFile ? await fileEntry(packFile) : null;

  $("files").hidden = true;
  for (const id of ["address", "slot", "password"]) $(id).disabled = true;
  state.phase = "booting";
  setStatus(`Starting the tracker for ${pending.game} ${entry.version}…`);

  worker = new Worker("worker.mjs", { type: "module" });
  worker.onmessage = onWorkerMessage;
  const transfer = [...yamls, ...(pack ? [pack] : [])].map((file) => file.bytes.buffer);
  worker.postMessage({
    type: "boot",
    runtime: { pyodide: catalog.pyodide, core: catalog.core, tracker: catalog.tracker },
    entry,
    yamls,
    pack,
    connect: { address: pending.url, slot: pending.slot, password: pending.password },
  }, transfer);
}

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
  state.markers = markers.length;
}

function updateMarkers(updates) {
  for (const { id, colors, tooltip } of updates) {
    const node = markerNodes.get(id);
    if (!node) continue;
    // Quadrants are drawn top, right, bottom, left; UT's first color is its most important status.
    const order = node.shapes.length === 4 ? [1, 2, 0, 3] : [0];
    node.shapes.forEach((shape, i) => shape.setAttribute("fill", `#${colors[order[i]] ?? colors[0]}`));
    node.title.textContent = tooltip;
  }
  state.markerUpdates += updates.length;
}

function showMapImage(source) {
  const url = images.get(source);
  if (!url) return;
  const probeImage = new Image();
  probeImage.onload = () => {
    const svg = $("map");
    svg.setAttribute("viewBox", `0 0 ${probeImage.naturalWidth} ${probeImage.naturalHeight}`);
    const image = svg.querySelector("image") ?? svgElement("image", {});
    image.setAttribute("href", url);
    image.setAttribute("width", probeImage.naturalWidth);
    image.setAttribute("height", probeImage.naturalHeight);
    svg.prepend(image);
    state.mapImageLoaded = true;
  };
  probeImage.src = url;
}

function onWorkerMessage({ data }) {
  if (typeof data !== "string") {
    // Map image bytes arrive as a plain object so they skip JSON encoding.
    images.set(data.source, URL.createObjectURL(new Blob([data.bytes])));
    return;
  }
  const message = JSON.parse(data);
  switch (message.type) {
    case "ready":
      state.phase = "tracking";
      state.bootTimings = message.timings;
      setStatus(`Tracking ${pending.game} as ${pending.slot}. Started in ${Object.values(message.timings).reduce((a, b) => a + b, 0).toFixed(1)}s.`);
      $("command").disabled = false;
      break;
    case "fatal":
      state.phase = "failed";
      setStatus("The tracker failed to start. See the Log tab.", { error: true });
      addLog("ERROR", { text: message.text });
      break;
    case "log":
      addLog(message.level, message);
      break;
    case "tracker":
      state.trackerLines = message.lines;
      $("tracker-lines").replaceChildren(...message.lines.map((line) => {
        const li = document.createElement("li");
        renderMarkup(li, line);
        return li;
      }));
      break;
    case "label": {
      state.labels[message.name] = message.text;
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
      state.maps = message.maps;
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
      state.updates.push({ at: Date.now(), ...message });
      break;
  }
}

document.querySelectorAll("nav button").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((other) => other.setAttribute("aria-selected", other === button));
    for (const tab of ["tracker", "map", "log"]) $(`tab-${tab}`).hidden = tab !== button.dataset.tab;
  }),
);
$("connect-form").addEventListener("submit", onConnect);
$("start").addEventListener("click", () => startTracking().catch((err) => setStatus(err.message, { error: true })));
$("map-select").addEventListener("change", (event) => worker?.postMessage(JSON.stringify({ type: "load_map", map: event.target.value })));
$("command").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.value) return;
  worker?.postMessage(JSON.stringify({ type: "command", text: event.target.value }));
  event.target.value = "";
});

// Server and slot may be prefilled from the query string; never the password.
const params = new URLSearchParams(location.search);
for (const field of ["address", "slot"]) if (params.has(field)) $(field).value = params.get(field);

try {
  const response = await fetch("/catalog.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  catalog = await response.json();
  state.phase = "ready";
  setStatus(`Ready: ${Object.keys(catalog.games).length} games available for Archipelago ${catalog.archipelagoVersion}.`);
  $("connect").disabled = false;
} catch {
  setStatus("The tracker catalog isn't available yet. Try again in a few minutes.", { error: true });
}
