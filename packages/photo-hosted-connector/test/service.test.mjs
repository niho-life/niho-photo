import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY } from "../test-support/fake-niho.ts";
import { ROOT, paired, previewExecutor, settle, signal, world } from "./helpers.mjs";

const FILES = { "a.rw2": "synthetic raw one", "b.jpg": "synthetic jpeg two", "c.heic": "synthetic heic three" };

test("without an executor no job is claimed; with one, previews are rendered on the Mac and only outputs are uploaded", async () => {
  const bare = await paired(world({ files: FILES }));
  await settle(bare.connector);
  const id = bare.index.all()[0].photoId;
  bare.niho.enqueue("preview", id);
  await bare.connector.tick(signal);
  assert(!bare.niho.requests.some((request) => request.operation === "renderJobs.claim"));

  const context = await paired(world({ files: FILES, executors: { preview: previewExecutor } }));
  const { connector, niho, index, power, fs } = context;
  await settle(connector);
  const originals = fs.snapshot();
  const jobs = index.all().map((entry) => niho.enqueue("preview", entry.photoId));
  niho.enqueue("albumItem", index.all()[0].photoId);
  const result = await settle(connector);
  assert.equal(result.phase, "active");
  for (const job of jobs) assert.equal(niho.jobs.get(job).job.state, "committed");
  assert.equal([...niho.jobs.values()].find((item) => item.job.purpose.kind === "albumItem").job.state, "queued", "only purposes with an executor are claimed");
  // Everything that left the Mac is executor output; no upload equals or approaches an original.
  const originalTexts = new Set(originals.values());
  for (const bytes of niho.uploads.values()) assert(!originalTexts.has(new TextDecoder().decode(bytes)));
  assert(power.holds.includes("jobs"));
  assert.equal(power.active, 0, "power assertions are released after work");
  assert(fs.bytesRead > 0);
  assert.deepEqual(fs.snapshot(), originals);
  assert.deepEqual(niho.requests.filter((request) => JSON.stringify(request.body).includes("synthetic raw one")), []);
});

test("a lost claim answer replays the leased jobs; a replayed start renews its ticket and sends the output again", async () => {
  const context = await paired(world({ files: FILES, executors: { preview: previewExecutor } }));
  const { connector, niho, index } = context;
  await settle(connector);
  const job = niho.enqueue("preview", index.all()[0].photoId);
  niho.dropNextResponse.add("renderJobs.claim");
  niho.dropNextResponse.add("renderJobs.startOutput");
  const from = niho.requests.length;
  await connector.tick(signal);
  const sent = niho.requests.slice(from);
  const [lost, retried, next] = sent.filter((request) => request.operation === "renderJobs.claim");
  assert.equal(retried.key, lost.key, "the lost claim is sent again with the same key");
  assert.notEqual(next?.key, lost.key, "a later claim is a new claim");
  assert.equal(niho.jobs.get(job).job.state, "committed", "the replayed lease is used, not left to expire");
  assert.equal(sent.filter((request) => request.operation === "renderJobs.startOutput").length, 2);
  assert.equal(niho.renewals, 1, "the replayed start had no ticket, so it was renewed");
  assert.equal(niho.committedOutputs.size, 1);
});

test("a job bound to older bytes fails as source_changed instead of rendering new bytes", async () => {
  const context = await paired(world({ files: FILES, executors: { preview: previewExecutor } }));
  const { connector, niho, index, fs } = context;
  await settle(connector);
  const entry = index.all().find((item) => item.relativePath === "a.rw2");
  const job = niho.enqueue("preview", entry.photoId);
  fs.modify(ROOT.id, "a.rw2", "synthetic raw one, changed after the job was queued");
  await connector.tick(signal);
  assert.equal(niho.jobs.get(job).job.state, "failed");
  assert.equal(niho.jobs.get(job).job.failure, "source_changed");
});

test("a restart reads back photo IDs, recipes and the replica without rescanning everything", async () => {
  const context = await paired(world({ files: FILES }));
  const { niho, index, fs } = context;
  await settle(context.connector);
  const photoId = index.all()[0].photoId;
  await niho.canonical.putRecipe({
    libraryId: LIBRARY, photoId, expectedRevision: 0, sourceGeneration: 1, settings: { v: 5, engine: "niho-14", exposure: 0.5 }, baseVersion: null,
  }, "owner-edit-1");
  const readsBefore = fs.bytesRead;
  const idsBefore = Object.fromEntries(index.all().map((entry) => [entry.relativePath, entry.photoId]));
  const restarted = context.build();
  assert.equal((await restarted.status()).phase, "active");
  await settle(restarted);
  assert.equal(fs.bytesRead, readsBefore, "unchanged originals are not read again");
  assert.deepEqual(Object.fromEntries(index.all().map((entry) => [entry.relativePath, entry.photoId])), idsBefore);
  assert.equal((await context.replica.get("recipe", photoId)).body.recipe.settings.exposure, 0.5);
});

test("sleep is announced, saves while asleep wait in NIHO, and wake pulls only the diff", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, niho, index, replica } = context;
  await settle(connector);
  const asleepAt = await replica.revision();
  await connector.willSleep(signal);
  assert.equal((await connector.status()).phase, "sleeping");
  assert.equal([...niho.connectors.values()][0].state, "sleeping");
  assert.deepEqual(await connector.tick(signal), { phase: "sleeping" });
  const photoId = index.all()[0].photoId;
  const saved = await niho.canonical.putRecipe({
    libraryId: LIBRARY, photoId, expectedRevision: 0, sourceGeneration: 1, settings: { v: 5, engine: "niho-14", exposure: -0.4 }, baseVersion: null,
  }, "asleep-edit");
  assert.equal(saved.value.durability, "niho");
  await connector.didWake();
  niho.requests.length = 0;
  await connector.tick(signal);
  const pull = niho.requests.find((request) => request.operation === "connector.pullReplica");
  assert.equal(pull.body.sinceRevision, asleepAt, "the replica continues from its own revision");
  assert.equal(await replica.revision(), niho.canonical.revision);
  assert.equal((await replica.get("recipe", photoId)).body.recipe.settings.exposure, -0.4);
  assert.equal([...niho.connectors.values()][0].state, "online");
});

test("after the local index is lost, exact matches are relinked and changed bytes are held, not relinked", async () => {
  const context = await paired(world({ files: FILES, executors: { preview: previewExecutor } }));
  const { connector, niho, index, fs } = context;
  await settle(connector);
  const before = Object.fromEntries(index.all().map((entry) => [entry.relativePath, entry.photoId]));
  await index.clear();
  fs.modify(ROOT.id, "b.jpg", "synthetic jpeg TWO");
  fs.remove(ROOT.id, "c.heic");
  const report = await connector.recoverIndex(signal);
  const states = Object.fromEntries(report.entries.map((entry) => [entry.photoId, entry.state]));
  assert.equal(states[before["a.rw2"]], "relinked");
  assert.equal(states[before["b.jpg"]], "sourceMismatch");
  assert.equal(states[before["c.heic"]], "sourceUnavailable");
  const revision = niho.canonical.revision;
  await settle(connector);
  const byPhoto = Object.fromEntries(index.all().map((entry) => [entry.photoId, entry]));
  assert.equal(byPhoto[before["a.rw2"]].relativePath, "a.rw2");
  assert.equal(byPhoto[before["b.jpg"]].hold, "sourceMismatch");
  assert.equal(niho.canonical.photoOf(before["b.jpg"]).source.generation, 1, "held bytes never become a new generation by themselves");
  assert.equal(niho.canonical.revision, revision, "recovery sends NIHO's own identities back, nothing new");
  // A held original is never rendered.
  const job = niho.enqueue("preview", before["b.jpg"]);
  await connector.tick(signal);
  assert.equal(niho.jobs.get(job).job.failure, "source_changed");
});

test("an original that was unavailable during recovery is verified against NIHO when it returns", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, niho, index, fs } = context;
  await settle(connector);
  const c = index.all().find((entry) => entry.relativePath === "c.heic").photoId;
  await index.clear();
  fs.setMounted(ROOT.id, false);
  await connector.recoverIndex(signal);
  fs.setMounted(ROOT.id, true);
  fs.modify(ROOT.id, "c.heic", "synthetic heic, but different bytes");
  await settle(connector);
  const entry = index.all().find((item) => item.photoId === c);
  assert.equal(entry.hold, "sourceMismatch");
  assert.equal(niho.canonical.photoOf(c).source.generation, 1);
});

test("disconnecting wipes the credential only; originals, index and replica stay for a later pairing", async () => {
  const context = await paired(world({ files: FILES }));
  const { connector, vault, index, fs, replica } = context;
  await settle(connector);
  const snapshot = { originals: fs.snapshot(), entries: index.all().length, replica: await replica.revision() };
  await connector.disconnect();
  assert.equal(vault.contents.credential, null);
  assert.notEqual(vault.contents.installSalt, null, "localKeys stay stable for re-pairing");
  assert.equal((await connector.status()).phase, "unpaired");
  assert.deepEqual(fs.snapshot(), snapshot.originals);
  assert.equal(index.all().length, snapshot.entries);
  assert.equal(await replica.revision(), snapshot.replica);
});
