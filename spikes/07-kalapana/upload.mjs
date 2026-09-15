// Uploaded apworld check. The page offers "Use my apworld" once Connect has checked the room, whether or
// not the catalog matches. The given apworld is then chosen, which checks the room again with it, leaving
// a tracker already running on the catalog's version. With --expect-catalog, the first check must pick
// the catalog's version.
// Usage: node upload.mjs <base url> <room address> <slot> <apworld|-> <screenshot dir>
//          [--yaml file] [--pack file] [--expect-fail text] [--expect-catalog] [--insecure]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";

const BOOLEAN_OPTIONS = new Set(["insecure", "expect-catalog"]);
const positional = [];
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) positional.push(argv[i]);
  else if (BOOLEAN_OPTIONS.has(argv[i].slice(2))) options[argv[i].slice(2)] = true;
  else options[argv[i].slice(2)] = argv[++i];
}
const [base, address, slot, apworld, shotDir] = positional;
if (!shotDir) {
  console.error("usage: node upload.mjs <base url> <room address> <slot> <apworld|-> <screenshot dir> [--yaml file] [--pack file] [--expect-fail text] [--expect-catalog] [--insecure]");
  process.exit(2);
}
await mkdir(shotDir, { recursive: true });
const label = options["expect-catalog"] ? `${slot}-catalog` : basename(apworld);

const started = Date.now();
const say = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);

const browser = await puppeteer.launch({
  browser: "chrome",
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  protocolTimeout: 120_000,
  args: options.insecure ? ["--ignore-certificate-errors"] : [],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));
  page.on("console", (msg) => ["error", "warning"].includes(msg.type()) && say(`[console ${msg.type()}] ${msg.text().slice(0, 300)}`));

  const status = () => page.evaluate(() => ({
    phase: window.kalapanaState.phase,
    connection: window.kalapanaState.connection,
    entry: window.kalapanaState.entry,
    offered: !document.getElementById("apworld-button").hidden,
  }));
  // Settles on a new phase, or on a refusal whose message differs from `previous`.
  const settle = (previous) => page.waitForFunction(
    (prev) => ["files", "booting", "tracking"].includes(window.kalapanaState.phase)
      || (window.kalapanaState.phase === "ready" && window.kalapanaState.connection.state === "down" && window.kalapanaState.connection.text !== prev),
    { timeout: 60_000 },
    previous,
  );

  await page.goto(`${base}/?${new URLSearchParams({ address, slot })}`);
  await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });
  let current = await status();
  if (current.offered) throw new Error("the apworld option is shown before any room check");

  await page.click("#connect");
  await settle("");
  current = await status();
  say("first check:", JSON.stringify(current));
  if (!current.offered) throw new Error("expected an apworld offer after the room check");
  if (options["expect-catalog"] && (current.connection.state === "down" || current.entry?.source === "upload")) {
    throw new Error("expected the catalog to match");
  }

  if (apworld !== "-") {
    // Choosing the file checks the room again with it.
    const previous = current.connection.text;
    await (await page.$("#apworld")).uploadFile(apworld);
    await page.waitForFunction(
      (prev) => (window.kalapanaState.entry?.source === "upload" && ["files", "booting", "tracking"].includes(window.kalapanaState.phase))
        || (window.kalapanaState.phase === "ready" && window.kalapanaState.connection.state === "down" && window.kalapanaState.connection.text !== prev),
      { timeout: 60_000 },
      previous,
    );
    current = await status();
    say("with apworld:", JSON.stringify(current));
  }

  if (options["expect-fail"]) {
    const logs = await page.evaluate(() => window.kalapanaState.logs.map((line) => `${line.level}: ${line.text}`));
    for (const line of logs) say("  log", line.split("\n").slice(-2).join(" | ").slice(0, 400));
    await page.screenshot({ path: `${shotDir}/${label}-refused.png` });
    if (current.connection.state !== "down" || !`${current.connection.text}\n${logs.join("\n")}`.includes(options["expect-fail"])) {
      throw new Error(`expected a refusal mentioning "${options["expect-fail"]}"`);
    }
    say("refused as expected");
  } else {
    if (current.connection.state === "down") throw new Error(current.connection.text);
    if (current.phase === "files") {
      if (options.yaml) await (await page.$("#yaml")).uploadFile(options.yaml);
      if (options.pack) await (await page.$("#pack")).uploadFile(options.pack);
      await page.click("#start");
    }
    await page.waitForFunction(
      () => (window.kalapanaState.connection.state === "up" && window.kalapanaState.trackerLines.length > 0) || window.kalapanaState.error,
      { timeout: 60_000 },
    );
    const summary = await page.evaluate(() => ({
      error: window.kalapanaState.error,
      message: document.getElementById("message").textContent,
      source: window.kalapanaState.entry?.source,
      version: window.kalapanaState.entry?.version,
      inLogic: window.kalapanaState.labels.tracker_logic_locs_label,
      trackerLines: window.kalapanaState.trackerLines.length,
      maps: window.kalapanaState.maps.length,
      logErrors: window.kalapanaState.logs.filter((line) => line.level === "ERROR").map((line) => line.text.slice(0, 300)),
    }));
    say("summary:", JSON.stringify(summary));
    await page.screenshot({ path: `${shotDir}/${label}-tracking.png` });
    if (summary.error) throw new Error(summary.error);
  }
} catch (err) {
  say("FAILED:", err.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
