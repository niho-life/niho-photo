import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PhotoSessionHostError } from "../../../packages/photo-cloud-session/src/index.ts";

import { createPhotoWebRuntime } from "../src/runtime/runtime.ts";

const BASE_TIME = Date.parse("2026-11-03T00:00:00.000Z");

function identity(userId = "owner-a", overrides = {}) {
  return {
    userId,
    sessionId: `session-${userId}`,
    sessionEpoch: `epoch-${userId}`,
    transport: "browser-session",
    expiresAt: new Date(BASE_TIME + 120_000).toISOString(),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion, attempts = 40) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return assertion();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  throw last;
}

class Clock {
  now = BASE_TIME;
  nextId = 1;
  timers = new Map();
  setTimer = (callback, milliseconds) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, milliseconds), callback });
    return id;
  };
  clearTimer = (id) => { this.timers.delete(id); };
  tick(milliseconds) {
    const target = this.now + milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

class FakeBridge {
  current;
  reads = 0;
  refreshes = 0;
  logouts = 0;
  readQueue = [];
  refreshQueue = [];
  constructor(current = identity()) { this.current = current; }
  async #take(queue) {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    if (next && typeof next.then === "function") return next;
    if (next !== undefined) {
      this.current = next;
      return next;
    }
    return this.current;
  }
  async read() { this.reads += 1; return this.#take(this.readQueue); }
  async refresh() { this.refreshes += 1; return this.#take(this.refreshQueue); }
  async logout() { this.logouts += 1; this.current = null; }
  async cancel() {}
}

class FakeBroadcastChannel extends EventTarget {
  sent = [];
  closed = false;
  postMessage(value) { this.sent.push(value); }
  close() { this.closed = true; }
  receive(value) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value });
    this.dispatchEvent(event);
  }
}

class FakeConnection {
  disposed = 0;
  listeners = new Set();
  constructor(snapshot) { this.snapshot = snapshot; }
  getSnapshot() { return this.snapshot; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(snapshot) {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
  dispose() { this.disposed += 1; }
}

function binding(actorId = "owner-a", overrides = {}) {
  return {
    key: `library-${actorId}`,
    scopeKey: `scope-${actorId}`,
    actorId,
    library: { place: "cloud" },
    canEdit: true,
    cloudOriginalsAllowed: true,
    mobileEditingAllowed: true,
    disableCloudDelete: false,
    usage: null,
    ...overrides,
  };
}

function transferDescriptor(overrides = {}) {
  return {
    controller: {
      async checkCapability() { return true; },
      async start() { throw new Error("not called"); },
      async resume() { throw new Error("not called"); },
      async cancel() { throw new Error("not called"); },
      async list() { return { items: [], nextCursor: null }; },
      async readPendingRecipe() { return null; },
      dispose() {},
    },
    formats: [{ format: "jpeg", extensions: ["jpg", "jpeg"], ingest: true, workingCopy: true }],
    copy: {
      toolbar: "toolbar",
      pendingTitle: "pending",
      add: "add",
      resume: "resume",
      chooseSameFile: "choose",
      cancel: "cancel",
      refresh: "refresh",
      next: "next",
      first: "first",
      busy: "busy",
      failed: "failed",
      unsupported: "unsupported",
      refreshFailed: "refresh failed",
      phaseLabels: Object.fromEntries([
        "start-pending", "uploading", "complete-pending", "verifying", "pending-recipe", "done",
        "cancel-pending", "cancelled", "expired", "rejected", "purged", "failed", "needs-file",
      ].map((phase) => [phase, phase])),
    },
    describeError() { return "described"; },
    onSettled() {},
    privateExtra: "must-not-publish",
    ...overrides,
  };
}

function pageEvent(type, persisted) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

function harness(overrides = {}) {
  const clock = overrides.clock ?? new Clock();
  const window = new EventTarget();
  window.navigator = { onLine: true };
  window.location = { origin: "https://photo.example", reload() {} };
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    body: { append(anchor) { anchor.appended = true; } },
    createElement() {
      return {
        href: "",
        download: "",
        clicks: 0,
        removed: false,
        click() { this.clicks += 1; },
        remove() { this.removed = true; },
      };
    },
  });
  const urls = {
    created: [],
    revoked: [],
    createObjectURL() { const value = `blob:owned-${this.created.length + 1}`; this.created.push(value); return value; },
    revokeObjectURL(value) { this.revoked.push(value); },
  };
  const channel = new FakeBroadcastChannel();
  const bridge = overrides.bridge ?? new FakeBridge();
  const queryClient = overrides.queryClient ?? {
    cancellations: 0,
    clears: 0,
    invalidations: 0,
    cancelQueries() { this.cancellations += 1; return Promise.resolve(); },
    clear() { this.clears += 1; },
    invalidateQueries() { this.invalidations += 1; return Promise.resolve(); },
  };
  const revocations = [];
  const guards = overrides.guards ?? {
    async canLeave() { return true; },
    hasPending() { return false; },
    async onScopeRevoked(previous, reason) { revocations.push([previous.userId, reason]); },
  };
  const connections = [];
  const hosts = [];
  const connect = overrides.connect ?? (async ({ identity: captured, host }) => {
    hosts.push(host);
    const connection = new FakeConnection(binding(captured.userId));
    connections.push(connection);
    return connection;
  });
  const environment = {
    window,
    document,
    urls,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    createBroadcastChannel: () => channel,
    ...(overrides.environment ?? {}),
  };
  const runtimeOptions = {
    enabled: overrides.enabled ?? true,
    copy: overrides.copy ?? { failed: "fixed failure" },
    downloadBudget: Object.hasOwn(overrides, "downloadBudget")
      ? overrides.downloadBudget
      : { maxBytes: 4 * 1024 * 1024, maxEntries: 4 },
    connect,
    guards,
    cancelDialogs: overrides.cancelDialogs ?? (() => {}),
    environment,
    queryClient,
    sessionHost: bridge,
  };
  const runtime = createPhotoWebRuntime(runtimeOptions);
  return {
    runtime,
    runtimeOptions,
    clock,
    window,
    document,
    urls,
    channel,
    bridge,
    queryClient,
    revocations,
    connections,
    hosts,
    guards,
  };
}

describe("createPhotoWebRuntime", () => {
  it("retains one connection and immutable binding across a normal expiry rotation", async () => {
    const test = harness();
    await test.runtime.start();
    await eventually(() => assert.ok(test.runtime.getSnapshot().binding));
    const firstBinding = test.runtime.getSnapshot().binding;
    const firstKey = test.runtime.getSnapshot().dialogScopeKey;
    const rotated = identity("owner-a", { expiresAt: new Date(BASE_TIME + 240_000).toISOString() });
    test.bridge.refreshQueue.push(rotated);
    await test.runtime.retry();

    assert.equal(test.connections.length, 1);
    assert.equal(test.connections[0].disposed, 0);
    assert.equal(test.runtime.getSnapshot().binding, firstBinding);
    assert.equal(test.runtime.getSnapshot().dialogScopeKey, firstKey);
    assert.equal(test.runtime.getSnapshot().session.identity.expiresAt, rotated.expiresAt);
    assert.equal(Object.isFrozen(test.runtime.getSnapshot()), true);
    test.runtime.dispose();
  });

  it("captures critical configuration and ports at construction", async () => {
    let originalCancels = 0;
    let replacementConnects = 0;
    const test = harness({
      downloadBudget: { maxBytes: 1, maxEntries: 1 },
      cancelDialogs() { originalCancels += 1; },
    });
    test.runtimeOptions.enabled = false;
    test.runtimeOptions.connect = async () => {
      replacementConnects += 1;
      throw new Error("replacement must not run");
    };
    test.runtimeOptions.cancelDialogs = () => { throw new Error("replacement cancel"); };
    test.runtimeOptions.guards.canLeave = async () => false;
    test.runtimeOptions.copy.failed = "mutated private copy";
    test.runtimeOptions.downloadBudget.maxBytes = 100;
    test.runtimeOptions.environment.urls.createObjectURL = () => { throw new Error("replacement URL port"); };

    await test.runtime.start();
    assert.equal(test.connections.length, 1);
    assert.equal(replacementConnects, 0);
    assert.equal(await test.runtime.canLeave(), true);
    const host = test.hosts[0];
    await assert.rejects(
      host.saveFile({ blob: new Blob(["xx"]), fileName: "too-large.jpg" }),
      (error) => error instanceof Error && error.message === "fixed failure",
    );
    assert.equal(await host.saveFile({ blob: new Blob(["x"]), fileName: "captured.jpg" }), "downloaded");
    test.bridge.refreshQueue.push(new PhotoSessionHostError("temporarily-unavailable"));
    await test.runtime.retry();
    assert.ok(originalCancels >= 1);
    test.runtime.dispose();
  });

  it("fences verification failure without durable purge, while real scope reasons purge and dispose does not", async (context) => {
    await context.test("verification-unavailable and disposed", async () => {
      const test = harness();
      await test.runtime.start();
      test.bridge.refreshQueue.push(new PhotoSessionHostError("temporarily-unavailable"));
      await test.runtime.retry();
      assert.equal(test.runtime.getSnapshot().binding, null);
      assert.deepEqual(test.revocations, []);
      test.runtime.dispose();
      assert.deepEqual(test.revocations, []);
    });

    for (const [name, exercise, reason] of [
      ["identity change", async (test) => { test.bridge.refreshQueue.push(identity("owner-b")); await test.runtime.retry(); }, "identity-changed"],
      ["revoked", async (test) => { test.bridge.refreshQueue.push(null); await test.runtime.retry(); }, "revoked"],
      ["logout complete", async (test) => { await test.runtime.logout(); }, "logout-complete"],
      ["expired", async (test) => { test.document.visibilityState = "hidden"; test.clock.tick(1_000); await Promise.resolve(); }, "expired"],
    ]) {
      await context.test(name, async () => {
        const clock = new Clock();
        const bridge = new FakeBridge(reason === "expired"
          ? identity("owner-a", { expiresAt: new Date(BASE_TIME + 1_000).toISOString() })
          : identity());
        const test = harness({ clock, bridge });
        await test.runtime.start();
        await exercise(test);
        await eventually(() => assert.equal(test.revocations.at(-1)?.[1], reason));
        test.runtime.dispose();
      });
    }
  });

  it("disposes a late discarded adapter and retains at most one noncooperative connect", async () => {
    const first = deferred();
    let calls = 0;
    const handles = [];
    const test = harness({
      connect: async ({ identity: captured }) => {
        calls += 1;
        if (calls === 1) return first.promise;
        const handle = new FakeConnection(binding(captured.userId));
        handles.push(handle);
        return handle;
      },
    });
    const starting = test.runtime.start();
    await eventually(() => assert.equal(calls, 1));
    test.bridge.refreshQueue.push(identity("owner-b"), identity("owner-b"));
    test.window.dispatchEvent(new Event("focus"));
    test.window.dispatchEvent(new Event("focus"));
    await eventually(() => assert.ok(test.bridge.refreshes >= 1));
    assert.equal(calls, 1);
    await eventually(() => assert.deepEqual(test.revocations, [["owner-a", "identity-changed"]]));

    const late = new FakeConnection(binding("owner-a"));
    first.resolve(late);
    await starting;
    await eventually(() => assert.equal(calls, 2));
    await eventually(() => assert.equal(test.runtime.getSnapshot().binding?.actorId, "owner-b"));
    assert.equal(late.disposed, 1);
    test.runtime.dispose();
  });

  it("pins a same-generation connect rejection until explicit retry", async () => {
    let calls = 0;
    const test = harness({
      connect: async () => {
        calls += 1;
        throw new Error("private adapter failure");
      },
    });
    await test.runtime.start();
    await eventually(() => assert.equal(calls, 1));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    assert.equal(calls, 1);

    await test.runtime.retry();
    await eventually(() => assert.equal(calls, 2));
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(test.runtime.getSnapshot().binding, null);
    test.runtime.dispose();
  });

  it("waits for the single revocation cleanup barrier and permanently blocks replacement after its failure", async (context) => {
    await context.test("pending cleanup", async () => {
      const cleanup = deferred();
      const test = harness({ guards: {
        async canLeave() { return true; },
        hasPending() { return false; },
        onScopeRevoked() { return cleanup.promise; },
      } });
      await test.runtime.start();
      assert.equal(test.connections.length, 1);
      test.bridge.refreshQueue.push(identity("owner-b"));
      await test.runtime.retry();
      await Promise.resolve();
      assert.equal(test.connections.length, 1);
      assert.equal(test.runtime.getSnapshot().binding, null);
      cleanup.resolve();
      await eventually(() => assert.equal(test.connections.length, 2));
      assert.equal(test.runtime.getSnapshot().binding.actorId, "owner-b");
      test.runtime.dispose();
    });

    await context.test("failed cleanup", async () => {
      const test = harness({ guards: {
        async canLeave() { return true; },
        hasPending() { return false; },
        async onScopeRevoked() { throw new Error("cleanup failed"); },
      } });
      await test.runtime.start();
      test.bridge.refreshQueue.push(identity("owner-b"), identity("owner-b"));
      await test.runtime.retry();
      await test.runtime.retry();
      await Promise.resolve();
      assert.equal(test.connections.length, 1);
      assert.equal(test.runtime.getSnapshot().binding, null);
      test.runtime.dispose();
    });
  });

  it("keeps revocation cleanup bounded during metadata-only owner churn", async () => {
    const cleanup = deferred();
    let cleanupCalls = 0;
    let connectCalls = 0;
    const test = harness({
      guards: {
        async canLeave() { return true; },
        hasPending() { return false; },
        onScopeRevoked() { cleanupCalls += 1; return cleanup.promise; },
      },
      connect: async ({ identity: captured }) => {
        connectCalls += 1;
        return new FakeConnection(binding(captured.userId));
      },
    });
    await test.runtime.start();
    for (let index = 0; index < 40; index += 1) {
      test.bridge.refreshQueue.push(identity(`metadata-${index}`));
      await test.runtime.retry();
    }
    assert.equal(cleanupCalls, 1);
    assert.equal(connectCalls, 1);
    assert.equal(test.runtime.getSnapshot().binding, null);

    cleanup.resolve();
    await eventually(() => assert.equal(connectCalls, 2));
    assert.equal(test.runtime.getSnapshot().binding.actorId, "metadata-39");
    test.runtime.dispose();
    assert.equal(cleanupCalls, 1);
  });

  it("rejects invalid identity/core switches and ignores callbacks from a disposed connection", async () => {
    const invalid = harness({
      connect: async () => new FakeConnection(binding("other-owner")),
    });
    await invalid.runtime.start();
    assert.equal(invalid.runtime.getSnapshot().binding, null);
    invalid.runtime.dispose();

    const test = harness();
    await test.runtime.start();
    const handle = test.connections[0];
    const before = test.runtime.getSnapshot().dialogScopeKey;
    handle.emit(binding("owner-a", { key: "silently-switched" }));
    assert.equal(test.runtime.getSnapshot().binding, null);
    assert.notEqual(test.runtime.getSnapshot().dialogScopeKey, before);
    assert.equal(handle.disposed, 1);
    handle.emit(binding("owner-a", { canEdit: false }));
    assert.equal(test.runtime.getSnapshot().binding, null);
    test.runtime.dispose();
  });

  it("accepts bounded composite keys and snapshots only immutable known binding fields", async (context) => {
    await context.test("long valid composite", async () => {
      const longKey = `library:${"a".repeat(7_900)}`;
      const source = binding("owner-a", {
        key: longKey,
        scopeKey: `scope:${"b".repeat(7_900)}`,
        usage: {
          quotaBytes: 100,
          usedBytes: 20,
          originalBytes: 15,
          maskBytes: 5,
          pendingPurgeBytes: 0,
          reservedBytes: 0,
          availableBytes: 80,
        },
        privateExtra: "must-not-publish",
      });
      const test = harness({ connect: async () => new FakeConnection(source) });
      await test.runtime.start();
      const accepted = test.runtime.getSnapshot().binding;
      assert.equal(accepted.key, longKey);
      assert.equal(Object.isFrozen(accepted), true);
      assert.equal(Object.isFrozen(accepted.usage), true);
      assert.equal("privateExtra" in accepted, false);
      assert.notEqual(accepted.usage, source.usage);
      test.runtime.dispose();
    });

    await context.test("oversize and non-boolean capability", async () => {
      for (const source of [
        binding("owner-a", { key: "x".repeat(8_193) }),
        binding("owner-a", { canEdit: 1 }),
      ]) {
        const handle = new FakeConnection(source);
        const test = harness({ connect: async () => handle });
        await test.runtime.start();
        assert.equal(test.runtime.getSnapshot().binding, null);
        assert.equal(handle.disposed, 1);
        test.runtime.dispose();
      }
    });

    for (const field of ["key", "library"]) {
      await context.test(`post-accept ${field} mutation`, async () => {
        const source = binding();
        const handle = new FakeConnection(source);
        const test = harness({ connect: async () => handle });
        await test.runtime.start();
        assert.ok(test.runtime.getSnapshot().binding);
        if (field === "key") source.key = "mutated-key";
        else source.library = { place: "cloud" };
        handle.emit(source);
        assert.equal(test.runtime.getSnapshot().binding, null);
        assert.equal(handle.disposed, 1);
        test.runtime.dispose();
      });
    }
  });

  it("projects a validated transfer descriptor explicitly and preserves its identity within the scope", async () => {
    const transfer = transferDescriptor();
    const source = binding("owner-a", { transfer });
    const handle = new FakeConnection(source);
    const test = harness({ connect: async () => handle });
    await test.runtime.start();

    const projected = test.runtime.getSnapshot().binding.transfer;
    assert.ok(projected);
    assert.notEqual(projected, transfer);
    assert.equal(projected.controller, transfer.controller);
    assert.equal(projected.describeError, transfer.describeError);
    assert.equal(projected.onSettled, transfer.onSettled);
    assert.equal("privateExtra" in projected, false);
    assert.equal(Object.isFrozen(projected), true);
    assert.equal(Object.isFrozen(projected.formats), true);
    assert.equal(Object.isFrozen(projected.formats[0].extensions), true);
    assert.equal(Object.isFrozen(projected.copy.phaseLabels), true);

    handle.emit({ ...source, usage: null });
    assert.equal(test.runtime.getSnapshot().binding.transfer, projected);
    test.runtime.dispose();

    const invalidHandle = new FakeConnection(binding("owner-a", {
      transfer: transferDescriptor({ onSettled: null }),
    }));
    const invalid = harness({ connect: async () => invalidHandle });
    await invalid.runtime.start();
    assert.equal(invalid.runtime.getSnapshot().binding, null);
    assert.equal(invalidHandle.disposed, 1);
    invalid.runtime.dispose();
  });

  it("reused descriptor gets a fresh controller projection after scope changes", async () => {
    const transfer = transferDescriptor();
    const oldController = transfer.controller;
    const newController = transferDescriptor().controller;
    const handles = [];
    const test = harness({ connect: async ({ identity: captured }) => {
      if (handles.length > 0) transfer.controller = newController;
      const handle = new FakeConnection(binding(captured.userId, { transfer }));
      handles.push(handle);
      return handle;
    } });
    await test.runtime.start();
    const previous = test.runtime.getSnapshot().binding.transfer;
    assert.equal(previous.controller, oldController);
    test.bridge.refreshQueue.push(identity("owner-b"));
    await test.runtime.retry();
    await eventually(() => assert.equal(test.runtime.getSnapshot().binding?.actorId, "owner-b"));
    const current = test.runtime.getSnapshot().binding.transfer;
    assert.equal(handles[0].disposed, 1);
    assert.notEqual(current, previous);
    assert.equal(current.controller, newController);
    test.runtime.dispose();
  });

  it("downloads only in the accepted scope and clears query/URL resources synchronously", async () => {
    const test = harness();
    await test.runtime.start();
    const host = test.hosts[0];
    assert.equal(await host.saveFile({ blob: new Blob(["photo"]), fileName: "photo.jpg" }), "downloaded");
    assert.deepEqual(test.urls.created, ["blob:owned-1"]);
    host.notifyPhotosChanged();
    assert.equal(test.queryClient.invalidations, 1);

    test.bridge.refreshQueue.push(new PhotoSessionHostError("temporarily-unavailable"));
    await test.runtime.retry();
    assert.deepEqual(test.urls.revoked, ["blob:owned-1"]);
    assert.ok(test.queryClient.cancellations >= 1);
    assert.ok(test.queryClient.clears >= 1);
    await assert.rejects(host.saveFile({ blob: new Blob(), fileName: "late.jpg" }), /fixed failure/);
    test.runtime.dispose();
  });

  it("bounds retained download URLs by entries and bytes and recovers budget after TTL/errors", async (context) => {
    await context.test("count, bytes, and TTL", async () => {
      const test = harness({ downloadBudget: { maxBytes: 5, maxEntries: 2 } });
      await test.runtime.start();
      const host = test.hosts[0];
      assert.equal(await host.saveFile({ blob: new Blob(["ab"]), fileName: "a.jpg" }), "downloaded");
      assert.equal(await host.saveFile({ blob: new Blob(["cde"]), fileName: "b.jpg" }), "downloaded");
      await assert.rejects(host.saveFile({ blob: new Blob(), fileName: "count.jpg" }), /fixed failure/);
      await assert.rejects(host.saveFile({ blob: new Blob(["z"]), fileName: "bytes.jpg" }), /fixed failure/);
      assert.equal(test.urls.created.length, 2);

      test.clock.tick(60_000);
      await eventually(() => assert.equal(test.urls.revoked.length, 2));
      await eventually(() => assert.equal(test.runtime.getSnapshot().session.phase, "ready"));
      assert.equal(await host.saveFile({ blob: new Blob(["12345"]), fileName: "recovered.jpg" }), "downloaded");
      test.runtime.dispose();
      assert.equal(test.urls.revoked.length, 3);
    });

    await context.test("throwing click releases bytes", async () => {
      let failClick = true;
      const controlledDocument = Object.assign(new EventTarget(), {
        visibilityState: "visible",
        body: { append() {} },
        createElement() {
          return {
            href: "",
            download: "",
            click() { if (failClick) throw new Error("private browser failure"); },
            remove() {},
          };
        },
      });
      const test = harness({
        downloadBudget: { maxBytes: 4, maxEntries: 1 },
        environment: { document: controlledDocument },
      });
      await test.runtime.start();
      const host = test.hosts[0];
      await assert.rejects(host.saveFile({ blob: new Blob(["1234"]), fileName: "failed.jpg" }), /fixed failure/);
      assert.deepEqual(test.urls.revoked, ["blob:owned-1"]);
      failClick = false;
      assert.equal(await host.saveFile({ blob: new Blob(["1234"]), fileName: "next.jpg" }), "downloaded");
      test.runtime.dispose();
    });

    await context.test("undefined timer handle still revokes on invalidation", async () => {
      const timerCallbacks = [];
      const test = harness({ environment: {
        setTimer(callback, milliseconds) {
          timerCallbacks.push([callback, milliseconds]);
          return undefined;
        },
        clearTimer() {},
      } });
      await test.runtime.start();
      const host = test.hosts[0];
      assert.equal(await host.saveFile({ blob: new Blob(["x"]), fileName: "timer.jpg" }), "downloaded");
      test.bridge.refreshQueue.push(new PhotoSessionHostError("temporarily-unavailable"));
      await test.runtime.retry();
      assert.deepEqual(test.urls.revoked, ["blob:owned-1"]);
      assert.ok(timerCallbacks.some(([, milliseconds]) => milliseconds === 60_000));
      test.runtime.dispose();
    });
  });

  it("fails closed without a valid explicit download budget", async () => {
    for (const downloadBudget of [
      undefined,
      { maxBytes: 0, maxEntries: 1 },
      { maxBytes: 4 * 1024 * 1024, maxEntries: 17 },
      { maxBytes: 512 * 1024 * 1024 + 1, maxEntries: 1 },
    ]) {
      let calls = 0;
      const test = harness({ downloadBudget, connect: async () => { calls += 1; return new FakeConnection(binding()); } });
      await test.runtime.start();
      assert.equal(calls, 0);
      assert.equal(test.bridge.reads, 0);
      test.runtime.dispose();
    }
  });

  it("completes every authority cleanup when unsubscribe/dialog/query cancellation throw", async () => {
    const cleanup = deferred();
    let unsubscribeCalls = 0;
    let connectedHost;
    const queryClient = {
      cancellations: 0,
      clears: 0,
      invalidations: 0,
      cancelQueries() { this.cancellations += 1; throw new Error("private cancel failure"); },
      clear() { this.clears += 1; },
      invalidateQueries() { this.invalidations += 1; return Promise.resolve(); },
    };
    const test = harness({
      queryClient,
      cancelDialogs() { throw new Error("private dialog failure"); },
      guards: {
        async canLeave() { return true; },
        hasPending() { return false; },
        onScopeRevoked() { return cleanup.promise; },
      },
      connect: async ({ identity: captured, host }) => {
        connectedHost = host;
        const handle = new FakeConnection(binding(captured.userId));
        handle.subscribe = (listener) => {
          handle.listeners.add(listener);
          return () => {
            unsubscribeCalls += 1;
            handle.listeners.delete(listener);
            throw new Error("private unsubscribe failure");
          };
        };
        return handle;
      },
    });
    await test.runtime.start();
    assert.equal(await connectedHost.saveFile({ blob: new Blob(["owned"]), fileName: "owned.jpg" }), "downloaded");
    test.bridge.refreshQueue.push(identity("owner-b"));
    await test.runtime.retry();

    assert.equal(test.runtime.getSnapshot().session.identity.userId, "owner-b");
    assert.equal(test.runtime.getSnapshot().binding, null);
    assert.deepEqual(test.urls.revoked, ["blob:owned-1"]);
    assert.ok(queryClient.cancellations >= 1);
    assert.ok(queryClient.clears >= 1);
    assert.equal(unsubscribeCalls, 1);
    cleanup.resolve();
    await eventually(() => assert.equal(test.runtime.getSnapshot().binding?.actorId, "owner-b"));
    test.runtime.dispose();
    test.runtime.dispose();
  });

  it("releases a synchronous stale subscribe cleanup instead of retaining it globally", async () => {
    let unsubscribeCalls = 0;
    const mutable = binding();
    const handle = new FakeConnection(mutable);
    handle.subscribe = (listener) => {
      mutable.key = "mutated-during-subscribe";
      listener(mutable);
      return () => { unsubscribeCalls += 1; };
    };
    const test = harness({ connect: async () => handle });
    await test.runtime.start();
    assert.equal(test.runtime.getSnapshot().binding, null);
    assert.equal(handle.disposed, 1);
    assert.equal(unsubscribeCalls, 1);
    test.runtime.dispose();
    assert.equal(unsubscribeCalls, 1);
  });

  it("fails guards closed, bounds never-settling calls, fences stale unregister, and prevents cross-owner logout", async (context) => {
    for (const [name, decision] of [
      ["false", async () => false],
      ["error", async () => { throw new Error("private"); }],
    ]) {
      await context.test(name, async () => {
        const test = harness({ guards: { canLeave: decision, hasPending: () => false, onScopeRevoked() {} } });
        await test.runtime.start();
        assert.equal(await test.runtime.canLeave(), false);
        test.runtime.dispose();
      });
    }

    await context.test("never", async () => {
      let calls = 0;
      const test = harness({ guards: {
        canLeave: () => { calls += 1; return new Promise(() => {}); },
        hasPending: () => false,
        onScopeRevoked() {},
      } });
      await test.runtime.start();
      const pending = test.runtime.canLeave();
      await Promise.resolve();
      test.clock.tick(15_000);
      assert.equal(await pending, false);
      assert.equal(await test.runtime.canLeave(), false);
      assert.equal(calls, 1);
      test.runtime.dispose();
    });

    await context.test("invalidation aborts the retained C03 guard immediately", async () => {
      let guardSignal;
      const test = harness({ guards: {
        canLeave(_identity, options) {
          guardSignal = options.signal;
          return new Promise(() => {});
        },
        hasPending: () => false,
        onScopeRevoked() {},
      } });
      await test.runtime.start();
      const leaving = test.runtime.canLeave();
      await eventually(() => assert.ok(guardSignal));
      test.bridge.refreshQueue.push(new PhotoSessionHostError("temporarily-unavailable"));
      await test.runtime.retry();
      assert.equal(guardSignal.aborted, true);
      assert.equal(await leaving, false);
      test.runtime.dispose();
    });

    await context.test("stale registrar and logout race", async () => {
      const shared = deferred();
      const test = harness();
      await test.runtime.start();
      const oldRegistrar = test.runtime.registerRouteLeaveGuard;
      oldRegistrar(() => shared.promise);
      const logout = test.runtime.logout();
      test.bridge.refreshQueue.push(identity("owner-b"));
      test.window.dispatchEvent(new Event("focus"));
      await eventually(() => assert.equal(test.runtime.getSnapshot().session.identity?.userId, "owner-b"));
      const newRegistrar = test.runtime.registerRouteLeaveGuard;
      assert.notEqual(newRegistrar, oldRegistrar);
      newRegistrar(async () => true);
      oldRegistrar(null);
      shared.resolve(true);
      await logout;
      assert.equal(test.bridge.logouts, 0);
      await Promise.resolve();
      assert.equal(await test.runtime.canLeave(), true);
      test.runtime.dispose();
    });
  });

  it("coalesces focus and fenced generic/BFCache verification without credential broadcasts or echoes", async () => {
    const first = deferred();
    const second = deferred();
    const test = harness();
    await test.runtime.start();
    assert.deepEqual(test.channel.sent, [{ type: "session-changed" }]);
    assert.deepEqual(Object.keys(test.channel.sent[0]), ["type"]);
    test.bridge.refreshQueue.push(first.promise, second.promise);
    test.window.dispatchEvent(new Event("focus"));
    test.window.dispatchEvent(new Event("focus"));
    await eventually(() => assert.equal(test.bridge.refreshes, 1));
    test.channel.receive({ type: "session-changed" });
    assert.equal(test.runtime.getSnapshot().binding, null);
    assert.equal(test.channel.sent.length, 1);
    first.resolve(identity());
    await eventually(() => assert.equal(test.bridge.refreshes, 2));
    assert.equal(test.runtime.getSnapshot().binding, null);
    second.resolve(identity());
    await eventually(() => assert.ok(test.runtime.getSnapshot().binding));

    test.bridge.refreshQueue.push(identity());
    test.window.dispatchEvent(pageEvent("pagehide", true));
    assert.equal(test.runtime.getSnapshot().binding, null);
    test.window.dispatchEvent(pageEvent("pageshow", true));
    await eventually(() => assert.ok(test.runtime.getSnapshot().binding));
    test.runtime.dispose();
  });

  it("requires a verification started after the latest generic fence before reconnecting", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const test = harness();
    await test.runtime.start();
    test.bridge.refreshQueue.push(first.promise, second.promise, third.promise);

    test.window.dispatchEvent(new Event("focus"));
    await eventually(() => assert.equal(test.bridge.refreshes, 1));
    test.channel.receive({ type: "session-changed" });
    assert.equal(test.runtime.getSnapshot().binding, null);
    first.resolve(identity());
    await eventually(() => assert.equal(test.bridge.refreshes, 2));

    test.channel.receive({ type: "session-changed" });
    second.resolve(identity());
    await eventually(() => assert.equal(test.bridge.refreshes, 3));
    assert.equal(test.runtime.getSnapshot().binding, null);
    assert.equal(test.connections.length, 1);

    third.resolve(identity());
    await eventually(() => assert.ok(test.runtime.getSnapshot().binding));
    assert.equal(test.connections.length, 2);
    assert.equal(test.channel.sent.length, 1);
    test.runtime.dispose();
  });

  it("attempts proactive refresh once per unchanged expiry and does not loop after unavailable", async () => {
    const test = harness();
    await test.runtime.start();
    test.bridge.refreshQueue.push(identity(), new PhotoSessionHostError("temporarily-unavailable"));
    test.clock.tick(60_000);
    await eventually(() => assert.equal(test.bridge.refreshes, 1));
    test.clock.tick(1_000);
    await Promise.resolve();
    assert.equal(test.bridge.refreshes, 1);
    test.runtime.dispose();
  });

  it("registers the fixed PWA only when supported/enabled and ignores late registration after dispose", async (context) => {
    class Registration extends EventTarget {
      scope = "https://photo.example/";
      waiting = null;
      installing = null;
    }
    class ServiceWorkerContainer extends EventTarget {
      controller = null;
      calls = [];
      async register(url, options) { this.calls.push([url, options]); return new Registration(); }
    }

    await context.test("supported", async () => {
      const serviceWorker = new ServiceWorkerContainer();
      const test = harness({ environment: { serviceWorker } });
      await test.runtime.start();
      assert.deepEqual(serviceWorker.calls, [["/photo-sw.js", { scope: "/" }]]);
      assert.equal(test.runtime.getSnapshot().pwa?.snapshot.phase, "up-to-date");
      test.runtime.dispose();
    });

    await context.test("unsupported and disabled", async () => {
      const unsupported = harness();
      await unsupported.runtime.start();
      assert.equal(unsupported.runtime.getSnapshot().pwa, null);
      unsupported.runtime.dispose();
      const serviceWorker = new ServiceWorkerContainer();
      const disabled = harness({ enabled: false, environment: { serviceWorker } });
      await disabled.runtime.start();
      assert.equal(serviceWorker.calls.length, 0);
      disabled.runtime.dispose();
    });

    await context.test("disposed registration", async () => {
      const registration = deferred();
      const serviceWorker = new ServiceWorkerContainer();
      serviceWorker.register = async (url, options) => {
        serviceWorker.calls.push([url, options]);
        return registration.promise;
      };
      const test = harness({ environment: { serviceWorker } });
      const starting = test.runtime.start();
      await eventually(() => assert.equal(serviceWorker.calls.length, 1));
      test.runtime.dispose();
      registration.resolve(new Registration());
      await starting;
      assert.equal(test.runtime.getSnapshot().pwa, null);
    });
  });
});

it("fences host authority before invoking synchronous dialog cancellation on logout", async () => {
  let host;
  const observed = [];
  const test = harness({ cancelDialogs() {
    if (host) observed.push([host.isScopeCurrent(), host.scopeSignal.aborted]);
  } });
  await test.runtime.start();
  await eventually(() => assert.ok(test.hosts[0]));
  host = test.hosts[0];
  assert.equal(host.isScopeCurrent(), true);
  await test.runtime.logout();
  assert.deepEqual(observed[0], [false, true]);
  test.runtime.dispose();
});

it("keeps an open accepted scope editable offline and reverifies before online recovery", async () => {
  const test = harness();
  await test.runtime.start();
  await eventually(() => assert.ok(test.runtime.getSnapshot().binding));
  const original = test.runtime.getSnapshot().binding;
  const host = test.hosts[0];
  test.window.navigator.onLine = false;
  test.window.dispatchEvent(new Event("offline"));
  test.window.dispatchEvent(new Event("focus"));
  test.document.dispatchEvent(new Event("visibilitychange"));
  test.clock.tick(60_001);
  await Promise.resolve();
  assert.equal(test.bridge.refreshes, 0);
  assert.equal(test.runtime.getSnapshot().binding, original);
  assert.equal(host.scopeSignal.aborted, false);
  assert.equal(host.isScopeCurrent(), true);
  const recovered = deferred();
  test.bridge.refreshQueue.push(recovered.promise);
  test.window.navigator.onLine = true;
  test.window.dispatchEvent(new Event("online"));
  assert.equal(test.runtime.getSnapshot().session.phase, "verifying");
  assert.equal(test.runtime.getSnapshot().binding, original);
  recovered.resolve(identity("owner-a", { expiresAt: new Date(BASE_TIME + 240_000).toISOString() }));
  await eventually(() => assert.equal(test.runtime.getSnapshot().session.phase, "ready"));
  assert.equal(test.bridge.refreshes, 1);
  assert.equal(test.runtime.getSnapshot().binding, original);
  test.runtime.dispose();
});
