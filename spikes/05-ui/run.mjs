// Spike 5 driver: boot the bridge page, connect to a server, and screenshot the tracker and map tabs.
// Usage: node run.mjs <chrome|firefox> <screenshot dir> [port]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BROWSERS = {
  chrome: { browser: "chrome", executablePath: "/usr/bin/google-chrome-stable" },
  firefox: { browser: "firefox", executablePath: "/usr/bin/firefox-bin" },
};

const [browserName, shotDir, port = "8123"] = process.argv.slice(2);
if (!BROWSERS[browserName] || !shotDir) {
  console.error("usage: node run.mjs <chrome|firefox> <screenshot dir> [port]");
  process.exit(2);
}
await mkdir(shotDir, { recursive: true });

const browser = await puppeteer.launch({ ...BROWSERS[browserName], headless: true, protocolTimeout: 300_000 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  await page.goto(`http://localhost:${port}/05-ui/index.html?world=tunic&autostart=1`);

  const started = Date.now();
  await page.waitForFunction(() => window.spikeState.ready || window.spikeState.fatal, { timeout: 300_000 });
  const boot = await page.evaluate(() => ({ timings: window.spikeState.timings, fatal: window.spikeState.fatal }));
  console.log("boot:", JSON.stringify(boot));
  if (boot.fatal) process.exit(1);

  const connectAt = Date.now();
  await page.click("#connect");
  await page.waitForFunction(() => window.spikeState.trackerLines.length > 10, { timeout: 120_000 });
  console.log(`tracker populated ${((Date.now() - connectAt) / 1000).toFixed(2)}s after connect`);
  await page.screenshot({ path: `${shotDir}/${browserName}-tracker.png` });

  await page.click('nav button[data-tab="map"]');
  const mapState = await page.evaluate(() => ({ maps: window.spikeState.maps, markers: window.spikeState.markers }));
  if (!mapState.markers && mapState.maps.length) {
    await page.select("#map-select", mapState.maps[0]);
  }
  await page.waitForFunction(() => window.spikeState.mapImageLoaded && window.spikeState.markerUpdates > 0, { timeout: 120_000 });
  await page.screenshot({ path: `${shotDir}/${browserName}-map.png` });

  const summary = await page.evaluate(() => ({
    trackerLines: window.spikeState.trackerLines.length,
    labels: window.spikeState.labels,
    maps: window.spikeState.maps.length,
    markers: window.spikeState.markers,
    markerUpdates: window.spikeState.markerUpdates,
    errors: window.spikeState.logs.filter((l) => l.level === "ERROR").map((l) => l.text.slice(0, 300)),
  }));
  console.log("summary:", JSON.stringify(summary, null, 2));
  console.log(`total ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await browser.close();
}
