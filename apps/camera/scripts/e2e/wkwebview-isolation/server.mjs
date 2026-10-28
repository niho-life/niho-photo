// Research only (#148 の 0): wkwebview-isolation.swift の http モード用。同じ文書を COOP / COEP 付きで 127.0.0.1 に配る。
// node server.mjs <port>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const files = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"], "/worker.js": ["worker.js", "text/javascript"] };
createServer(async (req, res) => {
  const entry = files[new URL(req.url, "http://127.0.0.1").pathname];
  if (!entry) return res.writeHead(404).end();
  res.writeHead(200, {
    "Content-Type": entry[1],
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  });
  res.end(await readFile(new URL(entry[0], import.meta.url)));
}).listen(Number(process.argv[2]), "127.0.0.1");
