// HTTP interface: the web app, the Pyodide runtime, bundles, the catalog, health checks and admin actions.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlib } from "node:zlib";
import { config } from "./config.mjs";
import { exists } from "./fsutil.mjs";
import { log } from "./log.mjs";
import { paths } from "./paths.mjs";
import { refreshStatus, requestRefresh } from "./refresh.mjs";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".whl": "application/zip",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
// Zips and wheels are already compressed.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".wasm", ".svg", ".txt"]);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Pyodide compiles WebAssembly at runtime.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  // Rooms can be on any host and port.
  "connect-src 'self' wss: ws:",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const compressedBodies = new Map();

function compressedBody(path, info, encoding) {
  const key = `${path}|${info.mtimeMs}|${info.size}|${encoding}`;
  let body = compressedBodies.get(key);
  if (!body) {
    body = readFile(path).then((raw) =>
      encoding === "br"
        ? brotliAsync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipAsync(raw, { level: 9 }),
    );
    body.catch(() => compressedBodies.delete(key));
    compressedBodies.set(key, body);
  }
  return body;
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value, null, 1));
}

async function sendFile(req, res, path, { immutable = false } = {}) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return sendText(res, 404, "not found");
  }
  if (!info.isFile()) return sendText(res, 404, "not found");

  const ext = extname(path);
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (ext === ".html") headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const accepted = req.headers["accept-encoding"] ?? "";
  const encoding = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
  if (encoding) {
    const body = await compressedBody(path, info, encoding);
    res.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": body.length });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(path).pipe(res);
}

// Compares digests so neither the token's content nor its length leaks through timing.
function authorized(req) {
  if (!config.adminToken) return false;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(config.adminToken));
}

async function handle(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return sendText(res, 400, "bad request");
  }

  if (req.method === "POST") {
    if (path !== "/admin/refresh") return sendText(res, 404, "not found");
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    await requestRefresh("admin");
    return sendJson(res, 202, await refreshStatus());
  }
  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed");

  if (path === "/healthz") return sendText(res, 200, "ok");
  if (path === "/readyz") {
    return (await exists(paths.catalog())) ? sendText(res, 200, "ready") : sendText(res, 503, "catalog not built yet");
  }
  if (path === "/admin/status") {
    if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, await refreshStatus());
  }
  if (path === "/catalog.json") return sendFile(req, res, paths.catalog());

  let match = path.match(/^\/runtime\/pyodide-([^/]+)\/([A-Za-z0-9._-]+)$/);
  if (match) {
    if (match[1] !== config.inputs.pyodide.version) return sendText(res, 404, "not found");
    return sendFile(req, res, join(config.pyodideDir, match[2]), { immutable: true });
  }
  match = path.match(/^\/bundles\/core\/([a-f0-9]{64})\.zip$/);
  if (match) return sendFile(req, res, join(paths.coreDir(match[1]), "core.zip"), { immutable: true });
  match = path.match(/^\/bundles\/worlds\/([a-f0-9]{64})\.zip$/);
  if (match) return sendFile(req, res, join(paths.analysisDir(match[1]), "bundle.zip"), { immutable: true });

  const file = normalize(join(config.webDir, path === "/" ? "index.html" : path));
  if (!file.startsWith(config.webDir + sep)) return sendText(res, 404, "not found");
  return sendFile(req, res, file);
}

export function startHttp() {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log("request failed:", req.method, req.url, err.stack ?? err);
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  });
  server.listen(config.port, config.host, () => log(`listening on [${config.host}]:${config.port}`));
  return server;
}
