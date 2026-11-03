import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { createPersonalPhotoCloudLibrary } from "@niho/photo-cloud-sync";
import { IndexedDbRecipeSyncJournal } from "@niho/photo-cloud-sync/browser";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import type { VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PhotoEditingHost } from "niho-photo-editing/library/photo-library-context";
import type { PhotoLibrary, PhotoLibraryNativeExportResult } from "niho-photo-editing/library/photo-library";

import type { PersonalCloudPhotoBinding } from "./App";
import type { CameraCommands } from "./local-library/commands";
import { createLocalPhotoEditingHost } from "./local-library/local-photo-editing-host";
import { readPhotoCloudBuildProof, type PhotoCloudBuildProof } from "./cloud-build-proof";
import { probeCameraPhotoRenderer, type CameraPhotoRendererBinding } from "./camera-photo-renderer";
import { createNativePersonalPhotoCloudClient } from "./native-photo-client";
import { readNativePhotoIdentity, watchNativePhotoIdentity } from "./native-photo-session";
import {
  createMacPersonalCloudPhotoBinding,
  type MacPhotoCloudScope,
} from "./personal-cloud-binding";

type Dispose = () => void;
type IdentityReader = (signal: AbortSignal) => Promise<VerifiedPhotoActor | null>;
type IdentityWatch = typeof watchNativePhotoIdentity;

export type CameraCloudBootstrapSnapshot = Readonly<{ binding?: PersonalCloudPhotoBinding }>;

class ObservableIdentity implements PersonalPhotoCloudIdentity {
  private actor: VerifiedPhotoActor | null = null;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): VerifiedPhotoActor | null { return this.actor; }
  subscribe(listener: () => void): Dispose { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(actor: VerifiedPhotoActor | null): void {
    this.actor = actor === null ? null : Object.freeze({ ...actor });
    for (const listener of this.listeners) listener();
  }
}

export type CameraCloudLiveBinding = Readonly<{ binding: PersonalCloudPhotoBinding; dispose(): void }>;

export type CameraCloudBootstrapOptions = Readonly<{
  commands: CameraCommands;
  proof?: PhotoCloudBuildProof | null;
  readIdentity?: IdentityReader;
  watchIdentity?: IdentityWatch;
  probeRenderer?: typeof probeCameraPhotoRenderer;
  indexedDB?: IDBFactory;
  locks?: LockManager | null;
  invoke?: (command: string, args: { input: unknown }) => Promise<unknown>;
  now?: () => number;
  retryDelay?: (attempt: number) => Promise<void>;
  createBinding?: (input: {
    proof: PhotoCloudBuildProof;
    actor: VerifiedPhotoActor;
    identity: PersonalPhotoCloudIdentity;
    signal: AbortSignal;
  }) => Promise<CameraCloudLiveBinding | null>;
}>;

/** Registration-first native session owner. It is intentionally event/focus driven, never a second one-second poll. */
export class CameraCloudBootstrap {
  private readonly listeners = new Set<(snapshot: CameraCloudBootstrapSnapshot) => void>();
  private readonly identity = new ObservableIdentity();
  private snapshot: CameraCloudBootstrapSnapshot = Object.freeze({});
  private generation = 0;
  private active: CameraCloudLiveBinding | null = null;
  private stopWatch: Dispose | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private disposed = false;
  private started = false;
  private readonly focus = () => this.requestRefresh();

  constructor(private readonly options: CameraCloudBootstrapOptions) {}

  getSnapshot(): CameraCloudBootstrapSnapshot { return this.snapshot; }
  subscribe(listener: (snapshot: CameraCloudBootstrapSnapshot) => void): Dispose {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const proof = this.options.proof === undefined ? readPhotoCloudBuildProof() : this.options.proof;
    if (proof === null) return;
    const registration = ++this.generation;
    try {
      const stop = await (this.options.watchIdentity ?? watchNativePhotoIdentity)({
        invalidated: () => this.invalidate(),
        mayHaveChanged: () => this.requestRefresh(),
      });
      if (this.disposed || registration !== this.generation) { stop(); return; }
      this.stopWatch = stop;
      globalThis.addEventListener?.("focus", this.focus);
      await this.scheduleRefresh(proof);
    } catch {
      if (!this.disposed && registration === this.generation) this.invalidate();
    }
  }

  requestRefresh(): void {
    if (this.disposed || this.stopWatch === null) return;
    const proof = this.options.proof === undefined ? readPhotoCloudBuildProof() : this.options.proof;
    if (proof === null) return;
    if (this.refreshPromise !== null) { this.refreshAgain = true; return; }
    void this.scheduleRefresh(proof).catch(() => undefined);
  }

  private scheduleRefresh(proof: PhotoCloudBuildProof): Promise<void> {
    if (this.refreshPromise !== null) { this.refreshAgain = true; return this.refreshPromise; }
    this.refreshPromise = this.refresh(proof).finally(() => {
      this.refreshPromise = null;
      if (this.refreshAgain) { this.refreshAgain = false; this.requestRefresh(); }
    });
    return this.refreshPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    globalThis.removeEventListener?.("focus", this.focus);
    this.stopWatch?.();
    this.stopWatch = null;
    this.closeActive();
    this.identity.set(null);
    this.listeners.clear();
  }

  private invalidate(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.closeActive();
    this.identity.set(null);
    this.publish(undefined);
  }

  private async refresh(proof: PhotoCloudBuildProof): Promise<void> {
    const read = this.options.readIdentity ?? ((signal) => readNativePhotoIdentity(signal, { now: this.options.now }));
    const controller = new AbortController();
    const captured = ++this.generation;
    let actor: VerifiedPhotoActor | null = null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try { actor = await read(controller.signal); break; }
        catch {
          if (attempt === 2) throw new Error("identity unavailable");
          await (this.options.retryDelay ?? defaultRetryDelay)(attempt);
        }
      }
      if (!this.current(captured)) return;
      if (actor === null) { this.invalidate(); return; }
      const previous = this.identity.getSnapshot();
      if (previous !== null && sameScope(previous, actor) && this.active !== null) {
        this.identity.set(actor); // expiry refresh is observable but keeps the library/client/editor stable.
        return;
      }
      this.closeActive();
      this.identity.set(actor);
      this.publish(undefined);
      const live = this.options.createBinding
        ? await this.options.createBinding({ proof, actor, identity: this.identity, signal: controller.signal })
        : await createLiveBinding({ ...this.options, proof, actor, identity: this.identity, signal: controller.signal });
      if (!this.current(captured) || !sameScope(this.identity.getSnapshot(), actor)) { live?.dispose(); return; }
      if (live === null) { this.identity.set(null); return; }
      this.active = live;
      this.publish(live.binding);
    } catch {
      if (this.current(captured)) this.invalidate();
    } finally {
      controller.abort();
    }
  }

  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private closeActive(): void { const active = this.active; this.active = null; active?.dispose(); }
  private publish(binding: PersonalCloudPhotoBinding | undefined): void {
    if (this.snapshot.binding === binding) return;
    this.snapshot = Object.freeze(binding === undefined ? {} : { binding });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

async function createLiveBinding(options: CameraCloudBootstrapOptions & {
  proof: PhotoCloudBuildProof;
  actor: VerifiedPhotoActor;
  identity: ObservableIdentity;
  signal: AbortSignal;
}): Promise<CameraCloudLiveBinding | null> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
  if (factory === undefined || locks === undefined || locks === null || options.signal.aborted) return null;
  let renderer: CameraPhotoRendererBinding | null = null;
  let client: Awaited<ReturnType<typeof createNativePersonalPhotoCloudClient>> | null = null;
  let libraryHandle: ReturnType<typeof createPersonalPhotoCloudLibrary> | null = null;
  let connection: ReturnType<typeof createMacPersonalCloudPhotoBinding> | null = null;
  const scopeAbort = new AbortController();
  const invoke = options.invoke ?? ((command, args) => tauriInvoke(command, args));
  try {
    renderer = await (options.probeRenderer ?? probeCameraPhotoRenderer)({ proof: options.proof, signal: options.signal });
    if (renderer === null || options.signal.aborted) return null;
    client = await createNativePersonalPhotoCloudClient({ identity: options.identity, invoke, now: options.now });
    if (options.signal.aborted) return null;
    libraryHandle = createPersonalPhotoCloudLibrary({
      client,
      identity: options.identity,
      hostRenderer: renderer.capability,
      engineAssets: renderer.engineAssets,
      presets: cameraPresets(options.commands),
      memoryBudgets: { originalBytes: 96 * 1024 ** 2, workingCopyBytes: 96 * 1024 ** 2, previewBytes: 32 * 1024 ** 2 },
      journal: new IndexedDbRecipeSyncJournal(factory, "niho-camera-personal-photo-recipes-v1"),
      locks,
      ...(options.now === undefined ? {} : { clock: { now: options.now } }),
    });
    const scope = cloudScope(options.actor, client.scope.libraryId);
    const currentScope = (): MacPhotoCloudScope | null => {
      const current = options.identity.getSnapshot();
      return current !== null && sameScope(current, options.actor) ? cloudScope(current, client!.scope.libraryId) : null;
    };
    const library = withNativeOriginalSave(libraryHandle.library, scope, invoke);
    const host = cloudHost(options.commands, scopeAbort.signal, () => sameScope(options.identity.getSnapshot(), options.actor));
    connection = createMacPersonalCloudPhotoBinding({
      scope,
      currentScope,
      subscribeScopeChange: (listener) => options.identity.subscribe(listener),
      library,
      host,
    });
    if (connection.state !== "connected") return null;
    let disposed = false;
    return {
      // Native upload stays absent until the native start/status/cancel authority is installed.
      // The read/edit library remains usable; App will not render a copy operation for this binding.
      binding: {
        library: connection.binding.library,
        host: connection.binding.host,
        actorId: connection.binding.actorId,
        scopeKey: connection.binding.scopeKey,
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        scopeAbort.abort();
        connection?.dispose();
        libraryHandle?.dispose();
        client?.dispose();
      },
    };
  } catch {
    return null;
  } finally {
    if (connection?.state !== "connected") {
      scopeAbort.abort();
      connection?.dispose();
      libraryHandle?.dispose();
      client?.dispose();
    }
  }
}

export function withNativeOriginalSave(
  library: PhotoLibrary,
  scope: MacPhotoCloudScope,
  invoke: (command: string, args: { input: unknown }) => Promise<unknown>,
): PhotoLibrary {
  return {
    ...library,
    async saveOriginalNative(photo, requestOptions): Promise<PhotoLibraryNativeExportResult> {
      if (requestOptions?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const safePhoto = { id: photo.id, fileName: photo.fileName, sizeBytes: photo.sizeBytes, hasOriginal: photo.hasOriginal };
      const result = await abortable(
        invoke("camera_photo_original_save", { input: { scope: nativeScope(scope), photo: safePhoto } }),
        requestOptions?.signal,
      );
      if (!record(result) || !exactKeys(result, result.saved === false ? ["saved"] : ["saved", "fileName"])
        || typeof result.saved !== "boolean" || result.saved && !plainFileName(result.fileName)) throw new Error("invalid native save result");
      return result.saved ? { saved: true, fileName: result.fileName as string } : { saved: false, fileName: null };
    },
  };
}

function cloudHost(commands: CameraCommands, signal: AbortSignal, current: () => boolean): PhotoEditingHost {
  return { ...createLocalPhotoEditingHost(commands), scopeSignal: signal, isScopeCurrent: current };
}

function cameraPresets(commands: CameraCommands): PhotoLibrary["presets"] {
  return {
    list: () => commands.listPresets(),
    create: ({ name, xmp, source }) => commands.createPreset(name, xmp, source ?? "xmp"),
    rename: (id, name) => commands.renamePreset(id, name),
    delete: (id) => commands.deletePreset(id),
    nameMaxChars: 100,
    xmpMaxBytes: 512 * 1024,
    describeError: (_error, fallback) => fallback,
    isNameTaken: () => false,
  };
}

function cloudScope(actor: VerifiedPhotoActor, libraryId: string): MacPhotoCloudScope {
  if (actor.transport !== "mac-bearer") throw new Error("invalid identity transport");
  return { actorId: actor.userId, libraryId, sessionId: actor.sessionId, sessionEpoch: actor.sessionEpoch, transport: actor.transport };
}
function nativeScope(scope: MacPhotoCloudScope) { return { userId: scope.actorId, sessionId: scope.sessionId, sessionEpoch: scope.sessionEpoch, transport: scope.transport }; }
function sameScope(left: VerifiedPhotoActor | null, right: VerifiedPhotoActor): boolean {
  return left !== null && left.userId === right.userId && left.sessionId === right.sessionId
    && left.sessionEpoch === right.sessionEpoch && left.transport === right.transport;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
function opaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value); }
function plainFileName(value: unknown): value is string { return opaque(value) && new TextEncoder().encode(value).byteLength <= 255 && !/[\\/:]/u.test(value) && !value.startsWith("."); }
function defaultRetryDelay(attempt: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 200 : 800)); }
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
