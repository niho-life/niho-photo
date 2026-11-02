import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function browserGraph(entry) {
  const seen = new Set();
  const visit = async (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/g)) {
      await visit(resolve(dirname(path), match[1]));
    }
  };
  await visit(entry);
  return seen;
}

test("portable browser entry has no transitive server, Node, cookie, process, Buffer, or credential import", async () => {
  const files = await browserGraph(resolve(packageRoot, "src/index.ts"));
  const sources = await Promise.all([...files].map((path) => readFile(path, "utf8")));
  const combined = sources.join("\n");
  assert.equal([...files].some((path) => path.includes("/server/")), false);
  assert.doesNotMatch(combined, /(?:from|import)\s*["']node:/);
  assert.doesNotMatch(combined, /\b(?:Buffer|process)\b/);
  assert.doesNotMatch(combined, /__Host-|document\.cookie/i);
});

test("package exports keep browser and server entries explicit and separate", async () => {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports["."], "./src/index.ts");
  assert.equal(manifest.exports["./server"], "./src/server/index.ts");
  assert.notEqual(manifest.exports["."], manifest.exports["./server"]);
});
