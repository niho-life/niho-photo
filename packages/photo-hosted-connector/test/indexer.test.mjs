import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Bytes } from "../src/crypto.ts";
import { ROOT, paired, settle, signal, world } from "./helpers.mjs";

const FILES = {
  "2026/a.rw2": "synthetic raw one",
  "2026/b.JPG": "synthetic jpeg two",
  "2026/notes.txt": "not a photo",
  "2026/.hidden.jpg": "hidden",
  "Photos Library.photoslibrary/originals/c.jpg": "another app's database",
  "d.heic": "synthetic heic four",
};

test("existing folders are indexed read-only; only photos are registered and keys reveal no path", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, fs, niho, index } = context;
  fs.addSymlink(ROOT.id, "linked", "/somewhere/else");
  const before = fs.snapshot();
  await settle(connector);
  assert.deepEqual(fs.snapshot(), before, "originals are never written");
  const entries = index.all();
  assert.deepEqual(entries.map((entry) => entry.relativePath).sort(), ["2026/a.rw2", "2026/b.JPG", "d.heic"]);
  assert(entries.every((entry) => entry.photoId && entry.sha256 && !entry.dirty));
  // localKeys and every request body are free of paths and folder names.
  const sent = JSON.stringify(niho.requests.map((request) => request.body));
  for (const word of ["2026/", "photoslibrary", "linked", "/somewhere"]) assert(!sent.includes(word), word);
  assert(entries.every((entry) => /^lk-[0-9a-f]{64}$/.test(entry.localKey)));
  // NIHO lists them with the recorded hashes.
  for (const entry of entries) assert.equal(niho.canonical.photoOf(entry.photoId).source.sha256, entry.sha256);
  const progress = (await connector.status()).index;
  assert.equal(progress.photos, 3);
  assert.equal(progress.listed, 3);
  assert.equal(progress.pendingHashBytes, 0);
});

test("listing comes first: photos are listed before their hashes, and hashing is bounded per tick", async () => {
  const context = await paired(world({ files: FILES }));
  const connector = context.build({ budget: { maxDirectories: 100, maxHashBytes: 1, maxHashFiles: 1, maxJobs: 0 } });
  const first = await connector.tick(signal);
  assert.equal(first.hashed.files, 1);
  const progress = (await connector.status()).index;
  assert.equal(progress.listed, 3, "every photo is listable before it is hashed");
  assert.equal(progress.hashed, 1);
  assert(progress.pendingHashBytes > 0);
  assert(progress.hashBytesPerSecond === null || progress.estimatedRemainingMs !== null);
});

test("a scan interrupted mid-way resumes from its checkpoint without duplicates", async () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`d${n % 4}/p${n}.jpg`, `synthetic ${n}`]));
  const context = await paired(world({ files }));
  const step = context.build({ budget: { maxDirectories: 2, maxHashBytes: 0, maxHashFiles: 0, maxJobs: 0 } });
  const first = await step.tick(signal);
  assert.equal(first.scanComplete, false);
  // Restart: a new service instance with the same stores continues the same pass.
  const resumed = context.build({ budget: { maxDirectories: 2, maxHashBytes: 0, maxHashFiles: 0, maxJobs: 0 } });
  let done = false;
  for (let round = 0; round < 5 && !done; round++) done = (await resumed.tick(signal)).scanComplete;
  assert(done);
  assert.equal(context.index.all().length, 12);
  assert.equal(new Set(context.index.all().map((entry) => entry.localKey)).size, 12);
});

test("unmounted volumes and missing files are never deletions; remount brings them back", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, fs, niho, index } = context;
  await settle(connector);
  const ids = index.all().map((entry) => entry.photoId).sort();
  fs.setMounted(ROOT.id, false);
  await settle(connector);
  assert(index.all().every((entry) => entry.state === "unmounted"));
  assert.deepEqual(index.all().map((entry) => entry.photoId).sort(), ids);
  for (const id of ids) assert.notEqual(niho.canonical.photoOf(id), null, "NIHO keeps the photo");
  fs.setMounted(ROOT.id, true);
  fs.remove(ROOT.id, "d.heic");
  await settle(connector);
  const byPath = Object.fromEntries(index.all().map((entry) => [entry.relativePath, entry]));
  assert.equal(byPath["2026/a.rw2"].state, "present");
  assert.equal(byPath["d.heic"].state, "missing");
  assert.notEqual(niho.canonical.photoOf(byPath["d.heic"].photoId), null);
});

test("edited or replaced originals get a new generation; edits never reuse an old base silently", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, fs, niho, index } = context;
  await settle(connector);
  const entry = (path) => index.all().find((item) => item.relativePath === path);
  const a = entry("2026/a.rw2");
  fs.modify(ROOT.id, "2026/a.rw2", "synthetic raw one, edited");
  // Same size and mtime, different file: detected by the file id.
  fs.replace(ROOT.id, "d.heic", "synthetic heic FOUR");
  await settle(connector);
  assert.equal(entry("2026/a.rw2").photoId, a.photoId);
  assert.equal(niho.canonical.photoOf(a.photoId).source.generation, 2);
  assert.equal(niho.canonical.photoOf(entry("d.heic").photoId).source.generation, 2);
  assert.equal(niho.canonical.photoOf(entry("2026/b.JPG").photoId).source.generation, 1);
});

test("an excluded photo is never hashed, rendered or re-added, and its original stays", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, fs, niho, index } = context;
  await settle(connector);
  const b = index.all().find((item) => item.relativePath === "2026/b.JPG");
  niho.canonical.exclude(b.photoId);
  fs.modify(ROOT.id, "2026/b.JPG", "synthetic jpeg two, edited");
  const before = fs.snapshot();
  await settle(connector);
  const after = index.all().find((item) => item.relativePath === "2026/b.JPG");
  assert.equal(after.excluded, true);
  assert.deepEqual(fs.snapshot(), before);
  const revision = niho.canonical.revision;
  await settle(connector);
  assert.equal(niho.canonical.revision, revision, "rescans send nothing for an excluded photo");
});

test("paths outside the root and symlinked components are refused by the file system port", async () => {
  const context = world({ files: FILES });
  context.fs.addSymlink(ROOT.id, "2026/link", "../..");
  for (const path of ["../etc/passwd", "/abs.jpg", "2026/../d.heic", "2026/link/x.jpg", ""]) {
    await assert.rejects(context.fs.open(ROOT, path, signal), path);
  }
});

test("with a native hash port the originals never pass through the connector, and an unconfirmed hash is not kept", async () => {
  const context = await paired(world({ files: { "a.jpg": "synthetic one", "b.jpg": "synthetic two" } }));
  const { fs, index } = context;
  const hashed = [];
  const nativeFs = {
    rootStatus: (...args) => fs.rootStatus(...args),
    list: (...args) => fs.list(...args),
    stat: (...args) => fs.stat(...args),
    open: () => Promise.reject(new Error("originals are not opened by the connector page")),
    async hash(root, relativePath, expected) {
      hashed.push(relativePath);
      // b.jpg changed while it was read (the native side saw another identity afterwards)
      if (relativePath === "b.jpg") return null;
      const now = await fs.stat(root, relativePath, signal);
      if (!now || now.sizeBytes !== expected.sizeBytes || now.fileId !== expected.fileId || now.changeToken !== expected.changeToken) return null;
      const { bytes } = fs.roots.get(root.id).files.get(relativePath);
      return { sha256: await sha256Bytes(bytes), bytes: bytes.byteLength };
    },
  };
  await settle(context.build({ fs: nativeFs }));
  assert.deepEqual([...new Set(hashed)].sort(), ["a.jpg", "b.jpg"]);
  assert(hashed.filter((name) => name === "b.jpg").length > 1, "the unconfirmed file is tried again on a later step");
  assert.equal(fs.bytesRead, 0, "no original byte reached the connector");
  const byName = Object.fromEntries(index.all().map((entry) => [entry.relativePath, entry]));
  assert.equal(byName["a.jpg"].sha256, await sha256Bytes(new TextEncoder().encode("synthetic one")));
  assert.equal(byName["b.jpg"].sha256, null, "an unconfirmed hash is retried later, never kept");
});
