import { describe, expect, it, vi } from "vitest";

import type { PersonalCloudPhotoBinding } from "./App";
import { CameraCloudBootstrap } from "./camera-cloud-bootstrap";
import type { NativePhotoIdentityWatch } from "./native-photo-session";

const proof = {
  sdkVersion: "14.0.0",
  crateVersion: "0.27.0",
  manifestSha256: "a".repeat(64),
  sdkSourceCommit: "b".repeat(40),
};
const actor = {
  userId: "user-a", sessionId: "session-a", sessionEpoch: "epoch-a", transport: "mac-bearer" as const,
  expiresAt: "2026-11-05T00:00:00.000Z",
};
const commands = {} as never;
const binding = { actorId: actor.userId, library: { place: "cloud" }, host: {} } as PersonalCloudPhotoBinding;

function harness(readIdentity = vi.fn(async () => actor)) {
  let watch: NativePhotoIdentityWatch | null = null;
  const disposeBinding = vi.fn();
  const createBinding = vi.fn(async () => ({ binding, dispose: disposeBinding }));
  const bootstrap = new CameraCloudBootstrap({
    commands, proof, readIdentity,
    watchIdentity: async (next) => { watch = next; return vi.fn<() => void>(); },
    createBinding,
    retryDelay: async () => undefined,
  });
  return { bootstrap, readIdentity, createBinding, disposeBinding, watch: () => watch };
}

describe("Camera cloud bootstrap", () => {
  it("registers invalidation before the first native read", async () => {
    const order: string[] = [];
    const bootstrap = new CameraCloudBootstrap({
      commands, proof,
      watchIdentity: async () => { order.push("watch"); return () => undefined; },
      readIdentity: async () => { order.push("read"); return actor; },
      createBinding: async () => ({ binding, dispose() {} }),
    });
    await bootstrap.start();
    expect(order).toEqual(["watch", "read"]);
    expect(bootstrap.getSnapshot().binding).toBe(binding);
    bootstrap.dispose();
  });

  it("never publishes a late actor A binding after invalidation and actor B refresh", async () => {
    let finish!: (value: { binding: PersonalCloudPhotoBinding; dispose(): void }) => void;
    const firstDisposed = vi.fn();
    const secondBinding = { ...binding, actorId: "user-b" };
    const actorB = { ...actor, userId: "user-b", sessionId: "session-b", sessionEpoch: "epoch-b" };
    const reads = [actor, actorB];
    let watch: NativePhotoIdentityWatch | null = null;
    const currentWatch = (): NativePhotoIdentityWatch | null => watch;
    const published: Array<PersonalCloudPhotoBinding | undefined> = [];
    const bootstrap = new CameraCloudBootstrap({
      commands, proof,
      watchIdentity: async (next) => { watch = next; return () => undefined; },
      readIdentity: async () => reads.shift() ?? actorB,
      createBinding: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
        .mockResolvedValueOnce({ binding: secondBinding, dispose() {} }),
    });
    bootstrap.subscribe((snapshot) => published.push(snapshot.binding));
    const starting = bootstrap.start();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    currentWatch()?.invalidated();
    currentWatch()?.mayHaveChanged();
    finish({ binding, dispose: firstDisposed });
    await starting;
    await vi.waitFor(() => expect(bootstrap.getSnapshot().binding).toBe(secondBinding));
    expect(published).not.toContain(binding);
    expect(firstDisposed).toHaveBeenCalledTimes(1);
    bootstrap.dispose();
  });

  it("updates same-tuple expiry without rebuilding or changing the binding", async () => {
    const refreshed = { ...actor, expiresAt: "2026-11-06T00:00:00.000Z" };
    const reads = [actor, refreshed];
    const h = harness(vi.fn(async () => reads.shift() ?? refreshed));
    await h.bootstrap.start();
    const original = h.bootstrap.getSnapshot().binding;
    h.watch()?.mayHaveChanged();
    await vi.waitFor(() => expect(h.readIdentity).toHaveBeenCalledTimes(2));
    expect(h.bootstrap.getSnapshot().binding).toBe(original);
    expect(h.createBinding).toHaveBeenCalledTimes(1);
    expect(h.disposeBinding).not.toHaveBeenCalled();
    h.bootstrap.dispose();
  });

  it("coalesces changes received during the registration-first initial read", async () => {
    let finishRead!: (value: typeof actor) => void;
    let reads = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    const readIdentity = vi.fn(async () => {
      reads += 1;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (reads === 1) await new Promise<typeof actor>((resolve) => { finishRead = resolve; });
      inFlight -= 1;
      return actor;
    });
    const h = harness(readIdentity);
    const starting = h.bootstrap.start();
    await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
    h.watch()?.mayHaveChanged();
    h.watch()?.mayHaveChanged();
    expect(readIdentity).toHaveBeenCalledTimes(1);
    finishRead(actor);
    await starting;
    await vi.waitFor(() => expect(readIdentity).toHaveBeenCalledTimes(2));
    expect(maximumInFlight).toBe(1);
    h.bootstrap.dispose();
  });

  it("stays local-only without a build proof and never registers or reads native identity", async () => {
    const watchIdentity = vi.fn();
    const readIdentity = vi.fn();
    const bootstrap = new CameraCloudBootstrap({ commands, proof: null, watchIdentity, readIdentity });
    await bootstrap.start();
    expect(bootstrap.getSnapshot()).toEqual({});
    expect(watchIdentity).not.toHaveBeenCalled();
    expect(readIdentity).not.toHaveBeenCalled();
  });
});
