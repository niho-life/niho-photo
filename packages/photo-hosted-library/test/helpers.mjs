import assert from "node:assert/strict";
import { LIBRARY, SyntheticHostedCanonical } from "../test-support/canonical.ts";
import { MemoryReplicaStore, MemoryScanner, bytesOf } from "../test-support/memory.ts";
import { sha256Hex } from "../src/shared.ts";

export const signal = new AbortController().signal;

export async function indexEntry(localKey, text, { hashed = true } = {}) {
  const bytes = bytesOf(text);
  return {
    localKey,
    fileName: `${localKey}.rw2`,
    source: { generation: 1, sha256: hashed ? await sha256Hex(bytes) : null, sizeBytes: bytes.byteLength, format: "raw", width: 6000, height: 4000 },
    capturedAt: null,
    availability: "available",
  };
}

/** A canonical store with the given originals registered, and a scanner holding the same files. */
export async function seeded(files = { k1: "synthetic original one", k2: "synthetic original two" }) {
  const canonical = new SyntheticHostedCanonical();
  const scanner = new MemoryScanner();
  const entries = [];
  for (const [localKey, text] of Object.entries(files)) {
    entries.push(await indexEntry(localKey, text));
    scanner.files.set(localKey, bytesOf(text));
  }
  const results = await canonical.putIndex(entries);
  const ids = Object.fromEntries(results.map((result) => [result.localKey, result.photoId]));
  return { canonical, scanner, ids, store: new MemoryReplicaStore() };
}

export function editRequest(canonical, photoId, settings) {
  return {
    libraryId: LIBRARY,
    photoId,
    expectedRevision: canonical.recipeOf(photoId).revision,
    sourceGeneration: canonical.photoOf(photoId).source.generation,
    settings: { v: 5, engine: "niho-14", ...settings },
    baseVersion: null,
  };
}

export const maskSettings = (surfaceId, exposure = -0.5) => ({
  exposure,
  masks: [{ id: "synthetic-mask", kind: "brush", surface: { id: surfaceId, width: 4, height: 4 }, adjust: { exposure: -0.2 } }],
});

/** The replica must equal NIHO's current state, revision for revision. */
export function assertMirrors(canonical, store) {
  const snapshot = store.snapshot();
  assert.equal(snapshot.revision, canonical.revision);
  const replica = new Map(snapshot.records.map((record) => [`${record.entity}:${record.id}`, record.body]));
  assert.deepEqual(replica, canonical.state());
}

export { bytesOf };
