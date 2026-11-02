import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadCloudRenderInput, readVerifiedMediaAsset } from "../src/browser/index.ts";
import { CloudMediaError } from "../src/types.ts";

const bytes = Uint8Array.from([1, 2, 3, 4]);
const digest = createHash("sha256").update(bytes).digest("hex");
const asset = { id: "opaque-asset", kind: "original", sha256: digest, sizeBytes: bytes.byteLength,
  contentType: "image/png", width: 1, height: 1 };
const initialScope = { actorId: "actor", libraryId: "library", sessionEpoch: "epoch" };

function content(body, overrides = {}) {
  return { body, contentType: asset.contentType, sha256: asset.sha256, totalBytes: asset.sizeBytes,
    range: { start: 0, endInclusive: asset.sizeBytes - 1 }, ...overrides };
}

function stream(chunks = [bytes]) {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}

function clientFor(factory) {
  return { scope: { ...initialScope }, request: factory, dispose() {} };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code && error.message === `photo-cloud-media: ${code}`);
}

test("verified reader accepts exact full content and release zeroizes once", async () => {
  const client = clientFor(async (_op, request) => {
    assert.deepEqual(request.range, { start: 0, endInclusive: 3 });
    return content(stream([bytes.subarray(0, 2), bytes.subarray(2)]));
  });
  const result = await readVerifiedMediaAsset(client, "photo", asset, { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal });
  assert.deepEqual([...new Uint8Array(result.bytes)], [...bytes]);
  result.release();
  result.release();
  assert.deepEqual([...new Uint8Array(result.bytes)], [0, 0, 0, 0]);
});

test("late caller abort releases already resolved bytes", async () => {
  const abort = new AbortController();
  const result = await readVerifiedMediaAsset(clientFor(async () => content(stream())), "photo", asset,
    { maxBytes: 4, timeoutMs: 1000, signal: abort.signal });
  abort.abort();
  assert.deepEqual([...new Uint8Array(result.bytes)], [0, 0, 0, 0]);
});

test("revocation observed at the final scope check cannot return verified bytes", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const abort = new AbortController();
  let digestCompleted = false;
  const client = clientFor(async () => content(stream()));
  Object.defineProperty(client, "scope", { get() {
    if (digestCompleted) abort.abort();
    return initialScope;
  } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: {
    async digest(...args) {
      const result = await originalDigest(...args);
      digestCompleted = true;
      return result;
    },
  } } });
  try {
    await rejectsCode(readVerifiedMediaAsset(client, "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: abort.signal }), "cancelled");
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("release remains idempotent after its buffer is transferred", async () => {
  const result = await readVerifiedMediaAsset(clientFor(async () => content(stream())), "photo", asset,
    { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal });
  structuredClone(result.bytes, { transfer: [result.bytes] });
  assert.equal(result.bytes.byteLength, 0);
  assert.doesNotThrow(() => result.release());
  assert.doesNotThrow(() => result.release());
});

test("reader captures asset and limits before a deferred response", async () => {
  let resolveRequest;
  const response = new Promise((resolve) => { resolveRequest = resolve; });
  const mutableAsset = { ...asset };
  const mutableOptions = { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal };
  const pending = readVerifiedMediaAsset(clientFor(() => response), "photo", mutableAsset, mutableOptions);
  mutableAsset.id = "mutated";
  mutableAsset.sha256 = "f".repeat(64);
  mutableAsset.sizeBytes = 999;
  mutableOptions.maxBytes = 1;
  mutableOptions.timeoutMs = 1;
  resolveRequest(content(stream()));
  const result = await pending;
  assert.deepEqual([...new Uint8Array(result.bytes)], [...bytes]);
  result.release();
});

test("loader composes immutable selection with the verified full asset", async () => {
  const photo = {
    id: "photo", libraryId: "library", storageState: "stored", lifecycle: "active", fileName: "synthetic.png",
    format: "png", hasEdits: false, addedAt: "2026-11-01T00:00:00Z", capturedAt: null,
    width: 1, height: 1, original: asset,
    recipe: { revision: 0, settings: { v: 9, engine: "niho-14", base: null }, settingsSha256: "a".repeat(64),
      baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-01T00:00:00Z" },
    media: { state: "pending" },
  };
  const loaded = await loadCloudRenderInput(clientFor(async () => content(stream())), photo, {
    recipeWritable: true, maxBytes: 4, maxPixels: 1, timeoutMs: 1000, signal: new AbortController().signal,
  });
  assert.equal(loaded.input.kind, "original");
  assert.deepEqual([...new Uint8Array(loaded.bytes)], [...bytes]);
  loaded.release();
});

test("metadata, length, chunk and budget mismatches are sanitized", async (t) => {
  const cases = [
    ["range", content(stream(), { range: { start: 1, endInclusive: 3 } })],
    ["type", content(stream(), { contentType: "image/jpeg" })],
    ["declared hash", content(stream(), { sha256: "a".repeat(64) })],
    ["short", content(stream([bytes.subarray(0, 2)]))],
    ["over", content(stream([bytes, Uint8Array.of(5)]))],
    ["empty chunk", content(stream([new Uint8Array(0)]))],
    ["wrong bytes hash", content(stream([Uint8Array.from([4, 3, 2, 1])]))],
  ];
  for (const [name, response] of cases) {
    await t.test(name, () => rejectsCode(readVerifiedMediaAsset(clientFor(async () => response), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal }), "content_mismatch"));
  }
  await t.test("budget before dispatch", async () => {
    let called = false;
    const client = clientFor(async () => { called = true; return content(stream()); });
    await rejectsCode(readVerifiedMediaAsset(client, "photo", asset,
      { maxBytes: 3, timeoutMs: 1000, signal: new AbortController().signal }), "input_limit");
    assert.equal(called, false);
  });
});

test("scope flips before response and while reading are rejected", async (t) => {
  await t.test("after fetch", async () => {
    const client = clientFor(async () => { client.scope = { ...client.scope, sessionEpoch: "next" }; return content(stream()); });
    await rejectsCode(readVerifiedMediaAsset(client, "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal }), "content_mismatch");
  });
  await t.test("during read", async () => {
    const client = clientFor(async () => content(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        queueMicrotask(() => { client.scope = { ...client.scope, actorId: "other" }; controller.close(); });
      },
    })));
    await rejectsCode(readVerifiedMediaAsset(client, "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal }), "content_mismatch");
  });
  await t.test("during controlled digest", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestStarted;
    let continueDigest;
    const started = new Promise((resolve) => { digestStarted = resolve; });
    const gate = new Promise((resolve) => { continueDigest = resolve; });
    const client = clientFor(async () => content(stream()));
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: {
      async digest(...args) {
        digestStarted();
        await gate;
        return originalDigest(...args);
      },
    } } });
    try {
      const pending = readVerifiedMediaAsset(client, "photo", asset,
        { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal });
      await started;
      client.scope = { ...client.scope, libraryId: "other" };
      continueDigest();
      await rejectsCode(pending, "content_mismatch");
    } finally {
      Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });
});

test("external errors and abort reasons are rebuilt with fixed messages", async (t) => {
  await t.test("known upstream code", async () => {
    const hostile = new CloudMediaError("invalid_input");
    hostile.message = "synthetic-upstream-private-detail";
    await rejectsCode(readVerifiedMediaAsset(clientFor(async () => { throw hostile; }), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal }), "invalid_input");
  });
  await t.test("unknown upstream code", async () => {
    const hostile = new CloudMediaError("invalid_input");
    hostile.message = "synthetic-upstream-private-detail";
    hostile.code = "synthetic-private-code";
    await rejectsCode(readVerifiedMediaAsset(clientFor(async () => { throw hostile; }), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: new AbortController().signal }), "content_mismatch");
  });
  await t.test("hostile abort reason", async () => {
    const abort = new AbortController();
    const hostile = new CloudMediaError("invalid_input");
    hostile.message = "synthetic-abort-private-detail";
    abort.abort(hostile);
    await rejectsCode(readVerifiedMediaAsset(clientFor(async () => content(stream())), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: abort.signal }), "cancelled");
  });
});

test("abort and deadline settle even when read/cancel never settle", async (t) => {
  const hostile = () => content(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }));
  await t.test("aborted before dispatch", async () => {
    const abort = new AbortController(); abort.abort();
    await rejectsCode(readVerifiedMediaAsset(clientFor(async () => hostile()), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: abort.signal }), "cancelled");
  });
  await t.test("abort during hostile read", async () => {
    const abort = new AbortController();
    const pending = readVerifiedMediaAsset(clientFor(async () => hostile()), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    await rejectsCode(pending, "cancelled");
  });
  await t.test("deadline during hostile read", async () => {
    const started = Date.now();
    await rejectsCode(readVerifiedMediaAsset(clientFor(async () => hostile()), "photo", asset,
      { maxBytes: 4, timeoutMs: 10, signal: new AbortController().signal }), "timeout");
    assert.ok(Date.now() - started < 500);
  });
  await t.test("late response body is cancelled", async () => {
    let resolveRequest;
    let cancelled = 0;
    const deferred = new Promise((resolve) => { resolveRequest = resolve; });
    const abort = new AbortController();
    const pending = readVerifiedMediaAsset(clientFor(() => deferred), "photo", asset,
      { maxBytes: 4, timeoutMs: 1000, signal: abort.signal });
    abort.abort();
    await rejectsCode(pending, "cancelled");
    resolveRequest(content({ cancel() { cancelled += 1; throw new Error("synthetic cancel detail"); } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, 1);
  });
});
