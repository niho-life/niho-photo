import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNER } from "../test-support/fake-niho.ts";
import { paired, signal, world } from "./helpers.mjs";

const secretsOf = (vault) => [vault.contents.credential?.secret, vault.contents.pairing?.pollSecret, vault.contents.pairing?.credentialSecret, vault.contents.rotation?.nextSecret].filter(Boolean);

test("one-time pairing: the owner approves the short code; no bearer travels from NIHO", async () => {
  const context = world();
  const { connector, niho, vault } = context;
  assert.equal((await connector.status()).phase, "unpaired");
  const { userCode } = await connector.pair("Synthetic Mac", signal);
  const createdCredential = vault.contents.pairing.credentialSecret;
  assert.equal((await connector.poll(signal)).state, "pending");
  niho.approve(userCode, OWNER, { kind: "newLibrary" });
  const approved = await connector.poll(signal);
  assert.equal(approved.state, "approved");
  assert.equal((await connector.status()).phase, "active");
  assert.equal(vault.contents.pairing, null);
  assert.equal(vault.contents.credential.secret, createdCredential, "the credential is the one the connector created");
  // The credential secret itself never left the Mac: requests carry only its hash.
  const sent = JSON.stringify(niho.requests.map((request) => request.body));
  assert(!sent.includes(vault.contents.credential.secret));
  assert.equal(secretsOf(vault).length, 1);
});

test("lost start and poll responses are replayed with the same pairing", async () => {
  const { connector, niho, vault } = world();
  niho.dropNextResponse.add("connector.startPairing");
  await assert.rejects(connector.pair("Synthetic Mac", signal));
  const key = vault.contents.pairing.key;
  const { userCode } = await connector.pair("Synthetic Mac", signal);
  assert.equal(vault.contents.pairing.key, key, "the same operation key is reused");
  assert.equal(niho.requests.filter((request) => request.operation === "connector.startPairing").length, 2);
  niho.approve(userCode, OWNER, { kind: "newLibrary" });
  niho.dropNextResponse.add("connector.pollPairing");
  await assert.rejects(connector.poll(signal));
  assert.equal((await connector.poll(signal)).state, "approved");
});

test("expired codes, used codes and another owner's library are refused", async () => {
  const { connector, niho } = world();
  const { userCode } = await connector.pair("Synthetic Mac", signal);
  niho.now += 11 * 60 * 1000;
  assert.throws(() => niho.approve(userCode, OWNER, { kind: "newLibrary" }), { code: "pairing_unavailable" });
  assert.deepEqual(await connector.poll(signal), { state: "expired" });
  assert.equal((await connector.status()).phase, "unpaired");

  const second = world();
  const code = (await second.connector.pair("Synthetic Mac", signal)).userCode;
  assert.throws(() => second.niho.approve(code, "synthetic-user-b", { kind: "existingLibrary", libraryId: "synthetic-library-hosted", libraryOwner: OWNER }), { code: "not_found" });
  second.niho.approve(code, OWNER, { kind: "newLibrary" });
  assert.throws(() => second.niho.approve(code, OWNER, { kind: "newLibrary" }), { code: "pairing_unavailable" }, "a code is used once");
});

test("rotation fences the old credential, and a lost rotation response is recovered", async () => {
  const context = await paired(world());
  const { connector, niho, vault } = context;
  const first = vault.contents.credential.secret;
  assert.equal(await connector.rotateCredential(signal), 2);
  const second = vault.contents.credential.secret;
  assert.notEqual(second, first);
  await assert.rejects(niho.transport(first).request("connector.heartbeat", { state: "online", renderer: null, replicaRevision: 0 }, { signal }), { code: "unauthenticated" });

  niho.dropNextResponse.add("connector.rotateCredential");
  await assert.rejects(connector.rotateCredential(signal));
  assert.notEqual(vault.contents.rotation, null, "the next secret was kept before sending");
  // NIHO already switched; the next tick's refused credential finishes the rotation instead of revoking.
  const result = await connector.tick(signal);
  assert.equal(result.phase, "active");
  assert.equal(vault.contents.rotation, null);
  assert.equal(vault.contents.credential.generation, 3);
  assert(!JSON.stringify(niho.requests.map((request) => request.body)).includes(vault.contents.credential.secret));
});

test("a revoked device stops, wipes its credential and leaves originals and the index alone", async () => {
  const context = await paired(world({ files: { "a.rw2": "synthetic original" } }));
  const { connector, niho, vault, fs, index } = context;
  await connector.tick(signal);
  const originals = fs.snapshot();
  const entries = index.all().length;
  niho.revoke(vault.contents.credential.connectorId);
  await assert.rejects(connector.tick(signal), { code: "revoked" });
  assert.equal((await connector.status()).phase, "revoked");
  assert.equal(vault.contents.credential, null);
  assert.deepEqual(fs.snapshot(), originals);
  assert.equal(index.all().length, entries);
  assert.deepEqual(await connector.tick(signal), { phase: "revoked" });
});
