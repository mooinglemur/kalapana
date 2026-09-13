// Streamer mode check: the settings menu, the saved option, and the port hidden in the address field
// (except while editing) and in the status line.
// Usage: node streamer.mjs <base url> <room address> <slot> <screenshot dir> [--insecure]
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const args = process.argv.slice(2);
const insecure = args.includes("--insecure");
const [base, address, slot, shotDir] = args.filter((arg) => arg !== "--insecure");
if (!shotDir) {
  console.error("usage: node streamer.mjs <base url> <room address> <slot> <screenshot dir> [--insecure]");
  process.exit(2);
}
await mkdir(shotDir, { recursive: true });
const port = address.split(":").pop();
const masked = address.replace(/:\d+$/, ":•••••");

const started = Date.now();
const say = (...parts) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...parts);
const check = (ok, description, detail = "") => {
  if (!ok) throw new Error(`check failed: ${description} ${detail}`);
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
  await page.setViewport({ width: 1400, height: 700 });
  page.on("pageerror", (err) => say(`[pageerror] ${err.message}`));
  const field = () => page.$eval("#address", (input) => input.value);
  const message = () => page.$eval("#message", (node) => node.textContent);
  const menuOpen = () => page.evaluate(() => document.getElementById("settings").matches(":popover-open"));
  const clickBlank = () => page.mouse.click(700, 650);

  await page.goto(`${base}/?${new URLSearchParams({ address, slot })}`);
  await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });
  check((await field()) === address, "port shown while streamer mode is off");

  await page.click("#settings-button");
  check(await menuOpen(), "gear opens the settings menu");
  await page.screenshot({ path: `${shotDir}/settings-open.png` });
  await page.click("#streamer");
  check((await page.evaluate(() => localStorage.getItem("kalapana.streamer"))) === "true", "option saved");
  check((await field()) === masked, "port hidden once enabled", await field());
  await clickBlank();
  check(!(await menuOpen()), "clicking elsewhere closes the menu");

  await page.focus("#address");
  check((await field()) === address, "port revealed while editing");
  await page.keyboard.press("End");
  await page.keyboard.type("0");
  await page.keyboard.press("Backspace");
  await clickBlank();
  check((await field()) === masked, "port hidden again after leaving the field");

  await page.click("#connect");
  await page.waitForFunction(() => ["files", "booting", "tracking"].includes(window.kalapanaState.phase) || window.kalapanaState.error, { timeout: 60_000 });
  if (await page.evaluate(() => window.kalapanaState.phase === "files")) await page.click("#start");
  await page.waitForFunction(() => window.kalapanaState.connection.state === "up" || window.kalapanaState.error, { timeout: 240_000 });
  const text = await message();
  check(text.includes(masked) && !text.includes(port), "status line hides the port", text);
  check((await field()) === masked, "field stays hidden while tracking");
  const rawLogs = await page.evaluate(() => window.kalapanaState.logs.map((line) => line.text).join("\n"));
  const shownLogs = await page.$eval("#log-lines", (node) => node.textContent);
  check(rawLogs.includes(port) && !shownLogs.includes(port) && shownLogs.includes("•••••"), "log hides the port");
  const recentText = await page.$eval("#recent-list", (node) => node.textContent);
  check(recentText.includes(masked) && !recentText.includes(port), "Recent hides the port", recentText);
  await page.screenshot({ path: `${shotDir}/streamer-connected.png` });

  await page.reload();
  await page.waitForFunction(() => window.kalapanaState.phase === "ready", { timeout: 30_000 });
  check(await page.$eval("#streamer", (input) => input.checked), "option restored after reload");
  check((await field()) === masked, "port hidden after reload");

  await page.click("#settings-button");
  await page.click("#streamer");
  await clickBlank();
  check((await field()) === address, "port shown after turning it off");
  check((await page.$eval("#recent-list", (node) => node.textContent)).includes(address), "Recent shows the port after turning it off");
} catch (err) {
  say("FAILED:", err.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
