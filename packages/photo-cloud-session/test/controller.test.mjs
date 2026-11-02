import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import {
  PhotoSessionController,
  PhotoSessionHostError,
  PHOTO_MAC_CLIENT_ID,
  parsePhotoIdentity,
  readTrustedMacPhotoIdentity,
} from "../src/index.ts";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");

function identity(overrides = {}) {
  return {
    userId: "synthetic-user-alpha",
    sessionId: "synthetic-parent-session-alpha",
    sessionEpoch: "synthetic-server-epoch-1",
    transport: "browser-session",
    expiresAt: "2026-11-03T01:00:00.000Z",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function host(overrides = {}) {
  return {
    read: async () => identity(),
    refresh: async () => identity({ expiresAt: "2026-11-03T02:00:00.000Z" }),
    logout: async () => {},
    cancel: async () => {},
    ...overrides,
  };
}

test("identity DTO is closed, bounded, canonical, and has no profile or library claim", () => {
  const parsed = parsePhotoIdentity(identity(), { now: NOW });
  assert.deepEqual(parsed, identity());
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(() => { parsed.userId = "mutated"; }, TypeError);
  assert.equal(parsePhotoIdentity({ ...identity(), email: "nobody@example.invalid" }, { now: NOW }), null);
  assert.equal(parsePhotoIdentity({ ...identity(), libraryId: "synthetic-library" }, { now: NOW }), null);
  assert.equal(parsePhotoIdentity({ ...identity(), sessionEpoch: "" }, { now: NOW }), null);
  assert.equal(parsePhotoIdentity({ ...identity(), expiresAt: "2026-11-03T01:00:00Z" }, { now: NOW }), null);
  assert.equal(parsePhotoIdentity({ ...identity(), expiresAt: "2027-12-03T01:00:00.000Z" }, { now: NOW }), null);
});

test("trusted Mac metadata accepts mac-bearer only and exposes no token accessor", async () => {
  assert.equal(PHOTO_MAC_CLIENT_ID, "niho-camera");
  const controller = new AbortController();
  const mac = await readTrustedMacPhotoIdentity(
    async () => identity({ transport: "mac-bearer" }),
    controller.signal,
    () => NOW,
  );
  assert.equal(mac?.transport, "mac-bearer");
  assert.equal("token" in (mac ?? {}), false);
  assert.equal(await readTrustedMacPhotoIdentity(async () => identity(), controller.signal, () => NOW), null);
});

test("trusted Mac metadata samples time after native read and never returns after abort", async () => {
  let now = NOW;
  const late = deferred();
  const controller = new AbortController();
  const expired = readTrustedMacPhotoIdentity(async () => late.promise, controller.signal, () => now);
  now = Date.parse(identity().expiresAt) + 1;
  late.resolve(identity({ transport: "mac-bearer" }));
  assert.equal(await expired, null);

  const abortedRead = deferred();
  const abortedController = new AbortController();
  const aborted = readTrustedMacPhotoIdentity(async () => abortedRead.promise, abortedController.signal, () => NOW);
  abortedController.abort();
  abortedRead.resolve(identity({ transport: "mac-bearer" }));
  assert.equal(await aborted, null);

  let called = false;
  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(await readTrustedMacPhotoIdentity(async () => { called = true; return identity(); }, preAborted.signal, () => NOW), null);
  assert.equal(called, false);
});

test("normal credential refresh only rotates expiry and does not abort captured work", async () => {
  let now = NOW;
  const events = [];
  const operation = deferred();
  let taskSignal;
  const controller = new PhotoSessionController(host(), { now: () => now });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  const task = controller.runCaptured(async ({ signal }) => {
    taskSignal = signal;
    return operation.promise;
  });
  await controller.refresh();
  assert.equal(controller.getSnapshot().identity.expiresAt, "2026-11-03T02:00:00.000Z");
  assert.equal(taskSignal.aborted, false);
  assert.equal(events.some((event) => event.type === "scope-invalidated"), false);
  now = Date.parse(identity().expiresAt) + 1;
  operation.resolve("synthetic-result");
  assert.deepEqual(await task, { status: "accepted", value: "synthetic-result" });
  controller.dispose();
});

test("captured result waits for an in-progress stable refresh instead of discarding the draft", async () => {
  const refresh = deferred();
  const work = deferred();
  const controller = new PhotoSessionController(host({ refresh: async () => refresh.promise }), { now: () => NOW });
  await controller.read();
  const task = controller.runCaptured(async () => work.promise);
  const verifying = controller.refresh();
  work.resolve("retained-result");
  let settled = false;
  void task.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  refresh.resolve(identity({ expiresAt: "2026-11-03T02:00:00.000Z" }));
  await verifying;
  assert.deepEqual(await task, { status: "accepted", value: "retained-result" });
  controller.dispose();
});

test("latest verification request wins even when the older host task ignores AbortSignal", async () => {
  const first = deferred();
  let call = 0;
  const controller = new PhotoSessionController(host({
    read: async () => (++call === 1 ? first.promise : identity({ userId: "synthetic-user-new" })),
  }), { now: () => NOW });
  const oldRead = controller.read();
  const newRead = controller.read();
  await newRead;
  first.resolve(identity({ userId: "synthetic-user-old" }));
  await oldRead;
  assert.equal(controller.getSnapshot().identity.userId, "synthetic-user-new");
  controller.dispose();
});

test("identity switch invalidates a captured task that ignores abort", async () => {
  const work = deferred();
  let current = identity();
  const events = [];
  const controller = new PhotoSessionController(host({ read: async () => current }), { now: () => NOW });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  const task = controller.runCaptured(async () => work.promise);
  current = identity({ sessionEpoch: "synthetic-server-epoch-2" });
  await controller.read();
  work.resolve("late-value");
  assert.deepEqual(await task, { status: "discarded", reason: "stale" });
  assert.equal(events.some((event) => event.type === "scope-invalidated" && event.reason === "identity-changed"), true);
  controller.dispose();
});

test("temporary verification failure closes cloud work but retains identity without scope invalidation", async () => {
  let fail = false;
  const work = deferred();
  const events = [];
  const controller = new PhotoSessionController(host({
    read: async () => {
      if (fail) throw new PhotoSessionHostError("temporarily-unavailable");
      return identity();
    },
  }), { now: () => NOW });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  const task = controller.runCaptured(async () => work.promise);
  fail = true;
  await controller.read();
  work.resolve("must-be-fenced");
  assert.deepEqual(controller.getSnapshot(), {
    phase: "unavailable",
    identity: identity(),
    cloudOperationsAvailable: false,
    localEditingAvailable: true,
    error: "temporarily-unavailable",
  });
  assert.equal(events.some((event) => event.type === "scope-invalidated"), false);
  assert.deepEqual(await task, { status: "discarded", reason: "stale" });
  assert.deepEqual(await controller.runCaptured(async () => "must-not-run"), { status: "discarded", reason: "expired" });
  controller.dispose();
});

test("temporary verification failure permanently fences old work after same-scope recovery", async () => {
  let fail = false;
  const work = deferred();
  const events = [];
  const controller = new PhotoSessionController(host({
    read: async () => {
      if (fail) throw new PhotoSessionHostError("temporarily-unavailable");
      return identity();
    },
  }), { now: () => NOW });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  const task = controller.runCaptured(async () => work.promise);
  fail = true;
  await controller.read();
  fail = false;
  await controller.read();
  work.resolve("late-after-recovery");
  assert.deepEqual(await task, { status: "discarded", reason: "stale" });
  assert.equal(events.some((event) => event.type === "operations-invalidated" && event.reason === "verification-unavailable"), true);
  assert.equal(events.some((event) => event.type === "scope-invalidated"), false);
  controller.dispose();
});

test("producer revocation is distinct from a transient outage", async () => {
  let revoked = false;
  const events = [];
  const controller = new PhotoSessionController(host({
    read: async () => {
      if (revoked) throw new PhotoSessionHostError("unauthenticated");
      return identity();
    },
  }), { now: () => NOW });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  revoked = true;
  await controller.read();
  assert.equal(controller.getSnapshot().phase, "signed-out");
  assert.equal(controller.getSnapshot().identity, null);
  assert.equal(events.some((event) => event.type === "scope-invalidated" && event.reason === "revoked"), true);
  controller.dispose();
});

test("logout start fences late tasks while logout failure retains retryable identity", async () => {
  const logout = deferred();
  const work = deferred();
  const events = [];
  const controller = new PhotoSessionController(host({ logout: async () => logout.promise }), { now: () => NOW });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  const task = controller.runCaptured(async () => work.promise);
  const loggingOut = controller.logout();
  work.resolve("late-after-logout-start");
  assert.deepEqual(await task, { status: "discarded", reason: "stale" });
  logout.reject(new PhotoSessionHostError("temporarily-unavailable"));
  await loggingOut;
  assert.equal(controller.getSnapshot().phase, "unavailable");
  assert.equal(controller.getSnapshot().identity.userId, "synthetic-user-alpha");
  assert.equal(events.some((event) => event.type === "scope-invalidated"), false);
  controller.dispose();
});

test("successful logout clears identity and no earlier response can revive it", async () => {
  const oldRead = deferred();
  let call = 0;
  const controller = new PhotoSessionController(host({
    read: async () => (++call === 1 ? identity() : oldRead.promise),
  }), { now: () => NOW });
  await controller.read();
  const pendingRead = controller.read();
  await controller.logout();
  oldRead.resolve(identity());
  await pendingRead;
  assert.equal(controller.getSnapshot().phase, "signed-out");
  assert.equal(controller.getSnapshot().identity, null);
  controller.dispose();
});

test("late stable refresh cannot revive the controller after logout", async () => {
  const refresh = deferred();
  const controller = new PhotoSessionController(host({ refresh: async () => refresh.promise }), { now: () => NOW });
  await controller.read();
  const pendingRefresh = controller.refresh();
  await controller.logout();
  refresh.resolve(identity({ expiresAt: "2026-11-03T02:00:00.000Z" }));
  await pendingRefresh;
  assert.equal(controller.getSnapshot().phase, "signed-out");
  assert.equal(controller.getSnapshot().identity, null);
  controller.dispose();
});

test("cancel requested during logout joins logout and cannot revive its identity", async () => {
  const logoutRpc = deferred();
  let cancelCalls = 0;
  const controller = new PhotoSessionController(host({
    logout: async () => logoutRpc.promise,
    cancel: async () => { cancelCalls += 1; },
  }), { now: () => NOW });
  await controller.read();
  const loggingOut = controller.logout();
  await Promise.resolve();
  const cancelling = controller.cancel();
  logoutRpc.resolve();
  await loggingOut;
  await cancelling;
  assert.equal(cancelCalls, 0);
  assert.equal(controller.getSnapshot().phase, "signed-out");
  assert.equal(controller.getSnapshot().identity, null);
  controller.dispose();
});

test("cancel is serialized with logout and cannot be superseded by read or refresh", async () => {
  const cancelRpc = deferred();
  const logoutRpc = deferred();
  let readCalls = 0;
  let refreshCalls = 0;
  let cancelSignal;
  const controller = new PhotoSessionController(host({
    read: async () => {
      readCalls += 1;
      return identity();
    },
    refresh: async () => {
      refreshCalls += 1;
      return identity({ expiresAt: "2026-11-03T02:00:00.000Z" });
    },
    cancel: async (signal) => { cancelSignal = signal; return cancelRpc.promise; },
    logout: async () => logoutRpc.promise,
  }), { now: () => NOW });
  await controller.read();
  const cancelling = controller.cancel();
  await Promise.resolve();
  assert.equal(controller.getSnapshot().phase, "cancelling");
  const blockedRead = controller.read();
  const blockedRefresh = controller.refresh();
  const loggingOut = controller.logout();
  assert.equal((await blockedRead).phase, "cancelling");
  assert.equal((await blockedRefresh).phase, "cancelling");
  assert.equal(refreshCalls, 0);
  cancelRpc.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cancelSignal.aborted, false);
  assert.equal(readCalls, 2);
  logoutRpc.resolve();
  await cancelling;
  await loggingOut;
  assert.equal(controller.getSnapshot().phase, "signed-out");
  assert.equal(controller.getSnapshot().identity, null);
  controller.dispose();
});

test("successful cancel revalidates trusted identity; revalidation failure stays closed", async () => {
  let readCalls = 0;
  const controller = new PhotoSessionController(host({
    read: async () => (++readCalls === 1 ? identity() : identity({ sessionEpoch: "synthetic-server-epoch-2" })),
  }), { now: () => NOW });
  await controller.read();
  await controller.cancel();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().identity.sessionEpoch, "synthetic-server-epoch-2");
  controller.dispose();

  let failCalls = 0;
  const failed = new PhotoSessionController(host({
    read: async () => {
      failCalls += 1;
      if (failCalls > 1) throw new PhotoSessionHostError("temporarily-unavailable");
      return identity();
    },
  }), { now: () => NOW });
  await failed.read();
  await failed.cancel();
  assert.equal(failed.getSnapshot().phase, "unavailable");
  assert.equal(failed.getSnapshot().identity.userId, identity().userId);
  assert.equal(failed.getSnapshot().cloudOperationsAvailable, false);
  failed.dispose();
});

test("actual expiry uses injected timers and invalidates the scope without a real wait", async () => {
  let now = NOW;
  const timers = new Map();
  let nextTimer = 0;
  const events = [];
  const controller = new PhotoSessionController(host(), {
    now: () => now,
    setTimer: (callback, milliseconds) => {
      const id = ++nextTimer;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  controller.onEvent((event) => events.push(event));
  await controller.read();
  const timer = [...timers.values()][0];
  assert.equal(timer.milliseconds, 60 * 60 * 1000);
  now = Date.parse(identity().expiresAt);
  timer.callback();
  assert.equal(controller.getSnapshot().phase, "expired");
  assert.equal(events.some((event) => event.type === "scope-invalidated" && event.reason === "expired"), true);
  controller.dispose();
});

test("long expiry timers are capped, re-armed, and stale queued callbacks are fenced", async () => {
  let now = NOW;
  const scheduled = [];
  const longExpiry = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();
  const refreshedExpiry = new Date(NOW + 31 * 24 * 60 * 60 * 1000).toISOString();
  const controller = new PhotoSessionController(host({
    read: async () => identity({ expiresAt: longExpiry }),
    refresh: async () => identity({ expiresAt: refreshedExpiry }),
  }), {
    now: () => now,
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  await controller.read();
  const first = scheduled[0];
  assert.equal(first.milliseconds, 2_147_483_647);
  now += 2_147_483_647;
  first.callback();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].milliseconds, Date.parse(longExpiry) - now);
  now = NOW;
  await controller.refresh();
  first.callback();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().identity.expiresAt, refreshedExpiry);
  controller.dispose();
});

test("snapshots and subscriber values are frozen defensive copies", async () => {
  let published;
  const raw = identity();
  const controller = new PhotoSessionController(host({ read: async () => raw }), { now: () => NOW });
  controller.subscribe((snapshot) => { published = snapshot; });
  await controller.read();
  raw.userId = "mutated-after-read";
  assert.equal(controller.getSnapshot().identity.userId, "synthetic-user-alpha");
  assert.equal(Object.isFrozen(controller.getSnapshot()), true);
  assert.equal(Object.isFrozen(controller.getSnapshot().identity), true);
  assert.throws(() => { published.identity.userId = "subscriber-mutation"; }, TypeError);
  assert.deepEqual(await controller.runCaptured(async ({ identity: captured }) => {
    assert.throws(() => { captured.userId = "task-mutation"; }, TypeError);
    return captured.userId;
  }), { status: "accepted", value: "synthetic-user-alpha" });
  controller.dispose();
});

test("dispose aborts work and fences all late responses", async () => {
  const read = deferred();
  const controller = new PhotoSessionController(host({ read: async () => read.promise }), { now: () => NOW });
  const pending = controller.read();
  controller.dispose();
  read.resolve(identity());
  await pending;
  assert.equal(controller.getSnapshot().phase, "disposed");
  assert.deepEqual(await controller.runCaptured(async () => "unused"), { status: "discarded", reason: "disposed" });
});

test("logout releases captured work waiting on a refresh that ignores abort", async () => {
  const refresh = deferred();
  const work = deferred();
  const controller = new PhotoSessionController(host({ refresh: () => refresh.promise }), { now: () => NOW });
  let verification;
  try {
    await controller.read();
    const operation = controller.runCaptured(() => work.promise);
    verification = controller.refresh();
    work.resolve("old-result");
    await nextTurn();
    await controller.logout();
    const result = await Promise.race([operation, nextTurn().then(() => ({ status: "still-pending" }))]);
    assert.equal(result.status, "discarded");
  } finally {
    refresh.resolve(identity());
    await verification;
    controller.dispose();
  }
});

test("native reader exceptions never expose their underlying message", async () => {
  await assert.rejects(
    readTrustedMacPhotoIdentity(async () => { throw new Error("synthetic-native-sensitive-detail"); }, new AbortController().signal, () => NOW),
    (error) => error instanceof PhotoSessionHostError
      && error.code === "temporarily-unavailable"
      && !String(error).includes("sensitive"),
  );
});
