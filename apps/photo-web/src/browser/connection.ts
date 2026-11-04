import type {
  PersonalPhotoCloudClient,
  PersonalPhotoLibrary,
  Photo,
  PhotoOperation,
  PhotoOperationMap,
  PhotoRequestOptions,
} from "@niho/photo-personal-cloud-contract";
import { isCurrentCloudPreview } from "@niho/photo-cloud-media";
import { readVerifiedMediaAsset } from "@niho/photo-cloud-media/browser";
import type { PhotoIdentity, PhotoSessionController } from "@niho/photo-cloud-session";
import type { FormatCapability, QuotaUsage } from "@niho/photo-personal-cloud-contract";
import { samePhotoIdentityScope } from "@niho/photo-cloud-session";
import type { PhotoLibrary, PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import type { PhotoWebTransferCopy, PhotoWebTransferBinding, PhotoWebViewBinding } from "../view/types.ts";
import type { ScopedPhotoWebEditingHost, PhotoWebConnection, PhotoWebRuntimeGuards } from "../runtime/types.ts";
import {
  createBrowserPersonalPhotoCloudClient,
  createBrowserPersonalPhotoTransferController,
  type BrowserPersonalPhotoTransferController,
  type PersonalPhotoTransferStatus,
} from "@niho/photo-cloud-library/browser";
import type { PersonalPhotoCloudLibraryHandle, PersonalPhotoCloudMemoryBudgets } from "@niho/photo-cloud-library";
import { rendererIntersection } from "@niho/photo-cloud-library/protocol";
import { createPersonalPhotoCloudLibrary as createSynchronizedPhotoLibrary } from "@niho/photo-cloud-sync";
import { IndexedDbRecipeSyncJournal } from "@niho/photo-cloud-sync/browser";
import type { RecipeSyncLocks } from "@niho/photo-cloud-sync";
import { createPhotoWebCloudFetch } from "./auth-fetch.ts";
import { createCapturedPhotoWebCloudClient, createPhotoWebCloudIdentity } from "./session-client.ts";
import {
  createPhotoWebMaskSurfaceValidator,
  probePhotoWebRenderer,
  type PhotoWebMaskSurfaceValidator,
  type PhotoWebRendererProof,
} from "./renderer.ts";

export type PhotoWebRevocationReason = "identity-changed" | "revoked" | "logout-complete" | "expired";

export interface CreatePhotoWebConnectionFactoryOptions {
  readonly origin: string;
  /** Exact SDK proof embedded by the static build; it is never read from a mutable endpoint. */
  readonly rendererProof: PhotoWebRendererProof;
  /** C00's existing preset owner is required. Missing cloud support must fail closed. */
  readonly presets: PhotoLibraryPresets;
  /** C08's accepted budgets; no browser-memory default is inferred here. */
  readonly memoryBudgets: PersonalPhotoCloudMemoryBudgets;
  /** Required owner-supplied C03 scope cleanup port; there is deliberately no successful no-op fallback. */
  readonly clearRevokedScope: (identity: PhotoIdentity, reason: PhotoWebRevocationReason) => void | Promise<void>;
  /** Shared copy is optional until C00/C08 publishes the complete transfer labels. */
  readonly transferCopy?: PhotoWebTransferCopy;
  /** Optional same-origin transport seam for tests and the host. It is used only for the BFF client. */
  readonly cloudFetch?: typeof fetch;
  /** The provider upload transport is deliberately separate from the BFF 401 observer. */
  readonly providerFetch?: typeof fetch;
  readonly indexedDB?: IDBFactory;
  readonly recipeLocks?: LockManager;
  readonly transferIndexedDB?: IDBFactory;
  readonly transferLocks?: LockManager | null;
  readonly now?: () => number;
}

type ConnectionSnapshot = Omit<PhotoWebViewBinding, "host">;
type InternalConnection = PhotoWebConnection & {
  readonly identity: PhotoIdentity;
  readonly scopeKey: string;
  readonly isCurrent: () => boolean;
  readonly hasPending: () => boolean;
  readonly canLeave: (signal: AbortSignal) => Promise<boolean>;
};

function validTransferCopy(value: PhotoWebTransferCopy | undefined): value is PhotoWebTransferCopy {
  if (value === undefined || typeof value !== "object" || value === null) return false;
  const required = ["toolbar", "pendingTitle", "add", "resume", "chooseSameFile", "cancel", "refresh", "next", "first", "busy", "failed", "unsupported", "refreshFailed"] as const;
  if (!required.every((key) => typeof value[key] === "string" && value[key].trim().length > 0)) return false;
  const phases: readonly PersonalPhotoTransferStatus["phase"][] = [
    "start-pending", "uploading", "complete-pending", "verifying", "pending-recipe", "done", "cancel-pending",
    "cancelled", "expired", "rejected", "purged", "failed", "needs-file",
  ];
  return typeof value.phaseLabels === "object" && value.phaseLabels !== null
    && phases.every((phase) => typeof value.phaseLabels[phase] === "string" && value.phaseLabels[phase].trim().length > 0);
}

function browserLocks(): LockManager | null {
  return typeof navigator === "object" && navigator.locks ? navigator.locks : null;
}

function toRecipeLocks(locks: LockManager): RecipeSyncLocks {
  return {
    async request<T>(name: string, options: { readonly mode: "exclusive"; readonly signal: AbortSignal }, callback: () => Promise<T>): Promise<T> {
      return await locks.request(name, options, () => callback());
    },
  };
}

function snapshotUsage(value: QuotaUsage): QuotaUsage {
  return Object.freeze({
    quotaBytes: value.quotaBytes,
    usedBytes: value.usedBytes,
    originalBytes: value.originalBytes,
    maskBytes: value.maskBytes,
    pendingPurgeBytes: value.pendingPurgeBytes,
    reservedBytes: value.reservedBytes,
    availableBytes: value.availableBytes,
  });
}

function copyIdentity(value: PhotoIdentity): PhotoIdentity {
  return Object.freeze({
    userId: value.userId,
    sessionId: value.sessionId,
    sessionEpoch: value.sessionEpoch,
    transport: value.transport,
    expiresAt: value.expiresAt,
  });
}

function isPersonalPhotoLibrary(value: unknown): value is PersonalPhotoLibrary {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as PersonalPhotoLibrary).contractVersion === 2
    && typeof (value as PersonalPhotoLibrary).id === "string"
    && typeof (value as PersonalPhotoLibrary).state === "string"
    && typeof (value as PersonalPhotoLibrary).capabilities === "object";
}

/**
 * The current browser wire has no `media.ensure` operation, so a server declaration alone cannot
 * enable generated Web working copies. Keep direct rendering available and close that capability
 * until the existing job port is connected.
 */
function closeUnconnectedMediaJobCapabilities(client: PersonalPhotoCloudClient): PersonalPhotoCloudClient {
  return {
    scope: client.scope,
    async request<K extends PhotoOperation>(
      operation: K,
      request: PhotoOperationMap[K]["request"],
      options: PhotoRequestOptions<K>,
    ): Promise<PhotoOperationMap[K]["response"]> {
      const response = await client.request(operation, request, options);
      if (operation !== "library.get") return response;
      const library = response as PersonalPhotoLibrary;
      return Object.freeze({
        ...library,
        capabilities: Object.freeze({
          ...library.capabilities,
          formats: Object.freeze(library.capabilities.formats.map((format) => Object.freeze({
            ...format,
            workingCopy: false,
          }))),
        }),
      }) as PhotoOperationMap[K]["response"];
    },
    dispose: () => client.dispose(),
  };
}

function linkAbortSignals(signals: readonly AbortSignal[]): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; abort: () => void }> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    listeners.push({ signal, abort });
  }
  return {
    controller,
    dispose: () => {
      for (const listener of listeners) listener.signal.removeEventListener("abort", listener.abort);
    },
  };
}

function createPhotoWebPreviewLibrary(options: {
  readonly library: PhotoLibrary;
  readonly client: PersonalPhotoCloudClient;
  readonly scopeSignal: AbortSignal;
  readonly rendererManifestSha256: string;
  readonly previewMemoryBytes: number;
  readonly isCurrent: () => boolean;
}): { readonly library: PhotoLibrary; dispose(): void } {
  const get = options.library.get.bind(options.library);
  const deletePhotos = options.library.delete.bind(options.library);
  let generation = 0;
  let activeRead: AbortController | null = null;
  let activeReadPhotoId: string | null = null;
  let activePreview: { readonly photoId: string; readonly key: string; readonly url: string } | null = null;
  let disposed = false;
  const revokeActive = (): void => {
    const previous = activePreview;
    activePreview = null;
    if (previous !== null) {
      try { URL.revokeObjectURL(previous.url); } catch { /* The scope is still cleared even if URL release fails. */ }
    }
  };
  const getPhoto: PhotoLibrary["get"] = async (photoId, requestOptions) => {
    const requestGeneration = ++generation;
    activeRead?.abort(new Error("Photo Web preview selection changed"));
    activeRead = null;
    activeReadPhotoId = null;
    const item = await get(photoId, requestOptions);
    const operationSignal = requestOptions?.signal ?? options.scopeSignal;
    if (item === null) {
      if (requestGeneration === generation) revokeActive();
      return item;
    }
    let photo: Photo;
    try {
      photo = await options.client.request("photos.get", { photoId }, { signal: operationSignal });
    } catch (error) {
      if (operationSignal.aborted || options.scopeSignal.aborted) throw error;
      if (requestGeneration === generation) revokeActive();
      return item;
    }
    if (requestGeneration !== generation || disposed || !options.isCurrent()) return item;
    const preview = item.editedPreview;
    if (preview === null || preview === undefined || preview.revision !== item.developRevision
      || preview.revision !== photo.recipe.revision || !isCurrentCloudPreview(photo, options.rendererManifestSha256)
      || photo.media.state !== "ready") {
      revokeActive();
      return item;
    }
    const asset = photo.media.preview;
    const key = JSON.stringify([photo.id, photo.recipe.revision, asset.id, asset.sha256, options.rendererManifestSha256]);
    if (activePreview?.key === key) return { ...item, editedPreview: { ...preview, url: activePreview.url } };
    const maxBytes = Math.floor(options.previewMemoryBytes / 3);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || asset.sizeBytes > maxBytes) {
      revokeActive();
      return item;
    }
    revokeActive();
    const linked = linkAbortSignals([options.scopeSignal, operationSignal]);
    activeRead = linked.controller;
    activeReadPhotoId = photoId;
    try {
      const verified = await readVerifiedMediaAsset(options.client, photoId, asset, {
        maxBytes,
        timeoutMs: 30_000,
        signal: linked.controller.signal,
      });
      try {
        if (requestGeneration !== generation || disposed || !options.isCurrent() || linked.controller.signal.aborted) return item;
        const blob = new Blob([verified.bytes], { type: asset.contentType });
        if (blob.size !== asset.sizeBytes) return item;
        const url = URL.createObjectURL(blob);
        if (requestGeneration !== generation || disposed || !options.isCurrent() || linked.controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return item;
        }
        activePreview = { photoId, key, url };
        return { ...item, editedPreview: { ...preview, url } };
      } finally {
        verified.release();
      }
    } catch (error) {
      if (operationSignal.aborted || options.scopeSignal.aborted) throw error;
      return item;
    } finally {
      linked.dispose();
      if (activeRead === linked.controller) {
        activeRead = null;
        activeReadPhotoId = null;
      }
    }
  };
  const deletePhoto: PhotoLibrary["delete"] = async (photoIds) => {
    const result = await deletePhotos(photoIds);
    if (result.deleted.length > 0) generation += 1;
    if (activeReadPhotoId !== null && result.deleted.includes(activeReadPhotoId)) {
      activeRead?.abort(new Error("Photo Web preview photo was deleted"));
      activeRead = null;
      activeReadPhotoId = null;
    }
    if (activePreview !== null && result.deleted.includes(activePreview.photoId)) revokeActive();
    return result;
  };
  const library = new Proxy(options.library, {
    get(target, property, receiver) {
      if (property === "get") return getPhoto;
      if (property === "delete") return deletePhoto;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    library,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      activeRead?.abort(new Error("Photo Web scope changed"));
      activeRead = null;
      activeReadPhotoId = null;
      revokeActive();
    },
  };
}

/**
 * Production composition of the existing C01 session, C02 HTTP/media ports, C03 durable library,
 * shared editor host, and optional transfer controller. It owns no alternate cache or journal.
 */
export function createPhotoWebConnectionFactory(options: CreatePhotoWebConnectionFactoryOptions): {
  readonly connect: (input: {
    readonly identity: PhotoIdentity;
    readonly signal: AbortSignal;
    readonly host: ScopedPhotoWebEditingHost;
    readonly session: PhotoSessionController;
    readonly onAuthenticationRejected: () => void;
  }) => Promise<PhotoWebConnection>;
  readonly guards: PhotoWebRuntimeGuards;
} {
  const factoryOptions = Object.freeze({ ...options, rendererProof: Object.freeze({ ...options.rendererProof }) });
  let active: InternalConnection | null = null;
  let connectionsStarting = 0;

  const guards: PhotoWebRuntimeGuards = {
    async canLeave(identity, guardOptions) {
      if (identity === null) return active === null && connectionsStarting === 0;
      const connection = active;
      if (connection === null) return connectionsStarting === 0;
      if (!samePhotoIdentityScope(connection.identity, identity) || !connection.isCurrent()) return false;
      return connection.canLeave(guardOptions.signal);
    },
    hasPending() {
      return connectionsStarting > 0 || (active?.hasPending() ?? false);
    },
    async onScopeRevoked(identity, reason) {
      const connection = active;
      if (connection !== null && samePhotoIdentityScope(connection.identity, identity)) active = null;
      await factoryOptions.clearRevokedScope(identity, reason);
    },
  };

  const connect = async (input: {
    readonly identity: PhotoIdentity;
    readonly signal: AbortSignal;
    readonly host: ScopedPhotoWebEditingHost;
    readonly session: PhotoSessionController;
    readonly onAuthenticationRejected: () => void;
  }): Promise<PhotoWebConnection> => {
    connectionsStarting += 1;
    try {
      if (input.signal.aborted || !input.host.isScopeCurrent()) throw new Error("Photo Web scope is not current");
      const identity = copyIdentity(input.identity);
      const indexedDB = factoryOptions.indexedDB ?? globalThis.indexedDB;
      const lockManager = factoryOptions.recipeLocks ?? browserLocks();
      if (indexedDB === undefined || lockManager === null) {
        throw new Error("Photo Web durable browser ports are unavailable");
      }
      const recipeLocks = toRecipeLocks(lockManager!);
      const cloudIdentity = createPhotoWebCloudIdentity({ session: input.session, identity, scopeSignal: input.signal });
      const bffFetch = createPhotoWebCloudFetch({
        origin: factoryOptions.origin,
        scopeSignal: input.signal,
        onAuthenticationRejected: input.onAuthenticationRejected,
        ...(factoryOptions.cloudFetch === undefined ? {} : { fetch: factoryOptions.cloudFetch }),
      });
      const rawClient = await createBrowserPersonalPhotoCloudClient({
        identity: cloudIdentity,
        fetch: bffFetch,
        ...(factoryOptions.now === undefined ? {} : { now: factoryOptions.now }),
      });
      const capturedClient = createCapturedPhotoWebCloudClient({
        client: rawClient,
        session: input.session,
        identity,
        scopeSignal: input.signal,
      });
      const client = closeUnconnectedMediaJobCapabilities(capturedClient);
      let handle: PersonalPhotoCloudLibraryHandle | null = null;
      let transferController: BrowserPersonalPhotoTransferController | null = null;
      let maskSurfaceValidator: PhotoWebMaskSurfaceValidator | null = null;
      let previewLibrary: { readonly library: PhotoLibrary; dispose(): void } | null = null;
      let disposed = false;
      let transferOperations = 0;
      let pendingDrafts: boolean | null = null;
      let draftReadGeneration = 0;
      let snapshot: ConnectionSnapshot | null = null;
      let usage: QuotaUsage;
      const listeners = new Set<(next: ConnectionSnapshot) => void>();
      let usageRefreshRequested = false;
      let usageRefreshTask: Promise<void> | null = null;
      const assertCurrent = (): void => {
        if (disposed || input.signal.aborted || !input.host.isScopeCurrent()) throw new Error("Photo Web scope changed");
      };
      const publish = (): void => {
        if (disposed || snapshot === null) return;
        for (const listener of [...listeners]) {
          try { listener(snapshot); } catch { /* A view observer cannot alter provider state. */ }
        }
      };
      const refreshPendingDrafts = async (): Promise<void> => {
        const generation = ++draftReadGeneration;
        pendingDrafts = null;
        const drafts = handle?.library.durableDevelopDrafts;
        if (drafts === undefined || !drafts.isCurrent() || !input.host.isScopeCurrent()) {
          if (generation === draftReadGeneration) pendingDrafts = true;
          return;
        }
        try {
          const page = await drafts.list({ limit: 16 }, { signal: input.signal });
          if (generation !== draftReadGeneration || !input.host.isScopeCurrent()) return;
          pendingDrafts = page.nextCursor !== null || page.items.some((item) => item.hasLatest || item.hasUnknownAttempt || item.conflictCount > 0);
        } catch {
          if (generation === draftReadGeneration) pendingDrafts = true;
        }
      };

      try {
        const renderer = await probePhotoWebRenderer({ proof: factoryOptions.rendererProof, signal: input.signal });
        if (renderer === null) throw new Error("Photo Web renderer proof is unavailable");
        const initialCloud = await client.request("library.get", {}, { signal: input.signal });
        assertCurrent();
        if (!isPersonalPhotoLibrary(initialCloud) || initialCloud.owner.userId !== identity.userId
          || initialCloud.id !== client.scope.libraryId || initialCloud.state !== "active") {
          throw new Error("Photo Web library is unavailable");
        }
        const rendererCapabilities = rendererIntersection(initialCloud.capabilities.renderer, renderer.capability);
        const maskSurfaceSupported = initialCloud.capabilities.maskSurfaces
          && rendererCapabilities !== null
          && rendererCapabilities.maskSurfaces
          && rendererCapabilities.features.includes("masks");
        if (maskSurfaceSupported) {
          maskSurfaceValidator = await createPhotoWebMaskSurfaceValidator({
            engineAssets: renderer.engineAssets,
            signal: input.signal,
          });
          assertCurrent();
        }
        handle = createSynchronizedPhotoLibrary({
          client,
          identity: cloudIdentity,
          hostRenderer: renderer.capability,
          engineAssets: renderer.engineAssets,
          presets: factoryOptions.presets,
          memoryBudgets: factoryOptions.memoryBudgets,
          journal: new IndexedDbRecipeSyncJournal(indexedDB),
          locks: recipeLocks,
          ...(maskSurfaceValidator === null ? {} : { maskSurfaceValidator }),
          ...(factoryOptions.now === undefined ? {} : { clock: { now: factoryOptions.now } }),
        });
        previewLibrary = createPhotoWebPreviewLibrary({
          library: handle.library,
          client,
          scopeSignal: input.signal,
          rendererManifestSha256: renderer.capability.manifestSha256,
          previewMemoryBytes: factoryOptions.memoryBudgets.previewBytes,
          isCurrent: () => !disposed && !input.signal.aborted && input.host.isScopeCurrent(),
        });
        const library = previewLibrary.library;
        await library.capabilities({ signal: input.signal });
        const rollout = await library.rollout({ signal: input.signal });
        usage = snapshotUsage(await handle.usage({ signal: input.signal }));
        const refreshUsage = (): Promise<void> => {
          usageRefreshRequested = true;
          if (usageRefreshTask !== null) return usageRefreshTask;
          let task!: Promise<void>;
          task = (async () => {
            while (usageRefreshRequested && !disposed && input.host.isScopeCurrent()) {
              usageRefreshRequested = false;
              const currentHandle = handle;
              if (currentHandle === null) return;
              try {
                const nextUsage = snapshotUsage(await currentHandle.usage({ signal: input.signal }));
                if (disposed || currentHandle !== handle || !input.host.isScopeCurrent()) return;
                usage = nextUsage;
                if (snapshot !== null) {
                  snapshot = Object.freeze({ ...snapshot, usage });
                  publish();
                }
              } catch {
                // Keep the last accepted quota snapshot when a refresh temporarily fails.
              }
            }
          })();
          usageRefreshTask = task;
          void task.finally(() => {
            if (usageRefreshTask === task) usageRefreshTask = null;
          }).catch(() => undefined);
          return task;
        };
        const canEdit = initialCloud.capabilities.edits
          && rendererIntersection(initialCloud.capabilities.renderer, renderer.capability) !== null;
        const scopeKey = JSON.stringify([identity.userId, identity.sessionId, identity.sessionEpoch, client.scope.libraryId]);
        const bindingKey = JSON.stringify([scopeKey, renderer.capability.manifestSha256]);

        const durable = library.durableDevelopDrafts;
        if (durable === undefined) throw new Error("Photo Web durable edit binding is unavailable");
        await refreshPendingDrafts();

        const notifySettled = async (_status: PersonalPhotoTransferStatus): Promise<void> => {
          if (disposed || !input.host.isScopeCurrent()) return;
          input.host.notifyPhotosChanged();
          await refreshUsage();
        };

        let transfer: PhotoWebTransferBinding | undefined;
        if (validTransferCopy(factoryOptions.transferCopy)) {
          try {
            transferController = createBrowserPersonalPhotoTransferController({
              client,
              identity: cloudIdentity,
              ...(factoryOptions.transferIndexedDB === undefined ? {} : { indexedDB: factoryOptions.transferIndexedDB }),
              ...(factoryOptions.transferLocks === undefined ? {} : { locks: factoryOptions.transferLocks }),
              ...(maskSurfaceValidator === null ? {} : { maskValidator: maskSurfaceValidator }),
              ...(factoryOptions.providerFetch === undefined ? {} : { fetch: factoryOptions.providerFetch }),
              ...(factoryOptions.now === undefined ? {} : { now: factoryOptions.now }),
            });
          } catch {
            transferController = null;
          }
        }
        if (transferController !== null && validTransferCopy(factoryOptions.transferCopy)) {
          const controller = transferController;
          const track = async <T,>(operation: () => Promise<T>): Promise<T> => {
            transferOperations += 1;
            publish();
            try { return await operation(); }
            finally { transferOperations = Math.max(0, transferOperations - 1); publish(); }
          };
          const trackedController: BrowserPersonalPhotoTransferController = Object.freeze({
            checkCapability: controller.checkCapability.bind(controller),
            start: (value: Parameters<BrowserPersonalPhotoTransferController["start"]>[0], signal?: AbortSignal) =>
              track(() => controller.start(value, signal)),
            resume: (value: Parameters<BrowserPersonalPhotoTransferController["resume"]>[0], signal?: AbortSignal) =>
              track(() => controller.resume(value, signal)),
            cancel: (intentId: string, signal?: AbortSignal) => track(() => controller.cancel(intentId, signal)),
            list: controller.list.bind(controller),
            readPendingRecipe: controller.readPendingRecipe.bind(controller),
            dispose: controller.dispose.bind(controller),
          });
          transfer = Object.freeze({
            controller: trackedController,
            formats: Object.freeze([...initialCloud.capabilities.formats]) as readonly FormatCapability[],
            copy: factoryOptions.transferCopy,
            describeError: (error: unknown) => library.errors.describe(error, factoryOptions.transferCopy!.failed),
            onSettled: notifySettled,
          });
        }

        snapshot = Object.freeze({
          key: bindingKey,
          scopeKey,
          actorId: identity.userId,
          library,
          canEdit: initialCloud.state === "active" && canEdit,
          cloudOriginalsAllowed: initialCloud.state === "active",
          mobileEditingAllowed: rollout.mobileEditing,
          disableCloudDelete: initialCloud.state !== "active",
          usage,
          ...(transfer === undefined ? {} : { transfer }),
        });

        const unsubscribeDrafts = durable.subscribe(() => { void refreshPendingDrafts(); });
        const abort = (): void => { void connection.dispose(); };
        let connection!: InternalConnection;
        connection = {
          identity,
          scopeKey,
          isCurrent: () => !disposed && !input.signal.aborted && input.host.isScopeCurrent(),
          hasPending: () => transferOperations > 0 || pendingDrafts !== false,
          async canLeave(signal) {
            if (!connection.isCurrent() || signal.aborted || transferOperations > 0 || !durable.isCurrent()) return false;
            try {
              const page = await durable.list({ limit: 16 }, { signal });
              if (!connection.isCurrent() || signal.aborted || page.nextCursor !== null) return false;
              const pending = page.items.some((item) => item.hasLatest || item.hasUnknownAttempt || item.conflictCount > 0);
              pendingDrafts = pending;
              return !pending && transferOperations === 0;
            } catch {
              pendingDrafts = true;
              return false;
            }
          },
          getSnapshot: () => snapshot!,
          refreshUsage,
          subscribe(listener) {
            if (disposed || typeof listener !== "function") return () => undefined;
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            input.signal.removeEventListener("abort", abort);
            unsubscribeDrafts();
            if (active === connection) active = null;
            listeners.clear();
            try { transferController?.dispose(); } catch { /* The identity fence already rejects late results. */ }
            try { previewLibrary?.dispose(); } catch { /* Continue releasing the shared library resources. */ }
            try { maskSurfaceValidator?.dispose(); } catch { /* Continue provider disposal. */ }
            try { handle?.releasePreviewResources(); } catch { /* Continue provider disposal. */ }
            try { handle?.dispose(); } catch { /* Continue client disposal. */ }
            if (handle === null) client.dispose();
          },
        };
        input.signal.addEventListener("abort", abort, { once: true });
        assertCurrent();
        const replaced = active;
        if (replaced !== null && replaced !== connection) replaced.dispose();
        active = connection;
        return connection;
      } catch (error) {
        try { transferController?.dispose(); } catch { /* Best effort for partial construction. */ }
        try { previewLibrary?.dispose(); } catch { /* Best effort for partial construction. */ }
        try { maskSurfaceValidator?.dispose(); } catch { /* Best effort for partial construction. */ }
        try { handle?.releasePreviewResources(); } catch { /* Best effort for partial construction. */ }
        try { handle?.dispose(); } catch { /* Best effort for partial construction. */ }
        if (handle === null) client.dispose();
        throw error;
      }
    } finally {
      connectionsStarting = Math.max(0, connectionsStarting - 1);
    }
  };

  return Object.freeze({ connect, guards });
}
