// Switching check: track one slot, disconnect, track a slot of another game, and confirm nothing from
// the first session is left in the page.
// Usage: node switch.mjs <base url> <room address> <map slot> <pack file> <yaml slot> <yaml file> [--insecure]
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const insecure = args.includes("--insecure");
const [base, address, mapSlot, packFile, yamlSlot, yamlFile] = args.filter((arg) => arg !== "--insecure");
if (!yamlFile) {
  console.error("usage: node switch.mjs <base url> <room address> <map slot> <pack file> <yaml slot> <yaml file> [--insecure]");
  process.exit(2);
}

const started = Date.now();
const say = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);
const check = (ok, description) => {
  if (!ok) throw new Error(`check failed: ${description}`);
  say(`ok: ${description}`);
};

const browser = await puppeteer.launch({
  browser: "chrome",
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  args: insecure ? ["--ignore-certificate-errors"] : [],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));

  const state = () => page.evaluate(() => {
    const s = window.kalapanaState;
    return {
      phase: s.phase, connection: s.connection, module: s.entry?.module ?? null, error: s.error,
      trackerLines: s.trackerLines.length, labels: s.labels, maps: s.maps.length, markers: s.markers,
      logs: s.logs.map((line) => line.text),
      svgChildren: document.getElementById("map").childElementCount,
      button: document.getElementById("connect").textContent,
      fieldsDisabled: document.getElementById("slot").disabled,
      yamlChosen: document.getElementById("yaml").files.length,
    };
  });
  const setSlot = async (slot) => {
    await page.$eval("#slot", (input) => { input.value = ""; });
    await page.type("#slot", slot);
  };
  const track = async (slot, uploads) => {
    await setSlot(slot);
    await page.click("#connect");
    await page.waitForFunction(() => ["files", "booting", "tracking"].includes(window.kalapanaState.phase) || window.kalapanaState.error, { timeout: 60_000 });
    for (const [selector, file] of uploads) await (await page.$(selector)).uploadFile(file);
    if (await page.evaluate(() => window.kalapanaState.phase === "files")) await page.click("#start");
    await page.waitForFunction(
      () => window.kalapanaState.connection.state === "up" && window.kalapanaState.trackerLines.length > 0 || window.kalapanaState.error,
      { timeout: 240_000 },
    );
    const s = await state();
    if (s.error) throw new Error(s.error);
    say(`tracking ${slot}: ${s.module}, ${s.trackerLines} lines, ${s.labels.tracker_logic_locs_label}, ${s.maps} maps`);
    return s;
  };
  const disconnect = async () => {
    await page.click("#connect");
    const s = await state();
    check(s.phase === "ready" && s.connection.state === "idle", "disconnect returns to ready");
    check(s.button === "Connect" && !s.fieldsDisabled, "button reads Connect and fields are editable");
    check(s.trackerLines === 0 && s.maps === 0 && s.markers === 0 && s.svgChildren === 0 && Object.keys(s.labels).length === 0, "tracker, labels and map are cleared");
    return s;
  };

  await page.goto(`${base}/?${new URLSearchParams({ address, slot: mapSlot })}`);
  await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });

  const first = await track(mapSlot, [["#pack", packFile]]);
  check(first.button === "Disconnect" && first.fieldsDisabled, "button reads Disconnect while tracking");
  check(first.maps > 0, "first game has a map");
  await disconnect();

  // A checked room waiting for files is dropped when the details change.
  await setSlot(mapSlot);
  await page.click("#connect");
  await page.waitForFunction(() => window.kalapanaState.phase === "files", { timeout: 60_000 });
  await setSlot(yamlSlot);
  check((await state()).phase === "ready", "editing the slot abandons the checked room");

  const second = await track(yamlSlot, [["#yaml", yamlFile]]);
  check(second.module !== first.module, "second session loaded a different world");
  check(second.maps === 0 && second.svgChildren === 0, "no map carried over");
  check(!second.logs.some((text) => text.includes(mapSlot)), "log starts fresh");
  await disconnect();

  // Back to the first game with no pack: the earlier pack must not be reused.
  await setSlot(mapSlot);
  await page.click("#connect");
  await page.waitForFunction(() => window.kalapanaState.phase === "files", { timeout: 60_000 });
  check((await state()).yamlChosen === 0, "files from the previous room are not preselected");
  const third = await track(mapSlot, []);
  check(third.module === first.module && third.trackerLines === first.trackerLines, "first game tracks the same as before");
  check(third.maps === 0, "no map without a pack this time");
  await disconnect();
} catch (err) {
  say("FAILED:", err.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
