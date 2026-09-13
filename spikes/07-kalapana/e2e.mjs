// End-to-end check of a running kalapana server in headless Chrome.
// Usage: node e2e.mjs <base url> <room address> <slot> <screenshot dir> [--yaml file] [--pack file] [--explain text]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const positional = [];
const options = {};
// Flags without a value; --insecure accepts a self-signed certificate on a local wss:// test server.
const BOOLEAN_OPTIONS = new Set(["insecure"]);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) positional.push(argv[i]);
  else if (BOOLEAN_OPTIONS.has(argv[i].slice(2))) options[argv[i].slice(2)] = true;
  else options[argv[i].slice(2)] = argv[++i];
}
const [base, address, slot, shotDir] = positional;
if (!shotDir) {
  console.error("usage: node e2e.mjs <base url> <room address> <slot> <screenshot dir> [--yaml file] [--pack file] [--explain text]");
  process.exit(2);
}
await mkdir(shotDir, { recursive: true });

const started = Date.now();
const say = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);

const browser = await puppeteer.launch({
  browser: "chrome",
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  protocolTimeout: 300_000,
  args: options.insecure ? ["--ignore-certificate-errors"] : [],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));
  page.on("console", (msg) => msg.type() === "error" && say(`[console error] ${msg.text()}`));

  const query = new URLSearchParams({ address, slot });
  await page.goto(`${base}/?${query}`);
  const phase = (wanted, timeout) =>
    page.waitForFunction((list) => list.includes(window.kalapanaState.phase) || window.kalapanaState.error, { timeout }, wanted);

  await phase(["ready"], 30_000);
  say("status:", await page.$eval("#message", (el) => el.textContent));

  await page.click("#connect");
  await phase(["files", "booting", "tracking", "failed"], 60_000);
  let current = await page.evaluate(() => ({ phase: window.kalapanaState.phase, entry: window.kalapanaState.entry, error: window.kalapanaState.error }));
  say("after probe:", JSON.stringify(current));
  if (current.error) throw new Error(current.error);

  if (current.phase === "files") {
    if (options.yaml) await (await page.$("#yaml")).uploadFile(options.yaml);
    if (options.pack) await (await page.$("#pack")).uploadFile(options.pack);
    await page.click("#start");
  }

  await page.waitForFunction(
    () => (window.kalapanaState.phase === "tracking" && window.kalapanaState.trackerLines.length > 0) || ["failed"].includes(window.kalapanaState.phase) || window.kalapanaState.error,
    { timeout: 240_000 },
  );
  current = await page.evaluate(() => ({ phase: window.kalapanaState.phase, error: window.kalapanaState.error, bootTimings: window.kalapanaState.bootTimings }));
  say("tracking:", JSON.stringify(current));
  if (current.phase !== "tracking") throw new Error(current.error ?? "tracker failed to start");
  await page.waitForFunction(() => window.kalapanaState.connection?.state === "up", { timeout: 60_000 });
  await page.screenshot({ path: `${shotDir}/${slot}-tracker.png` });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.screenshot({ path: `${shotDir}/${slot}-tracker-dark.png` });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

  const maps = await page.evaluate(() => window.kalapanaState.maps.length);
  if (maps) {
    await page.click('.tabs button[data-tab="map"]');
    await page.waitForFunction(() => window.kalapanaState.mapImageLoaded && window.kalapanaState.markerUpdates > 0, { timeout: 120_000 });
    await page.screenshot({ path: `${shotDir}/${slot}-map.png` });
    say(`map rendered: ${maps} maps`);
  }

  if (options.explain) {
    const before = await page.evaluate(() => window.kalapanaState.logs.length);
    await page.type("#command", options.explain);
    await page.keyboard.press("Enter");
    await page.waitForFunction((count) => window.kalapanaState.logs.length > count, { timeout: 30_000 }, before);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const lines = await page.evaluate((count) => window.kalapanaState.logs.slice(count), before);
    say(`${options.explain} ->`);
    for (const line of lines) say(`  ${line.level}: ${line.text.split("\n").slice(-1)[0].slice(0, 160)}`);
    await page.click('.tabs button[data-tab="log"]');
    await page.screenshot({ path: `${shotDir}/${slot}-log.png` });
  }

  const summary = await page.evaluate(() => ({
    entry: window.kalapanaState.entry,
    labels: window.kalapanaState.labels,
    trackerLines: window.kalapanaState.trackerLines.length,
    updates: window.kalapanaState.updates.map((u) => u.logic),
    errors: window.kalapanaState.logs.filter((l) => l.level === "ERROR").map((l) => l.text.slice(0, 300)),
    ansiInLog: window.kalapanaState.logs.some((l) => l.text.includes("[")),
  }));
  say("summary:", JSON.stringify(summary, null, 2));
} catch (err) {
  say("FAILED:", err.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
