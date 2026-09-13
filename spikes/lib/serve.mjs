// Static server for browser spikes: the spikes directory at /, and a data directory at /data/.
// Usage: node serve.mjs <data dir> [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const [dataDir, port = "8123"] = process.argv.slice(2);
if (!dataDir) {
  console.error("usage: node serve.mjs <data dir> [port]");
  process.exit(2);
}

const spikesDir = resolve(new URL("..", import.meta.url).pathname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".py": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".css": "text/css",
  ".png": "image/png",
  ".zip": "application/zip",
  ".apworld": "application/zip",
  ".wasm": "application/wasm",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const [root, rel] = path.startsWith("/data/") ? [dataDir, path.slice(6)] : [spikesDir, path.slice(1)];
  const file = join(root, normalize(rel || "index.html"));
  if (!file.startsWith(resolve(root))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${spikesDir} and /data -> ${dataDir} on http://localhost:${port}`));
