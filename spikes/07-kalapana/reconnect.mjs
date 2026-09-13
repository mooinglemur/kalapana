// Reconnect behavior check: runs a real Archipelago server, drives the page through server restarts, a
// hidden tab, a frozen server (the dead-link watchdog), and a reload (saved entries and history).
// Usage: node reconnect.mjs <base url> <python> <archipelago dir> <seed zip> <port> <slot>
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";

const [base, python, apDir, seed, port, slot] = process.argv.slice(2);
if (!slot) {
  console.error("usage: node reconnect.mjs <base url> <python> <archipelago dir> <seed zip> <port> <slot>");
  process.exit(2);
}

const started = Date.now();
const say = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`, ...parts);

let server = null;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(python, ["MultiServer.py", "--host", "127.0.0.1", "--port", port, seed], {
      cwd: apDir,
      env: { ...process.env, SKIP_REQUIREMENTS_UPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watch = (chunk) => {
      if (String(chunk).includes("server listening")) resolve();
    };
    server.stdout.on("data", watch);
    server.stderr.on("data", watch);
    server.on("exit", (code) => code && reject(new Error(`server exited with ${code}`)));
  });
}

function stopServer() {
  return new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill("SIGKILL");
  });
}

const browser = await puppeteer.launch({ browser: "chrome", executablePath: "/usr/bin/google-chrome-stable", headless: true });
let exitCode = 0;
try {
  await startServer();
  say("server up");

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));

  const connection = () => page.evaluate(() => window.kalapanaState.connection);
  const waitFor = async (description, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await connection();
      if (predicate(last)) {
        say(`${description}: ${last.state} "${last.text}"`);
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${description}: timed out; last status ${JSON.stringify(last)}`);
  };
  // Headless tabs can't really be hidden, so the page's view of visibility is overridden.
  const setVisible = (visible) =>
    page.evaluate((isVisible) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (isVisible ? "visible" : "hidden") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, visible);

  await page.goto(`${base}/?${new URLSearchParams({ address: `127.0.0.1:${port}`, slot })}`);
  await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });
  await page.type("#password", "not-needed");
  await page.click("#connect");
  await page.waitForFunction(() => ["files", "booting", "tracking"].includes(window.kalapanaState.phase) || window.kalapanaState.error, { timeout: 60_000 });
  if (await page.evaluate(() => window.kalapanaState.phase === "files")) await page.click("#start");
  await waitFor("initial connection", (c) => c.state === "up", 120_000);

  await stopServer();
  say("server killed");
  await waitFor("backoff after the server went away", (c) => c.state === "down" && c.text.includes("Reconnecting in"), 20_000);

  await setVisible(false);
  await waitFor("hidden tab stops retrying", (c) => c.text.includes("come back to this tab"), 40_000);
  await startServer();
  say("server restarted while the tab is hidden");
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const whileHidden = await connection();
  if (whileHidden.state === "up") throw new Error("reconnected while the tab was hidden");
  say(`still not connected after 8s hidden: "${whileHidden.text}"`);

  await setVisible(true);
  await waitFor("reconnect when the tab is shown again", (c) => c.state === "up", 20_000);

  server.kill("SIGSTOP");
  say("server frozen (connection stays open, nothing arrives)");
  await waitFor("watchdog notices the silent link", (c) => c.state === "down", 90_000);
  server.kill("SIGCONT");
  say("server resumed");
  await waitFor("reconnect after the watchdog", (c) => c.state === "up", 60_000);

  await page.reload();
  await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });
  const restored = await page.evaluate(() => ({
    address: document.getElementById("address").value,
    slot: document.getElementById("slot").value,
    password: document.getElementById("password").value,
    recentButtonShown: !document.getElementById("recent-button").hidden,
    recent: JSON.parse(localStorage.getItem("kalapana.recent") || "[]").map((entry) => `${entry.slot}@${entry.address} (${entry.game})`),
  }));
  say("after reload:", JSON.stringify(restored));
  if (restored.slot !== slot || restored.password !== "not-needed" || restored.recent.length !== 1) {
    throw new Error("fields or history were not restored");
  }
  const log = await page.evaluate(() => window.kalapanaState.logs.length);
  say(`done; ${log} log lines on the reloaded page`);
} catch (err) {
  say("FAILED:", err.message);
  exitCode = 1;
} finally {
  await browser.close();
  if (server && server.exitCode === null) {
    server.kill("SIGCONT");
    server.kill("SIGKILL");
  }
}
process.exit(exitCode);
