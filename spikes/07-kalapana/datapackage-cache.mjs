// Datapackage cache check: a first session downloads the other games' datapackages in the page and
// saves them, a reload uses the saved copies, and a tampered copy is ignored and downloaded again.
// Usage: node datapackage-cache.mjs <base url> <room address> <slot> [--yaml file] [--insecure]
import puppeteer from "puppeteer-core";

const positional = [];
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) positional.push(argv[i]);
  else if (argv[i] === "--insecure") options.insecure = true;
  else options[argv[i].slice(2)] = argv[++i];
}
const [base, address, slot] = positional;
if (!slot) {
  console.error("usage: node datapackage-cache.mjs <base url> <room address> <slot> [--yaml file] [--insecure]");
  process.exit(2);
}

const started = Date.now();
const say = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);
const check = (ok, description, detail = "") => {
  if (!ok) throw new Error(`check failed: ${description} ${detail}`);
  say(`ok: ${description}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs in the page to read or change the cache directly, as world code sharing the origin could.
function withStore(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kalapana");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => action(request.result.transaction(storeName, mode).objectStore(storeName), resolve);
  });
}

const browser = await puppeteer.launch({
  browser: "chrome",
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  protocolTimeout: 60_000,
  args: options.insecure ? ["--ignore-certificate-errors"] : [],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));

  const session = async (name) => {
    await page.goto(`${base}/?${new URLSearchParams({ address, slot })}`);
    await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });
    await page.click("#connect");
    await page.waitForFunction(() => ["files", "booting", "tracking"].includes(window.kalapanaState.phase) || window.kalapanaState.error, { timeout: 30_000 });
    if (await page.evaluate(() => window.kalapanaState.phase === "files")) {
      if (options.yaml) await (await page.$("#yaml")).uploadFile(options.yaml);
      await page.click("#start");
    }
    await page.waitForFunction(
      () => (window.kalapanaState.connection.state === "up" && window.kalapanaState.trackerLines.length > 0) || window.kalapanaState.error,
      { timeout: 60_000 },
    );
    // The tracker can update more than once after connecting, and saves commit in the background.
    let last = -1;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const lines = await page.evaluate(() => window.kalapanaState.trackerLines.length);
      if (lines === last && i >= 2) break;
      last = lines;
    }
    const result = await page.evaluate(() => ({
      error: window.kalapanaState.error,
      trackerLines: window.kalapanaState.trackerLines.length,
      logs: window.kalapanaState.logs.map((line) => line.text),
    }));
    if (result.error) throw new Error(result.error);
    result.pageDownloads = result.logs.filter((text) => text.startsWith("Downloaded the datapackages for"));
    result.trackerDownloads = result.logs.filter((text) => text.startsWith("Got new ID/Name DataPackage"));
    result.hits = result.logs.filter((text) => text.includes("from this browser's cache"));
    result.rejected = result.logs.filter((text) => text.includes("failed its integrity check"));
    const { logs, ...shown } = result;
    say(`${name}:`, JSON.stringify(shown));
    return result;
  };

  const first = await session("first session");
  check(first.pageDownloads.length === 1 && first.trackerDownloads.length === 0 && first.hits.length === 0, "first session downloads in the page, not the tracker");
  const entries = await page.evaluate(withStore.toString() + `; withStore("entries", "readonly", (store, done) => {
    const all = store.getAll();
    all.onsuccess = () => done(all.result.map(({ game, checksum, size, mac }) => ({ game, checksum, size, signed: mac instanceof ArrayBuffer })));
  })`);
  say("stored:", JSON.stringify(entries));
  check(entries.length > 0 && entries.every((entry) => entry.signed), "downloads were saved and signed");

  const second = await session("after reload");
  check(second.pageDownloads.length === 0 && second.trackerDownloads.length === 0, "nothing downloaded after reload");
  check(second.hits.length === entries.length, "every saved datapackage was used");
  check(second.trackerLines === first.trackerLines, "tracking is unchanged");

  // Rename one location in a saved copy, keeping its signature.
  const game = entries[0].game;
  const renamed = await page.evaluate(withStore.toString() + `; withStore("datapackages", "readwrite", (store, done) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return done(null);
      if (!current.key.startsWith(${JSON.stringify(game)} + " ")) return current.continue();
      const data = JSON.parse(current.value);
      const [name] = Object.keys(data.location_name_to_id);
      data.location_name_to_id[name + " (tampered)"] = data.location_name_to_id[name];
      delete data.location_name_to_id[name];
      current.update(JSON.stringify(data)).onsuccess = () => done(name);
    };
  })`);
  say(`tampered with ${game}: renamed "${renamed}"`);

  const third = await session("after tampering");
  check(third.rejected.length === 1 && third.hits.length === entries.length - 1, "tampered copy ignored");
  check(third.pageDownloads.some((text) => text.includes(game)) && third.trackerDownloads.length === 0, "and downloaded again by the page");
  check(third.trackerLines === first.trackerLines, "tracking is unchanged");
  const stillTampered = await page.evaluate(withStore.toString() + `; withStore("datapackages", "readonly", (store, done) => {
    const all = store.getAll();
    all.onsuccess = () => done(all.result.some((text) => text.includes("(tampered)")));
  })`);
  check(!stillTampered, "the saved copy was replaced by the fresh download");
} catch (err) {
  say("FAILED:", err.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
