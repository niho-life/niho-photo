import { describe, expect, it, vi } from "vitest";
import { IDS, responses } from "@niho/photo-personal-cloud-contract/fixtures";

import type { PersonalCloudPhotoBinding } from "./App";
import { CameraCloudBootstrap } from "./camera-cloud-bootstrap";
import type { NativePhotoIdentityWatch } from "./native-photo-session";

// Isolate bootstrap lifetimes; the real C03 journal and native uploader have their own integration suites.
vi.mock("@niho/photo-cloud-sync", () => ({
  createPersonalPhotoCloudLibrary(options: { maskSurfaceValidator?: { validateMaskSurface(png: Uint8Array): Promise<unknown> } }) {
    return {
      library: { place: "cloud", saveMaskSurface: (_photoId: string, png: Uint8Array) => options.maskSurfaceValidator!.validateMaskSurface(png) },
      dispose() {},
    };
  },
}));

const proof = {
  sdkVersion: "14.0.0",
  crateVersion: "0.27.0",
  manifestSha256: "a".repeat(64),
  sdkSourceCommit: "b".repeat(40),
};
const actor = {
  userId: "user-a", sessionId: "session-a", sessionEpoch: "epoch-a", transport: "mac-bearer" as const,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};
const commands = {} as never;
const binding = { actorId: actor.userId, library: { place: "cloud" }, host: {} } as PersonalCloudPhotoBinding;

function harness(readIdentity = vi.fn(async () => actor)) {
  const watch: { current: NativePhotoIdentityWatch | null } = { current: null };
  const disposeBinding = vi.fn();
  const createBinding = vi.fn(async () => ({ binding, dispose: disposeBinding }));
  const bootstrap = new CameraCloudBootstrap({
    commands, proof, readIdentity,
    watchIdentity: async (next) => { watch.current = next; return () => undefined; },
    createBinding,
    retryDelay: async () => undefined,
  });
  return { bootstrap, readIdentity, createBinding, disposeBinding, watch: () => watch.current };
}

describe("Camera cloud bootstrap", () => {
  it("keeps mask validation alive after startup and aborts it when the live binding is disposed", async () => {
    const validateMaskSurface = vi.fn(async (_png: Uint8Array, signal: AbortSignal) => {
      signal.throwIfAborted();
      return { id: "c".repeat(64), width: 1, height: 1 };
    });
    const dispose = vi.fn();
    const bootstrap = new CameraCloudBootstrap({
      commands, proof, indexedDB: {} as IDBFactory, locks: {} as LockManager,
      readIdentity: async () => ({ ...actor, userId: IDS.userA }),
      watchIdentity: async () => () => undefined,
      probeRenderer: async () => ({
        capability: responses["library.get"].capabilities.renderer,
        engineAssets: { manifestUrl: () => "tauri://localhost/develop-engine/manifest.json" },
      }),
      invoke: async () => ({ status: 200, body: responses["library.get"] }),
      createMaskValidator: () => ({ ready: async () => true, validateMaskSurface, dispose }),
    });
    await bootstrap.start();
    const live = bootstrap.getSnapshot().binding;
    expect(live).toBeDefined();
    await expect(live!.library.saveMaskSurface!(IDS.photo, new Uint8Array([1]))).resolves.toMatchObject({ width: 1 });
    bootstrap.dispose();
    await expect(live!.library.saveMaskSurface!(IDS.photo, new Uint8Array([1]))).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledOnce();
  });

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
    const watch: { current: NativePhotoIdentityWatch | null } = { current: null };
    const published: Array<PersonalCloudPhotoBinding | undefined> = [];
    const bootstrap = new CameraCloudBootstrap({
      commands, proof,
      watchIdentity: async (next) => { watch.current = next; return () => undefined; },
      readIdentity: async () => reads.shift() ?? actorB,
      createBinding: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
        .mockResolvedValueOnce({ binding: secondBinding, dispose() {} }),
    });
    bootstrap.subscribe((snapshot) => published.push(snapshot.binding));
    const starting = bootstrap.start();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    watch.current?.invalidated();
    watch.current?.mayHaveChanged();
    finish({ binding, dispose: firstDisposed });
    await starting;
    await vi.waitFor(() => expect(bootstrap.getSnapshot().binding).toBe(secondBinding));
    expect(published).not.toContain(binding);
    expect(firstDisposed).toHaveBeenCalledTimes(1);
    bootstrap.dispose();
  });

  it("updates same-tuple expiry without rebuilding or changing the binding", async () => {
    const refreshed = { ...actor, expiresAt: new Date(Date.parse(actor.expiresAt) + 86_400_000).toISOString() };
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

  it("rebuilds scopes when the same-tuple identity is refreshed after expiry", async () => {
    let now = Date.parse(actor.expiresAt) - 1_000;
    const watch: { current: NativePhotoIdentityWatch | null } = { current: null };
    const refreshed = { ...actor, expiresAt: new Date(Date.parse(actor.expiresAt) + 86_400_000).toISOString() };
    const reads = [actor, refreshed];
    const replacement: PersonalCloudPhotoBinding = { ...binding };
    const firstDispose = vi.fn();
    const createBinding = vi.fn()
      .mockResolvedValueOnce({ binding, dispose: firstDispose })
      .mockResolvedValueOnce({ binding: replacement, dispose: vi.fn() });
    const readIdentity = vi.fn(async () => reads.shift() ?? refreshed);
    const bootstrap = new CameraCloudBootstrap({
      commands, proof,
      readIdentity,
      now: () => now,
      watchIdentity: async (next) => { watch.current = next; return () => undefined; },
      createBinding,
      retryDelay: async () => undefined,
    });

    await bootstrap.start();
    expect(bootstrap.getSnapshot().binding).toBe(binding);
    now = Date.parse(actor.expiresAt) + 1;
    watch.current?.mayHaveChanged();
    await vi.waitFor(() => expect(createBinding).toHaveBeenCalledTimes(2));

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(bootstrap.getSnapshot().binding).toBe(replacement);
    bootstrap.dispose();
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
