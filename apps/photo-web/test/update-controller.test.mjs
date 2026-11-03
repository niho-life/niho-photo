import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPhotoPwaUpdateController } from "../src/pwa/update-controller.ts";

const ORIGIN = "https://photo.example";
const BUILD = "d".repeat(64);

class FakeWorker extends EventTarget {
  constructor(scriptURL = `${ORIGIN}/photo-sw.js`) {
    super();
    this.scriptURL = scriptURL;
    this.state = "installed";
    this.messages = [];
  }
  postMessage(message) { this.messages.push(message); }
}

class FakeRegistration extends EventTarget {
  constructor(worker) {
    super();
    this.scope = `${ORIGIN}/`;
    this.waiting = worker;
    this.installing = null;
  }
}

class FakeContainer extends EventTarget { controller = null; }

function setup(canLeave = async () => true) {
  const worker = new FakeWorker();
  const registration = new FakeRegistration(worker);
  const serviceWorker = new FakeContainer();
  let reloads = 0;
  const controller = createPhotoPwaUpdateController({
    registration,
    serviceWorker,
    origin: ORIGIN,
    canLeave,
    reload: () => { reloads += 1; },
  });
  const message = (data, source = worker, ports = []) => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data },
      source: { value: source },
      ports: { value: ports },
    });
    return serviceWorker.dispatchEvent(event);
  };
  const check = async (nonce, buildId = BUILD) => {
    const channel = new MessageChannel();
    const reply = new Promise((resolve) => { channel.port1.onmessage = (event) => resolve(event.data); });
    message({ type: "PHOTO_UPDATE_CHECK", nonce, buildId }, worker, [channel.port2]);
    const value = await reply;
    channel.port1.close();
    return value;
  };
  return { worker, registration, serviceWorker, controller, message, check, reloads: () => reloads };
}

describe("createPhotoPwaUpdateController", () => {
  it("exposes immutable snapshots and deduplicates a double request", async () => {
    const test = setup();
    assert.equal(test.controller.getSnapshot().phase, "available");
    assert.equal(Object.isFrozen(test.controller.getSnapshot()), true);
    const first = test.controller.requestUpdate();
    const second = test.controller.requestUpdate();
    assert.equal(first, second);
    assert.equal(test.worker.messages.length, 1);
    const { nonce } = test.worker.messages[0];
    assert.deepEqual(await test.check(nonce), { nonce, buildId: BUILD, allow: true });
    test.message({ type: "PHOTO_UPDATE_BLOCKED", nonce, buildId: BUILD });
    assert.equal(await first, "blocked");
    test.controller.dispose();
  });

  it("reloads at most once after its own approval and a later controllerchange", async () => {
    const test = setup();
    const result = test.controller.requestUpdate();
    const { nonce } = test.worker.messages[0];
    await test.check(nonce);
    test.worker.state = "activating";
    test.registration.waiting = null;
    test.message({ type: "PHOTO_UPDATE_APPROVED", nonce, buildId: BUILD });
    assert.equal(test.controller.getSnapshot().phase, "activating");
    assert.equal(test.reloads(), 0);
    test.serviceWorker.controller = test.worker;
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(await result, "applied");
    assert.equal(test.reloads(), 1);
    test.controller.dispose();
  });

  it("ignores an unrelated controller and handles its target change before approval", async () => {
    const test = setup();
    const result = test.controller.requestUpdate();
    const { nonce } = test.worker.messages[0];
    await test.check(nonce);
    test.serviceWorker.controller = new FakeWorker();
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    test.worker.state = "activated";
    test.registration.waiting = null;
    test.message({ type: "PHOTO_UPDATE_APPROVED", nonce, buildId: BUILD });
    assert.equal(test.reloads(), 0);
    test.serviceWorker.controller = test.worker;
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(await result, "applied");
    assert.equal(test.reloads(), 1);
    test.controller.dispose();

    const early = setup();
    const earlyResult = early.controller.requestUpdate();
    const earlyNonce = early.worker.messages[0].nonce;
    await early.check(earlyNonce);
    early.serviceWorker.controller = early.worker;
    early.serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(early.reloads(), 0);
    early.worker.state = "activated";
    early.registration.waiting = null;
    early.message({ type: "PHOTO_UPDATE_APPROVED", nonce: earlyNonce, buildId: BUILD });
    assert.equal(await earlyResult, "applied");
    assert.equal(early.reloads(), 1);
    early.controller.dispose();
  });

  it("bounds a never-settling passive guard and denies later checks without retaining more host calls", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const test = setup(() => { calls += 1; return new Promise(() => {}); });
    try {
      const first = test.check("e".repeat(64));
      await Promise.resolve();
      context.mock.timers.tick(15_000);
      assert.equal((await first).allow, false);
      assert.equal((await test.check("f".repeat(64))).allow, false);
      assert.equal(calls, 1);
      assert.equal(test.reloads(), 0);
    } finally {
      test.controller.dispose();
      context.mock.timers.reset();
    }
  });

  it("acknowledges a waiting worker check in a non-requesting window without changing phase or reloading", async () => {
    let guards = 0;
    const test = setup(async () => {
      guards += 1;
      return true;
    });
    const nonce = "e".repeat(64);
    assert.deepEqual(await test.check(nonce), { nonce, buildId: BUILD, allow: true });
    assert.equal(guards, 1);
    assert.equal(test.controller.getSnapshot().phase, "available");
    test.registration.waiting = null;
    test.worker.state = "activated";
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(test.reloads(), 0);
    assert.equal(test.controller.getSnapshot().phase, "up-to-date");
    test.controller.dispose();
  });

  it("fails the guard closed when canLeave returns false or throws", async (context) => {
    for (const [name, guard] of [
      ["false", async () => false],
      ["throw", async () => { throw new Error("guard failed"); }],
    ]) {
      await context.test(name, async () => {
        const test = setup(guard);
        const result = test.controller.requestUpdate();
        const { nonce } = test.worker.messages[0];
        assert.deepEqual(await test.check(nonce), { nonce, buildId: BUILD, allow: false });
        assert.equal(await result, "blocked");
        assert.equal(test.reloads(), 0);
        test.controller.dispose();
      });
    }
  });

  it("ignores spoofed sources and stale approval from a previous attempt", async () => {
    const test = setup();
    const first = test.controller.requestUpdate();
    const firstNonce = test.worker.messages[0].nonce;
    await test.check(firstNonce);
    test.message({ type: "PHOTO_UPDATE_BLOCKED", nonce: firstNonce, buildId: BUILD });
    assert.equal(await first, "blocked");

    const second = test.controller.requestUpdate();
    const secondNonce = test.worker.messages[1].nonce;
    assert.notEqual(secondNonce, firstNonce);
    test.message({ type: "PHOTO_UPDATE_APPROVED", nonce: firstNonce, buildId: BUILD });
    test.message({ type: "PHOTO_UPDATE_APPROVED", nonce: secondNonce, buildId: BUILD }, { scriptURL: `${ORIGIN}/photo-sw.js` });
    assert.equal(test.reloads(), 0);
    await test.check(secondNonce);
    test.message({ type: "PHOTO_UPDATE_BLOCKED", nonce: secondNonce, buildId: BUILD });
    assert.equal(await second, "blocked");
    test.controller.dispose();
  });

  it("dispose fences a late guard and every later activation callback", async () => {
    let settleGuard;
    const guard = new Promise((resolve) => { settleGuard = resolve; });
    const test = setup(() => guard);
    const result = test.controller.requestUpdate();
    const { nonce } = test.worker.messages[0];
    const channel = new MessageChannel();
    test.message({ type: "PHOTO_UPDATE_CHECK", nonce, buildId: BUILD }, test.worker, [channel.port2]);
    test.controller.dispose();
    assert.equal(await result, "failed");
    settleGuard(true);
    await Promise.resolve();
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    test.message({ type: "PHOTO_UPDATE_APPROVED", nonce, buildId: BUILD });
    assert.equal(test.controller.getSnapshot().phase, "disposed");
    assert.equal(test.reloads(), 0);
    channel.port1.close();
  });

  it("fails an attempt if the registration's waiting worker changes before its guard check", async () => {
    const test = setup();
    const result = test.controller.requestUpdate();
    const { nonce } = test.worker.messages[0];
    test.registration.waiting = new FakeWorker();
    const channel = new MessageChannel();
    test.message({ type: "PHOTO_UPDATE_CHECK", nonce, buildId: BUILD }, test.worker, [channel.port2]);
    assert.equal(await result, "failed");
    assert.equal(test.reloads(), 0);
    channel.port1.close();
    test.controller.dispose();
  });

  it("fails safely when there is no waiting worker or the waiting script is cross-origin", async () => {
    const noWorker = setup();
    noWorker.registration.waiting = null;
    assert.equal(await noWorker.controller.requestUpdate(), "failed");
    assert.equal(noWorker.controller.getSnapshot().phase, "up-to-date");
    noWorker.controller.dispose();

    const foreign = setup();
    foreign.registration.waiting = new FakeWorker("https://evil.example/photo-sw.js");
    assert.equal(await foreign.controller.requestUpdate(), "failed");
    assert.equal(foreign.controller.getSnapshot().phase, "failed");
    foreign.controller.dispose();
  });

  it("notifies subscribers of phases and removes them on unsubscribe", async () => {
    const test = setup();
    const phases = [];
    const unsubscribe = test.controller.subscribe((snapshot) => phases.push(snapshot.phase));
    const result = test.controller.requestUpdate();
    const { nonce } = test.worker.messages[0];
    await test.check(nonce);
    test.message({ type: "PHOTO_UPDATE_BLOCKED", nonce, buildId: BUILD });
    assert.equal(await result, "blocked");
    unsubscribe();
    test.controller.dispose();
    assert.deepEqual(phases, ["preparing", "blocked"]);
  });
});
