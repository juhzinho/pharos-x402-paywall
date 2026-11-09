// Runs the whole service locally: the static demo site (public/), the paywalled API and its facilitator.
//   npm run server              http://localhost:3180
// Keys come from .env (see .env.example / scripts/keys.js) — never from code.
import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ENV = fileURLToPath(new URL("../.env", import.meta.url)); // the project's .env, whatever the working directory
if (existsSync(ENV)) process.loadEnvFile(ENV);
const { handleApp } = await import("../lib/app.js");
const PORT = Number(process.env.PORT ?? 3180);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const API = /^\/(facilitator|health$|catalog$|api\/)/;

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (API.test(pathname)) return handleApp(req, res);
    const file = normalize(pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
    if (file.startsWith("..")) return res.writeHead(403).end();
    try {
      const body = await readFile(join(ROOT, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}  (paid API + facilitator + site)`));
