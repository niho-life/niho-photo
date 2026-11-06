import { describe, expect, it, vi } from "vitest";

import type { Invoke, Listen } from "../camera-bridge";
import { startMacHostedConnector } from "./mac-hosted-connector";
import {
  HOSTED_POWER_EVENT,
  createNativePower,
  createNativeRootFileSystem,
  createNativeVault,
  readRegisteredRoots,
  runHostedConnectorLoop,
  watchHostedPower,
} from "./native-ports";

type Call = { command: string; args?: Record<string, unknown> };

/** native のコマンドを真似る（呼ばれた順に記録し、答えは表から返す）。 */
function fakeInvoke(answers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    const answer = answers[command];
    if (!answer) throw Object.assign(new Error("not allowed"), { code: "notAllowed" });
    return answer(args);
  }) as Invoke;
  return { invoke, calls };
}

const signal = new AbortController().signal;
const ROOT = { id: "root-synthetic" };
const ENTRY = { name: "a.jpg", kind: "file", sizeBytes: 6, mtimeMs: 1.5, fileId: "1:2", changeToken: "3:4" };

describe("vault", () => {
  it("reads an empty vault before the first pairing and writes the whole contents as one JSON item", async () => {
    let stored: string | null = null;
    const { invoke, calls } = fakeInvoke({
      camera_hosted_connector_vault_read: () => stored,
      camera_hosted_connector_vault_write: (args) => {
        stored = (args?.request as { contents: string }).contents;
      },
    });
    const vault = createNativeVault(invoke);
    expect(await vault.read()).toEqual({ installSalt: null, credential: null, pairing: null, rotation: null });
    const next = { installSalt: "salt", credential: { secret: "synthetic", generation: 1, connectorId: "c", libraryId: "l" }, pairing: null, rotation: null };
    await vault.write(next);
    expect(await vault.read()).toEqual(next);
    expect(calls.map((call) => call.command)).toEqual([
      "camera_hosted_connector_vault_read",
      "camera_hosted_connector_vault_write",
      "camera_hosted_connector_vault_read",
    ]);
  });

  it("refuses a vault that is not an object instead of treating it as empty", async () => {
    const { invoke } = fakeInvoke({ camera_hosted_connector_vault_read: () => "[]" });
    await expect(createNativeVault(invoke).read()).rejects.toThrow();
  });
});

describe("root file system", () => {
  it("passes only root IDs and relative paths, streams a file until an empty chunk and closes it once", async () => {
    const chunks = [new Uint8Array([1, 2, 3]).buffer, new Uint8Array([4, 5, 6]).buffer, new ArrayBuffer(0)];
    const { invoke, calls } = fakeInvoke({
      camera_hosted_connector_roots: () => [{ id: ROOT.id, name: "never forwarded" }, { nope: true }],
      camera_hosted_connector_root_status: () => "available",
      camera_hosted_connector_list: () => [ENTRY],
      camera_hosted_connector_stat: () => null,
      camera_hosted_connector_open: () => ({ handle: 7, entry: ENTRY }),
      camera_hosted_connector_read: () => chunks.shift(),
      camera_hosted_connector_close: () => undefined,
    });
    expect(await readRegisteredRoots(invoke)).toEqual([ROOT]);
    const fs = createNativeRootFileSystem(invoke);
    expect(await fs.rootStatus(ROOT, signal)).toBe("available");
    expect(await fs.list(ROOT, "2026", signal)).toEqual([ENTRY]);
    expect(await fs.stat(ROOT, "2026/gone.jpg", signal)).toBeNull();
    const file = await fs.open(ROOT, "2026/a.jpg", signal);
    expect({ sizeBytes: file.sizeBytes, fileId: file.fileId, changeToken: file.changeToken }).toEqual({ sizeBytes: 6, fileId: "1:2", changeToken: "3:4" });
    const read: number[] = [];
    for await (const chunk of file.read(signal)) read.push(...chunk);
    expect(read).toEqual([1, 2, 3, 4, 5, 6]);
    await file.close();
    await file.close();
    expect(calls.filter((call) => call.command === "camera_hosted_connector_close")).toHaveLength(1);
    expect(calls.find((call) => call.command === "camera_hosted_connector_open")?.args).toEqual({ request: { rootId: ROOT.id, path: "2026/a.jpg" } });
    for (const call of calls) expect(JSON.stringify(call.args ?? {})).not.toMatch(/\/Users\/|\/Volumes\//);
  });

  it("hashes natively and keeps nothing when the native side saw another identity", async () => {
    const outcomes = [{ outcome: "hashed", sha256: "a".repeat(64), bytes: 6 }, { outcome: "changed" }];
    const { invoke, calls } = fakeInvoke({ camera_hosted_connector_hash: () => outcomes.shift() });
    const fs = createNativeRootFileSystem(invoke);
    const expected = { sizeBytes: 6, fileId: "1:2", changeToken: "3:4" };
    expect(await fs.hash?.(ROOT, "a.jpg", { ...expected, name: "extra fields are not sent" } as typeof expected, signal)).toEqual({ sha256: "a".repeat(64), bytes: 6 });
    expect(await fs.hash?.(ROOT, "a.jpg", expected, signal)).toBeNull();
    expect(calls[0]?.args).toEqual({ request: { rootId: ROOT.id, path: "a.jpg", expected } });
  });

  it("stops reading when the job is aborted", async () => {
    const { invoke } = fakeInvoke({
      camera_hosted_connector_open: () => ({ handle: 1, entry: ENTRY }),
      camera_hosted_connector_read: () => new Uint8Array([1]).buffer,
      camera_hosted_connector_close: () => undefined,
    });
    const file = await createNativeRootFileSystem(invoke).open(ROOT, "a.jpg", signal);
    const controller = new AbortController();
    controller.abort();
    await expect(file.read(controller.signal)[Symbol.asyncIterator]().next()).rejects.toThrow();
  });
});

describe("power", () => {
  it("holds idle sleep for work, releases it once, and keeps working when it cannot hold", async () => {
    const { invoke, calls } = fakeInvoke({
      camera_hosted_connector_power_hold: () => ({ holdId: 3 }),
      camera_hosted_connector_power_release: () => undefined,
    });
    const hold = await createNativePower(invoke).hold("jobs");
    await hold.release();
    await hold.release();
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ["camera_hosted_connector_power_hold", { request: { reason: "jobs" } }],
      ["camera_hosted_connector_power_release", { request: { holdId: 3 } }],
    ]);
    const refused = fakeInvoke({});
    const none = await createNativePower(refused.invoke).hold("scan");
    await none.release();
    expect(refused.calls.map((call) => call.command)).toEqual(["camera_hosted_connector_power_hold"]);
  });

  it("answers the sleep notice after the connector told NIHO it sleeps, and passes wake on", async () => {
    const listener: { handler: ((event: { payload: unknown }) => void) | null } = { handler: null };
    const listen = (async (event: string, next: (event: { payload: unknown }) => void) => {
      expect(event).toBe(HOSTED_POWER_EVENT);
      listener.handler = next;
      return () => {
        listener.handler = null;
      };
    }) as Listen;
    const send = (payload: unknown) => listener.handler?.({ payload });
    const order: string[] = [];
    const { invoke } = fakeInvoke({ camera_hosted_connector_sleep_ready: () => order.push("ready") });
    const unlisten = await watchHostedPower(listen, invoke, {
      willSleep: async () => {
        order.push("sleeping sent");
      },
      didWake: async () => {
        order.push("woke");
      },
    });
    send({ state: "willSleep" });
    send({ state: "didWake" });
    send({ state: "unknown" });
    await vi.waitFor(() => expect(order).toEqual(["sleeping sent", "woke", "ready"]));
    unlisten();
    expect(listener.handler).toBeNull();
  });
});

describe("loop", () => {
  it("ticks, stops the running tick before sleep, skips ticks while asleep and resumes at once after wake", async () => {
    const ticks: AbortSignal[] = [];
    const steps: Array<() => void> = [];
    const connector = {
      tick: vi.fn(async (tickSignal: AbortSignal) => {
        ticks.push(tickSignal);
        return { phase: "active" as const };
      }),
      willSleep: vi.fn(async () => undefined),
      didWake: vi.fn(async () => undefined),
    };
    const loop = runHostedConnectorLoop({
      connector,
      intervalMs: 1_000,
      sleep: (_ms, pause) =>
        new Promise<void>((resolve) => {
          steps.push(resolve);
          pause.addEventListener("abort", () => resolve(), { once: true });
        }),
    });
    await vi.waitFor(() => expect(connector.tick).toHaveBeenCalledTimes(1));
    await loop.power.willSleep();
    expect(ticks[0]?.aborted).toBe(true);
    expect(connector.willSleep).toHaveBeenCalledTimes(1);
    steps.shift()?.();
    await vi.waitFor(() => expect(steps).toHaveLength(1));
    expect(connector.tick).toHaveBeenCalledTimes(1);
    await loop.power.didWake();
    await vi.waitFor(() => expect(connector.tick).toHaveBeenCalledTimes(2));
    expect(ticks[1]?.aborted).toBe(false);
    loop.stop();
    await loop.done;
  });

  it("keeps going after a failed tick", async () => {
    let calls = 0;
    const loop = runHostedConnectorLoop({
      connector: {
        tick: async () => {
          calls++;
          if (calls === 1) throw new Error("offline");
          return { phase: "active" as const };
        },
        willSleep: async () => undefined,
        didWake: async () => undefined,
      },
      intervalMs: 1,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
    await vi.waitFor(() => expect(calls).toBeGreaterThan(2));
    loop.stop();
    await loop.done;
  });
});

describe("start", () => {
  it("does nothing without a trusted runtime (the public build has no connection target)", async () => {
    const { invoke, calls } = fakeInvoke({});
    const listen = vi.fn() as unknown as Listen;
    expect(await startMacHostedConnector({ invoke, listen, runtime: null })).toEqual({ state: "notConfigured" });
    expect(calls).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
  });

  it("does not start without registered folders", async () => {
    const { invoke } = fakeInvoke({ camera_hosted_connector_roots: () => [] });
    const runtime = { transport: () => ({ request: vi.fn() }), index: {}, replica: {}, executors: {}, uploader: { put: vi.fn() } };
    const started = await startMacHostedConnector({
      invoke,
      listen: vi.fn() as unknown as Listen,
      runtime: runtime as unknown as Parameters<typeof startMacHostedConnector>[0]["runtime"],
    });
    expect(started).toEqual({ state: "noFolders" });
  });
});
