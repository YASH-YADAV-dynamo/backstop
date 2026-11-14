// Local-only static server + allow-listed proxy to the 1Click API. Node 22, no dependencies.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOST = "127.0.0.1", PORT = 8081;
const UPSTREAM = "https://1click.chaindefuser.com";
const JWT = process.env.ONE_CLICK_JWT; // server-side only; never sent to the browser, never logged
const MAX_BODY = 16 * 1024, TIMEOUT_MS = 25_000;
const dir = path.dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/helpers.mjs": ["helpers.mjs", "text/javascript; charset=utf-8"],
};
const ROUTES = {
  "POST /api/quote": "/v0/quote",
  "POST /api/deposit-submit": "/v0/deposit/submit",
  "GET /api/status": "/v0/status",
  "GET /api/tokens": "/v0/tokens",
};

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Block DNS-rebinding: only accept our own host names.
    const host = String(req.headers.host ?? "");
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: "bad host" });
    const url = new URL(req.url ?? "/", `http://${host}`);
    const key = `${req.method} ${url.pathname}`;

    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, await readFile(path.join(dir, file)), type);
    }
    const upstreamPath = ROUTES[key];
    if (!upstreamPath) return send(res, 404, { error: "not found" });

    let target = UPSTREAM + upstreamPath;
    const init = { method: req.method, headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (JWT) init.headers["X-API-Key"] = JWT; // same header the app's mover package uses
    if (req.method === "POST") {
      const body = await readBody(req);
      try { JSON.parse(body); } catch { return send(res, 400, { error: "body must be JSON" }); }
      init.headers["content-type"] = "application/json";
      init.body = body;
    } else if (url.pathname === "/api/status") {
      const addr = url.searchParams.get("depositAddress") ?? "";
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(addr)) return send(res, 400, { error: "bad depositAddress" });
      target += `?depositAddress=${encodeURIComponent(addr)}`;
    }
    const up = await fetch(target, init);
    const text = await up.text();
    return send(res, up.status, text.slice(0, 2_000_000), up.headers.get("content-type") ?? "application/json");
  } catch (err) {
    const code = err?.code === 413 ? 413 : 502;
    return send(res, code, { error: code === 413 ? "body too large" : `proxy error: ${err?.name ?? "Error"}` });
  }
});
server.requestTimeout = 30_000;
server.listen(PORT, HOST, () => console.log(`get-near-test listening on http://${HOST}:${PORT}`));
