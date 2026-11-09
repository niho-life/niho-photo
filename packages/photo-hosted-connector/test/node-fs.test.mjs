import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, rename, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNodeRootFileSystem, nodeHasher } from "../node/index.ts";
import { createIndexer } from "../src/indexer.ts";
import { MemoryIndexStore, ManualClock } from "../test-support/memory.ts";

const signal = new AbortController().signal;

test("the node file system reads regular files below the root only and never follows symlinks", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "niho-connector-"));
  try {
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await mkdir(path.join(root, "2026"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, "2026", "a.jpg"), "synthetic original");
    await writeFile(path.join(outside, "secret.jpg"), "outside the root");
    await symlink(path.join(outside, "secret.jpg"), path.join(root, "2026", "link.jpg"));
    await symlink(outside, path.join(root, "dirlink"));
    const fs = createNodeRootFileSystem(new Map([["r", root]]));
    const R = { id: "r" };
    assert.equal(await fs.rootStatus(R, signal), "available");
    const listing = Object.fromEntries((await fs.list(R, "2026", signal)).map((entry) => [entry.name, entry.kind]));
    assert.deepEqual(listing, { "a.jpg": "file", "link.jpg": "symlink" });
    const opened = await fs.open(R, "2026/a.jpg", signal);
    const hashed = await nodeHasher.hash(opened.read(signal), signal);
    await opened.close();
    assert.equal(hashed.bytes, 18);
    for (const bad of ["2026/link.jpg", "dirlink/secret.jpg", "../outside/secret.jpg", "2026/../../outside/secret.jpg", "/etc/hosts", ""]) {
      await assert.rejects(fs.open(R, bad, signal), bad);
      assert.equal(await fs.stat(R, bad, signal), null, bad);
    }
    // Indexing registers the real photo only and leaves the folder byte-for-byte unchanged.
    const store = new MemoryIndexStore();
    const indexer = createIndexer({ fs, roots: [R], store, hasher: nodeHasher, installSalt: async () => "synthetic-salt", clock: new ManualClock() });
    await indexer.beginScan(signal);
    while (!(await indexer.scanStep(signal, 10)).complete);
    await indexer.hashStep(signal, { maxBytes: 1e9, maxFiles: 100 });
    assert.deepEqual(store.all().map((entry) => entry.relativePath), ["2026/a.jpg"]);
    assert.equal(await readFile(path.join(outside, "secret.jpg"), "utf8"), "outside the root");
    // A file swapped under the same name is a different file id.
    await writeFile(path.join(root, "2026", "b.jpg"), "synthetic other");
    await rename(path.join(root, "2026", "b.jpg"), path.join(root, "2026", "a.jpg"));
    assert.notEqual((await fs.stat(R, "2026/a.jpg", signal)).fileId, store.all()[0].fileId);
    assert.equal(await fs.rootStatus({ id: "missing" }, signal).catch(() => "unmounted"), "unmounted");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
