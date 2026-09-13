// Live-play driver: connect the bridge page to a server and log every change for a while.
// Usage: node watch.mjs <address> <slot> <seconds> <screenshot dir> [port]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const [address, slot, seconds, shotDir, port = "8123"] = process.argv.slice(2);
if (!shotDir) {
  console.error("usage: node watch.mjs <address> <slot> <seconds> <screenshot dir> [port]");
  process.exit(2);
}
await mkdir(shotDir, { recursive: true });

const started = Date.now();
const stamp = () => `[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`;
const say = (...parts) => console.log(stamp(), ...parts);

const browser = await puppeteer.launch({
  browser: "chrome",
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  protocolTimeout: 300_000,
});

async function screenshots(page, label) {
  for (const tab of ["tracker", "map"]) {
    await page.click(`nav button[data-tab="${tab}"]`);
    await page.screenshot({ path: `${shotDir}/live-${label}-${tab}.png` });
  }
  say(`screenshots saved: live-${label}-*.png`);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));
  await page.goto(`http://localhost:${port}/05-ui/index.html?world=tunic&autostart=1`);

  await page.waitForFunction(() => window.spikeState.ready || window.spikeState.fatal, { timeout: 300_000 });
  say("boot:", JSON.stringify(await page.evaluate(() => window.spikeState.timings)));

  await page.$eval("#address", (el, value) => { el.value = value; }, address);
  await page.$eval("#slot", (el, value) => { el.value = value; }, slot);
  const connectAt = Date.now();
  await page.click("#connect");
  await page.waitForFunction(() => window.spikeState.trackerLines.length > 0, { timeout: 120_000 });
  say(`tracker populated ${((Date.now() - connectAt) / 1000).toFixed(2)}s after connect`);

  const snapshot = () => page.evaluate(() => ({
    labels: { ...window.spikeState.labels },
    lines: window.spikeState.trackerLines.length,
    markerUpdates: window.spikeState.markerUpdates,
    updates: window.spikeState.updates.length,
    logs: window.spikeState.logs.length,
  }));

  let previous = await snapshot();
  let seenUpdates = 0;
  let seenLogs = 0;
  let changes = 0;
  const plain = (text) => text.replace(/\[\/?color[^\]]*\]/g, "");

  const deadline = started + Number(seconds) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = await snapshot();

    const newLogs = await page.evaluate((from) => window.spikeState.logs.slice(from), seenLogs);
    seenLogs += newLogs.length;
    for (const log of newLogs) say(`log ${log.level}: ${log.text.split("\n")[0].slice(0, 200)}`);

    const newUpdates = await page.evaluate((from) => window.spikeState.updates.slice(from), seenUpdates);
    seenUpdates += newUpdates.length;
    for (const u of newUpdates) {
      say(`tracker update: logic ${(u.logic * 1000).toFixed(0)}ms, total ${(u.total * 1000).toFixed(0)}ms, items ${u.items}, checked ${u.checked}`);
    }

    const changedLabels = Object.entries(current.labels).filter(([name, text]) => previous.labels[name] !== text);
    if (changedLabels.length || current.lines !== previous.lines || current.markerUpdates !== previous.markerUpdates) {
      changes += 1;
      say(`state: ${Object.values(current.labels).map(plain).join(" | ")} | lines ${current.lines} | marker updates +${current.markerUpdates - previous.markerUpdates}`);
      if (changes === 1) await screenshots(page, "first-change");
    }
    previous = current;
  }

  await screenshots(page, "final");
  say("watch finished");
} finally {
  await browser.close();
}
