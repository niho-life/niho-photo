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
  IndexedDbTransferJournal,
  PERSONAL_PHOTO_TRANSFER_DATABASE_NAME,
  type JournalScope,
  type BrowserPersonalPhotoTransferController,
  type PersonalPhotoTransferStatus,
} from "@niho/photo-cloud-library/browser";
import type { PersonalPhotoCloudLibraryHandle, PersonalPhotoCloudMemoryBudgets } from "@niho/photo-cloud-library";
import { rendererIntersection } from "@niho/photo-cloud-library/protocol";
import { createPersonalPhotoCloudLibrary as createSynchronizedPhotoLibrary } from "@niho/photo-cloud-sync";
import { IndexedDbRecipeSyncJournal } from "@niho/photo-cloud-sync/browser";
import type { RecipeJournalScope, RecipeSyncLocks } from "@niho/photo-cloud-sync";
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
  /** Optional application cleanup in addition to the exact C02/C03 journals fenced here. */
  readonly clearRevokedScope?: (identity: PhotoIdentity, reason: PhotoWebRevocationReason) => void | Promise<void>;
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
  readonly transferDatabaseName?: string;
  readonly recipeDatabaseName?: string;
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

interface CapturedRevocationScope {
  readonly transfer: JournalScope;
  readonly recipe: RecipeJournalScope;
}

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

const PENDING_TRANSFER_PHASES = new Set<PersonalPhotoTransferStatus["phase"]>([
  "start-pending", "uploading", "complete-pending", "verifying", "pending-recipe", "cancel-pending", "needs-file",
]);

function identityScopeKey(identity: PhotoIdentity): string {
  return JSON.stringify([identity.userId, identity.sessionId, identity.sessionEpoch, identity.transport]);
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
  const openOriginal = options.library.openOriginal.bind(options.library);
  const deletePhotos = options.library.delete.bind(options.library);
  let generation = 0;
  let activeSelection: AbortController | null = null;
  let activeSelectionPhotoId: string | null = null;
  let activePreview: { readonly photoId: string; readonly revision: number; readonly url: string } | null = null;
  let disposed = false;
  const revokeActive = (): void => {
    const previous = activePreview;
    activePreview = null;
    if (previous !== null) {
      try { URL.revokeObjectURL(previous.url); } catch { /* The scope is still cleared even if URL release fails. */ }
    }
  };
  const loadSelectedEditedPreview: NonNullable<PhotoLibrary["loadSelectedEditedPreview"]> = async (photoId, requestOptions) => {
    const requestGeneration = ++generation;
    activeSelection?.abort(new Error("Photo Web preview selection changed"));
    activeSelection = null;
    activeSelectionPhotoId = photoId;
    revokeActive();
    if (photoId === null) {
      activeSelectionPhotoId = null;
      return null;
    }
    const linked = linkAbortSignals([options.scopeSignal, ...(requestOptions?.signal ? [requestOptions.signal] : [])]);
    activeSelection = linked.controller;
    try {
      const currentPhoto = await options.client.request("photos.get", { photoId }, { signal: linked.controller.signal });
      if (requestGeneration !== generation || disposed || !options.isCurrent() || currentPhoto.id !== photoId
        || !isCurrentCloudPreview(currentPhoto, options.rendererManifestSha256) || currentPhoto.media.state !== "ready") {
        return null;
      }
      const asset = currentPhoto.media.preview;
      const preview = {
        revision: currentPhoto.recipe.revision,
        width: asset.width,
        height: asset.height,
        url: null,
        thumbUrl: null,
      };
      const maxBytes = Math.floor(options.previewMemoryBytes / 3);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || asset.sizeBytes > maxBytes) return null;
      const verified = await readVerifiedMediaAsset(options.client, photoId, asset, {
        maxBytes,
        timeoutMs: 30_000,
        signal: linked.controller.signal,
      });
      try {
        if (requestGeneration !== generation || disposed || !options.isCurrent() || linked.controller.signal.aborted) return null;
        const blob = new Blob([verified.bytes], { type: asset.contentType });
        if (blob.size !== asset.sizeBytes) return null;
        const url = URL.createObjectURL(blob);
        if (requestGeneration !== generation || disposed || !options.isCurrent() || linked.controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return null;
        }
        activePreview = { photoId, revision: preview.revision, url };
        return { ...preview, url };
      } finally {
        verified.release();
      }
    } catch (error) {
      if (linked.controller.signal.aborted || options.scopeSignal.aborted) throw error;
      return null;
    } finally {
      linked.dispose();
      if (activeSelection === linked.controller) {
        activeSelection = null;
        activeSelectionPhotoId = null;
      }
    }
  };
  const openWithSelectedPreview: PhotoLibrary["openOriginal"] = async (photoId, requestOptions) => {
    const original = await openOriginal(photoId, requestOptions);
    const preview = activePreview;
    const photoPreview = original.photo.editedPreview;
    if (preview === null || preview.photoId !== photoId || photoPreview?.revision !== preview.revision) return original;
    return { ...original, photo: { ...original.photo, editedPreview: { ...photoPreview, url: preview.url } } };
  };
  const deletePhoto: PhotoLibrary["delete"] = async (photoIds) => {
    const result = await deletePhotos(photoIds);
    if (activeSelectionPhotoId !== null && result.deleted.includes(activeSelectionPhotoId)) {
      generation += 1;
      activeSelection?.abort(new Error("Photo Web preview photo was deleted"));
      activeSelection = null;
      activeSelectionPhotoId = null;
    }
    if (activePreview !== null && result.deleted.includes(activePreview.photoId)) {
      generation += 1;
      revokeActive();
    }
    return result;
  };
  const library = new Proxy(options.library, {
    get(target, property, receiver) {
      if (property === "loadSelectedEditedPreview") return loadSelectedEditedPreview;
      if (property === "openOriginal") return openWithSelectedPreview;
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
      activeSelection?.abort(new Error("Photo Web scope changed"));
      activeSelection = null;
      activeSelectionPhotoId = null;
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
  const revocationScopes = new Map<string, CapturedRevocationScope>();

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
      const key = identityScopeKey(identity);
      const capturedScope = revocationScopes.get(key);
      const cleanup: Promise<void>[] = [];
      if (capturedScope !== undefined) {
        const database = factoryOptions.indexedDB ?? globalThis.indexedDB;
        const transferDatabase = factoryOptions.transferIndexedDB ?? database;
        if (database === undefined || transferDatabase === undefined) throw new Error("Photo Web durable journals are unavailable");
        const recipeJournal = new IndexedDbRecipeSyncJournal(database, factoryOptions.recipeDatabaseName);
        const transferJournal = new IndexedDbTransferJournal(
          transferDatabase,
          factoryOptions.transferDatabaseName ?? PERSONAL_PHOTO_TRANSFER_DATABASE_NAME,
        );
        cleanup.push(
          recipeJournal.purgeScope(capturedScope.recipe).finally(() => recipeJournal.dispose()).then(() => undefined),
          transferJournal.purgeScope(capturedScope.transfer).finally(() => transferJournal.dispose()).then(() => undefined),
        );
      }
      if (factoryOptions.clearRevokedScope !== undefined) {
        cleanup.push(Promise.resolve().then(() => factoryOptions.clearRevokedScope!(identity, reason)));
      }
      await Promise.all(cleanup);
      if (capturedScope !== undefined) revocationScopes.delete(key);
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
      const identityKey = identityScopeKey(identity);
      revocationScopes.set(identityKey, Object.freeze({
        transfer: Object.freeze({
          actorId: identity.userId,
          libraryId: client.scope.libraryId,
          sessionId: identity.sessionId,
          sessionEpoch: identity.sessionEpoch,
        }),
        recipe: Object.freeze({
          actorId: identity.userId,
          libraryId: client.scope.libraryId,
          sessionId: identity.sessionId,
          sessionEpoch: identity.sessionEpoch,
          transport: identity.transport,
        }),
      }));
      let handle: PersonalPhotoCloudLibraryHandle | null = null;
      let transferController: BrowserPersonalPhotoTransferController | null = null;
      let maskSurfaceValidator: PhotoWebMaskSurfaceValidator | null = null;
      let previewLibrary: { readonly library: PhotoLibrary; dispose(): void } | null = null;
      let disposed = false;
      let transferOperations = 0;
      let pendingTransfers: boolean | null = null;
      let transferReadGeneration = 0;
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
      const refreshPendingTransfers = async (): Promise<void> => {
        const generation = ++transferReadGeneration;
        pendingTransfers = null;
        const controller = transferController;
        if (controller === null || !input.host.isScopeCurrent()) {
          if (generation === transferReadGeneration) pendingTransfers = controller === null ? false : true;
          return;
        }
        try {
          let cursor: string | undefined;
          let hasPending = false;
          while (true) {
            const page = await controller.list(cursor === undefined ? { limit: 16 } : { limit: 16, cursor });
            if (generation !== transferReadGeneration || !input.host.isScopeCurrent()) return;
            if (page.items.some((item) => item.hasPendingRecipe || PENDING_TRANSFER_PHASES.has(item.phase))) {
              hasPending = true;
              break;
            }
            if (page.nextCursor === null) break;
            if (page.nextCursor === cursor) throw new Error("Photo Web transfer pagination did not advance");
            cursor = page.nextCursor;
          }
          if (generation === transferReadGeneration && input.host.isScopeCurrent()) pendingTransfers = hasPending;
        } catch {
          if (generation === transferReadGeneration) pendingTransfers = true;
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
          journal: new IndexedDbRecipeSyncJournal(indexedDB, factoryOptions.recipeDatabaseName),
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
          await Promise.all([refreshUsage(), refreshPendingTransfers()]);
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
              ...(factoryOptions.transferDatabaseName === undefined ? {} : { databaseName: factoryOptions.transferDatabaseName }),
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
        await refreshPendingTransfers();

        snapshot = Object.freeze({
          key: bindingKey,
          scopeKey,
          actorId: identity.userId,
          library,
          canEdit: initialCloud.state === "active" && canEdit,
          cloudOriginalsAllowed: initialCloud.state === "active",
          mobileEditingAllowed: rollout.mobileEditing && canEdit && durable.isCurrent(),
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
          hasPending: () => transferOperations > 0 || pendingDrafts !== false || pendingTransfers !== false,
          async canLeave(signal) {
            if (!connection.isCurrent() || signal.aborted || transferOperations > 0 || !durable.isCurrent()) return false;
            try {
              const [page] = await Promise.all([
                durable.list({ limit: 16 }, { signal }),
                refreshPendingTransfers(),
              ]);
              if (!connection.isCurrent() || signal.aborted || page.nextCursor !== null) return false;
              pendingDrafts = page.items.some((item) => item.hasLatest || item.hasUnknownAttempt || item.conflictCount > 0);
              return !pendingDrafts && pendingTransfers === false && transferOperations === 0;
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
