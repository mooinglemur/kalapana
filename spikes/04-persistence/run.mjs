// Spike 4 driver: write files in one browser session, quit the browser, verify them in a fresh session.
// Usage: node run.mjs <chrome|firefox> <profile dir> [port]
import puppeteer from "puppeteer-core";
import { rm } from "node:fs/promises";

const BROWSERS = {
  chrome: { browser: "chrome", executablePath: "/usr/bin/google-chrome-stable" },
  firefox: { browser: "firefox", executablePath: "/usr/bin/firefox-bin" },
};

const [browserName, profileDir, port = "8123"] = process.argv.slice(2);
if (!BROWSERS[browserName] || !profileDir) {
  console.error("usage: node run.mjs <chrome|firefox> <profile dir> [port]");
  process.exit(2);
}

await rm(profileDir, { recursive: true, force: true });

for (const phase of ["write", "verify"]) {
  const browser = await puppeteer.launch({ ...BROWSERS[browserName], headless: true, userDataDir: profileDir, protocolTimeout: 300_000 });
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log(`[${browserName} ${phase}] ${msg.text()}`));
    await page.goto(`http://localhost:${port}/04-persistence/index.html?phase=${phase}`);
    const result = await page.evaluate(() => window.spikeResult);
    if (result.type === "error") {
      // Keep only the Python part of the traceback; the JS frames that follow are Pyodide internals.
      console.log(`[${browserName} ${phase}] error:\n${result.message.split(/\n\s*at |\nR@/)[0]}`);
    } else {
      console.log(`[${browserName} ${phase}] result:`, JSON.stringify(result.result, null, 2));
    }
  } finally {
    await browser.close();
  }
}
