// Research only (#130): serves the browser bench with COOP/COEP (cross-origin
// isolated, so SharedArrayBuffer and wasm threads work) on 127.0.0.1, takes the
// page's result with POST /result and exits.
// node server.mjs <static root> <data dir> <result file> <port>
import { createServer } from "node:http";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const [root, dataDir, out, port] = process.argv.slice(2);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
};
const inside = (base, rel) => {
  const path = normalize(join(base, rel));
  return path === base || path.startsWith(base + sep) ? path : null;
};
createServer(async (req, res) => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  };
  if (req.method === "POST" && req.url === "/log") {
    let body = "";
    for await (const chunk of req) body += chunk;
    await appendFile(`${out}.log`, `${body}\n`);
    res.writeHead(204, headers).end();
    return;
  }
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    for await (const chunk of req) body += chunk;
    await writeFile(out, body);
    res.writeHead(204, headers).end();
    setTimeout(() => process.exit(0), 50);
    return;
  }
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  const path = pathname.startsWith("/data/")
    ? inside(dataDir, pathname.slice("/data/".length))
    : inside(root, pathname === "/" ? "index.html" : pathname.slice(1));
  try {
    if (!path) throw new Error("outside");
    // wasm-bindgen-rayon's workers import('../../..'): the package directory
    // stands for its glue (what a bundler resolves).
    const file = (await stat(path)).isDirectory() ? join(path, "niho_develop_wasm.js") : path;
    const body = await readFile(file);
    res.writeHead(200, { ...headers, "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, headers).end();
  }
}).listen(Number(port), "127.0.0.1");
