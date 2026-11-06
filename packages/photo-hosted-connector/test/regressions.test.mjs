import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNodeRootFileSystem } from "../node/index.ts";
import { OWNER } from "../test-support/fake-niho.ts";
import { ROOT, paired, previewExecutor, settle, signal, world } from "./helpers.mjs";

test("a disconnect during an in-flight rotation wins; the credential never comes back", async () => {
  const context = await paired(world());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const connector = context.build({
    transport: (secret) => ({
      request: async (operation, body, options) => {
        if (operation === "connector.rotateCredential") await gate;
        return context.niho.transport(secret).request(operation, body, options);
      },
    }),
  });
  const rotating = connector.rotateCredential(signal).catch((error) => error);
  const disconnecting = connector.disconnect();
  release();
  await Promise.all([rotating, disconnecting]);
  assert.equal(context.vault.contents.credential, null);
  assert.equal(context.vault.contents.rotation, null);
  assert.equal((await connector.status()).phase, "unpaired");
});

test("a registered root that is, or becomes, a symlink is unavailable and never followed", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "niho-connector-root-"));
  try {
    const real = path.join(base, "real");
    const elsewhere = path.join(base, "elsewhere");
    await mkdir(real);
    await mkdir(elsewhere);
    await writeFile(path.join(real, "a.jpg"), "synthetic original");
    await writeFile(path.join(elsewhere, "b.jpg"), "not registered");
    await symlink(elsewhere, path.join(base, "linkroot"));
    const fs = createNodeRootFileSystem(new Map([["link", path.join(base, "linkroot")], ["real", real]]));
    assert.equal(await fs.rootStatus({ id: "link" }, signal), "unmounted");
    await assert.rejects(fs.list({ id: "link" }, "", signal));
    await assert.rejects(fs.open({ id: "link" }, "b.jpg", signal));
    // Registered (pinned), then swapped for a symlink to another folder.
    assert.equal(await fs.rootStatus({ id: "real" }, signal), "available");
    await rename(real, path.join(base, "moved"));
    await symlink(elsewhere, real);
    assert.equal(await fs.rootStatus({ id: "real" }, signal), "unmounted");
    await assert.rejects(fs.open({ id: "real" }, "b.jpg", signal));
    await assert.rejects(fs.list({ id: "real" }, "", signal));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("bytes rewritten without any metadata change are never rendered against the old hash", async () => {
  const context = await paired(world({ files: { "a.rw2": "synthetic raw one" }, executors: { preview: previewExecutor } }));
  const { connector, niho, index, fs } = context;
  await settle(connector);
  const entry = index.all()[0];
  fs.rewriteInvisibly(ROOT.id, "a.rw2", "synthetic raw ONE");
  const job = niho.enqueue("preview", entry.photoId);
  await connector.tick(signal);
  assert.equal(niho.jobs.get(job).job.state, "failed");
  assert.equal(niho.jobs.get(job).job.failure, "source_changed");
  assert.equal(niho.uploads.size, 0, "nothing is uploaded for unverified bytes");
});

test("a directory that cannot be listed is skipped for the pass: the scan completes and nothing under it goes missing", async () => {
  const context = await paired(world({ files: { "keep/a.jpg": "synthetic a", "flaky/b.jpg": "synthetic b", "flaky/deeper/c.jpg": "synthetic c" } }));
  const { connector, fs, index } = context;
  await settle(connector);
  fs.failList.add("flaky");
  const result = await settle(connector);
  assert.equal(result.scanComplete, true);
  assert(index.all().every((entry) => entry.state === "present"), "entries under the unreadable directory keep their state");
  fs.failList.delete("flaky");
  fs.remove(ROOT.id, "flaky/b.jpg");
  await settle(connector);
  const states = Object.fromEntries(index.all().map((entry) => [entry.relativePath, entry.state]));
  assert.deepEqual(states, { "keep/a.jpg": "present", "flaky/b.jpg": "missing", "flaky/deeper/c.jpg": "present" });
});

test("an approved pairing is not answered after it expires", async () => {
  const { connector, niho } = world();
  const { userCode } = await connector.pair("Synthetic Mac", signal);
  niho.approve(userCode, OWNER, { kind: "newLibrary" });
  niho.now += 11 * 60 * 1000;
  assert.deepEqual(await connector.poll(signal), { state: "expired" });
  assert.equal((await connector.status()).phase, "unpaired");
});
