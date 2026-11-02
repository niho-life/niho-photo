import assert from "node:assert/strict";
import test from "node:test";

import {
  PhotoSessionHostError,
  createBrowserPhotoSessionHost,
} from "../src/index.ts";

const IDENTITY = {
  userId: "synthetic-user-alpha",
  sessionId: "synthetic-parent-session-alpha",
  sessionEpoch: "synthetic-server-epoch-1",
  transport: "browser-session",
  expiresAt: "2026-11-03T01:00:00.000Z",
};
const NOW = Date.parse("2026-11-03T00:00:00.000Z");

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("browser host uses fixed same-origin routes and returns identity metadata only", async () => {
  const calls = [];
  const bridge = createBrowserPhotoSessionHost({
    now: () => NOW,
    fetch: async (path, init) => {
      calls.push({ path, init });
      if (path === "/auth/session" || path === "/auth/refresh") return json(IDENTITY);
      return new Response(null, { status: 204 });
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await bridge.read(signal), IDENTITY);
  assert.deepEqual(await bridge.refresh(signal), IDENTITY);
  await bridge.logout(signal);
  await bridge.cancel(signal);
  assert.deepEqual(calls.map((call) => [call.path, call.init.method]), [
    ["/auth/session", "GET"],
    ["/auth/refresh", "POST"],
    ["/auth/logout", "POST"],
    ["/auth/cancel", "POST"],
  ]);
  assert.equal(calls.every((call) => call.init.cache === "no-store" && call.init.redirect === "error"), true);
});

test("browser host maps unauthenticated read to null and sanitizes mutation failures", async () => {
  const bridge = createBrowserPhotoSessionHost({
    now: () => NOW,
    fetch: async (path) => path === "/auth/session"
      ? json({ sensitive: "must-not-surface" }, 401)
      : json({ sensitive: "must-not-surface" }, 503),
  });
  const signal = new AbortController().signal;
  assert.equal(await bridge.read(signal), null);
  await assert.rejects(
    bridge.logout(signal),
    (error) => error instanceof PhotoSessionHostError
      && error.code === "temporarily-unavailable"
      && !error.message.includes("sensitive"),
  );
});

test("browser host abort fences a response body even if the supplied fetch ignores the signal", async () => {
  const bridge = createBrowserPhotoSessionHost({
    now: () => NOW,
    fetch: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
      headers: { "content-type": "application/json" },
    }),
  });
  const controller = new AbortController();
  const pending = bridge.read(controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof PhotoSessionHostError && error.code === "cancelled",
  );
});

test("browser host rejects native transport and unknown profile claims", async () => {
  for (const value of [
    { ...IDENTITY, transport: "mac-bearer" },
    { ...IDENTITY, email: "nobody@example.invalid" },
  ]) {
    const bridge = createBrowserPhotoSessionHost({
      now: () => NOW,
      fetch: async () => json(value),
    });
    await assert.rejects(
      bridge.read(new AbortController().signal),
      (error) => error instanceof PhotoSessionHostError && error.code === "invalid-response",
    );
  }
});

test("browser host timeout and pre-abort settle even when fetch ignores AbortSignal", async () => {
  let fire;
  let calls = 0;
  const bridge = createBrowserPhotoSessionHost({
    now: () => NOW,
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
    setTimer: (callback, milliseconds) => {
      assert.equal(milliseconds, 10_000);
      fire = callback;
      return 1;
    },
    clearTimer: () => {},
  });
  const pending = bridge.read(new AbortController().signal);
  fire();
  await assert.rejects(
    pending,
    (error) => error instanceof PhotoSessionHostError && error.code === "temporarily-unavailable",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    bridge.read(controller.signal),
    (error) => error instanceof PhotoSessionHostError && error.code === "cancelled",
  );
  assert.equal(calls, 1);
});

test("browser host returns no metadata after abort even when fetch and body ignore it", async () => {
  let release;
  const body = new ReadableStream({
    start(controller) {
      release = () => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(IDENTITY)));
        controller.close();
      };
    },
  });
  const bridge = createBrowserPhotoSessionHost({
    now: () => NOW,
    fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  const controller = new AbortController();
  const pending = bridge.read(controller.signal);
  await Promise.resolve();
  controller.abort();
  release();
  await assert.rejects(
    pending,
    (error) => error instanceof PhotoSessionHostError && error.code === "cancelled",
  );
});
