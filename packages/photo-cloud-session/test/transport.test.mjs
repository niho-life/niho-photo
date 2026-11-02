import assert from "node:assert/strict";
import test from "node:test";

import { ProducerRequestError, ProducerTransport } from "../src/server/transport.ts";

function timerHarness() {
  let callback;
  return {
    setTimer(next) { callback = next; return 1; },
    clearTimer() {},
    fire() { assert.ok(callback); callback(); },
  };
}

test("producer transport timeout aborts the fetch without exposing its exception", async () => {
  const timers = timerHarness();
  const transport = new ProducerTransport({
    origin: "https://niho.life",
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("synthetic-sensitive-network-error")), { once: true });
    }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const pending = transport.post("/synthetic/timeout", { synthetic: true });
  timers.fire();
  await assert.rejects(pending, (error) => error instanceof ProducerRequestError
    && error.kind === "unavailable"
    && !error.message.includes("sensitive"));
});

test("producer transport timeout settles when fetch ignores AbortSignal, and pre-abort skips fetch", async () => {
  const timers = timerHarness();
  let calls = 0;
  const transport = new ProducerTransport({
    origin: "https://niho.life",
    fetch: async () => {
      calls += 1;
      return new Promise(() => {});
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const pending = transport.post("/synthetic/ignored-abort", {});
  timers.fire();
  await assert.rejects(pending, (error) => error instanceof ProducerRequestError && error.status === 503);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    transport.post("/synthetic/pre-abort", {}, controller.signal),
    (error) => error instanceof ProducerRequestError && error.status === 503,
  );
  assert.equal(calls, 1);
});

test("caller abort remains active while the response body is being read", async () => {
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const transport = new ProducerTransport({
    origin: "https://niho.life",
    fetch: async () => new Response(stream, { headers: { "content-type": "application/json" } }),
  });
  const controller = new AbortController();
  const pending = transport.post("/synthetic/body", { synthetic: true }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof ProducerRequestError && error.kind === "unavailable");
});

test("producer response is capped at 16KiB by declared and streamed size", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "16385" } }),
    new Response(JSON.stringify({ value: "x".repeat(17_000) }), { headers: { "content-type": "application/json" } }),
  ]) {
    const transport = new ProducerTransport({
      origin: "https://niho.life",
      fetch: async () => response,
    });
    await assert.rejects(
      transport.post("/synthetic/large", {}),
      (error) => error instanceof ProducerRequestError && error.status === 502,
    );
  }
});

test("producer transport requires JSON and maps rejection without reading or echoing its body", async () => {
  const transport = new ProducerTransport({
    origin: "https://niho.life",
    fetch: async () => new Response("synthetic-secret-body", {
      status: 401,
      headers: { "content-type": "text/plain" },
    }),
  });
  await assert.rejects(
    transport.post("/synthetic/rejected", {}),
    (error) => error instanceof ProducerRequestError
      && error.kind === "rejected"
      && error.status === 401
      && !error.message.includes("secret"),
  );
});

test("stalled error-body cancellation never delays the sanitized response", async () => {
  let cancelCalled = false;
  const body = new ReadableStream({
    cancel() {
      cancelCalled = true;
      return new Promise(() => {});
    },
  });
  const transport = new ProducerTransport({
    origin: "https://niho.life",
    fetch: async () => new Response(body, { status: 503, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    transport.post("/synthetic/stalled-cancel", {}),
    (error) => error instanceof ProducerRequestError && error.kind === "unavailable" && error.status === 503,
  );
  assert.equal(cancelCalled, true);
});
