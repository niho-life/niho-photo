import { QueryClient } from "@tanstack/react-query";
import {
  PhotoSessionController,
  createBrowserPhotoSessionHost,
  isPhotoIdentityExpired,
  samePhotoIdentityScope,
  type PhotoIdentity,
  type PhotoSessionEvent,
} from "../../../../packages/photo-cloud-session/src/index.ts";

import { createPhotoPwaUpdateController } from "../pwa/update-controller.ts";
import type { PhotoPwaUpdateController } from "../pwa/types.ts";
import type { PhotoWebTransferBinding, PhotoWebViewBinding } from "../view/types.ts";
import type {
  CreatePhotoWebRuntimeOptions,
  PhotoWebBroadcastChannel,
  PhotoWebConnection,
  PhotoWebRuntime,
  PhotoWebRuntimeEnvironment,
  PhotoWebRuntimeSnapshot,
  ScopedPhotoWebEditingHost,
} from "./types.ts";

const BROADCAST_NAME = "niho-photo-session";
const GUARD_TIMEOUT_MS = 15_000;
const URL_LIFETIME_MS = 60_000;
const REFRESH_EARLY_MS = 60_000;
const MAX_BOUND_KEY_BYTES = 8_192;
const MAX_DOWNLOAD_ENTRIES = 16;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const PHOTO_FORMATS = new Set(["jpeg", "png", "heic", "heif", "tiff", "raw"]);
const TRANSFER_PHASES = [
  "start-pending",
  "uploading",
  "complete-pending",
  "verifying",
  "pending-recipe",
  "done",
  "cancel-pending",
  "cancelled",
  "expired",
  "rejected",
  "purged",
  "failed",
  "needs-file",
] as const;
const TRANSFER_COPY_FIELDS = [
  "toolbar",
  "pendingTitle",
  "add",
  "resume",
  "chooseSameFile",
  "cancel",
  "refresh",
  "next",
  "first",
  "busy",
  "failed",
  "unsupported",
  "refreshFailed",
] as const;

type LeaveGuard = (options?: { readonly release?: boolean }) => Promise<boolean>;
type ScopeReason = Extract<PhotoSessionEvent, { type: "scope-invalidated" }>["reason"];

function defaultEnvironment(): PhotoWebRuntimeEnvironment {
  const browserWindow = globalThis.window;
  const browserDocument = globalThis.document;
  const environment: PhotoWebRuntimeEnvironment = {
    window: browserWindow as PhotoWebRuntimeEnvironment["window"],
    document: browserDocument as PhotoWebRuntimeEnvironment["document"],
    urls: globalThis.URL as PhotoWebRuntimeEnvironment["urls"],
  };
  if (globalThis.navigator?.serviceWorker) {
    Object.assign(environment, { serviceWorker: globalThis.navigator.serviceWorker });
  }
  if (typeof globalThis.BroadcastChannel === "function") {
    Object.assign(environment, { createBroadcastChannel: (name: string) => new globalThis.BroadcastChannel(name) });
  }
  return environment;
}

function logicalScope(identity: PhotoIdentity | null): string {
  if (identity === null) return "signed-out";
  return JSON.stringify([identity.userId, identity.sessionId, identity.sessionEpoch, identity.transport]);
}

function validBoundKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && new TextEncoder().encode(value).byteLength <= MAX_BOUND_KEY_BYTES
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function copyUsage(value: PhotoWebViewBinding["usage"]): PhotoWebViewBinding["usage"] | undefined {
  if (value === null) return null;
  const fields = [
    value.quotaBytes,
    value.usedBytes,
    value.originalBytes,
    value.maskBytes,
    value.pendingPurgeBytes,
    value.reservedBytes,
    value.availableBytes,
  ];
  if (!fields.every((field) => Number.isSafeInteger(field) && field >= 0)) return undefined;
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

function copyTransferBinding(value: unknown): PhotoWebTransferBinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as PhotoWebTransferBinding;
  const controller = candidate.controller;
  if (typeof controller !== "object" || controller === null
    || typeof controller.checkCapability !== "function"
    || typeof controller.start !== "function"
    || typeof controller.resume !== "function"
    || typeof controller.cancel !== "function"
    || typeof controller.list !== "function"
    || typeof controller.readPendingRecipe !== "function"
    || typeof controller.dispose !== "function"
    || typeof candidate.describeError !== "function"
    || typeof candidate.onSettled !== "function"
    || !Array.isArray(candidate.formats)
    || typeof candidate.copy !== "object"
    || candidate.copy === null) return undefined;
  if (!TRANSFER_COPY_FIELDS.every((field) => typeof candidate.copy[field] === "string" && candidate.copy[field].length > 0)
    || typeof candidate.copy.phaseLabels !== "object"
    || candidate.copy.phaseLabels === null
    || !TRANSFER_PHASES.every((phase) => typeof candidate.copy.phaseLabels[phase] === "string"
      && candidate.copy.phaseLabels[phase].length > 0)) return undefined;

  const formats = candidate.formats.map((format) => {
    if (typeof format !== "object" || format === null
      || !PHOTO_FORMATS.has(format.format)
      || !Array.isArray(format.extensions)
      || !format.extensions.every((extension: unknown) => typeof extension === "string" && /^[a-z0-9]+$/iu.test(extension))
      || typeof format.ingest !== "boolean"
      || typeof format.workingCopy !== "boolean") throw new TypeError("invalid transfer format");
    return Object.freeze({
      format: format.format,
      extensions: Object.freeze(format.extensions.map((extension: string) => extension.toLowerCase())),
      ingest: format.ingest,
      workingCopy: format.workingCopy,
    });
  });
  const phaseLabels = Object.freeze(Object.fromEntries(
    TRANSFER_PHASES.map((phase) => [phase, candidate.copy.phaseLabels[phase]]),
  )) as PhotoWebTransferBinding["copy"]["phaseLabels"];
  const copy = Object.freeze({
    ...Object.fromEntries(TRANSFER_COPY_FIELDS.map((field) => [field, candidate.copy[field]])),
    phaseLabels,
  }) as PhotoWebTransferBinding["copy"];
  return Object.freeze({
    controller,
    formats: Object.freeze(formats),
    copy,
    describeError: candidate.describeError,
    onSettled: candidate.onSettled,
  });
}

function exactSessionChanged(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { type?: unknown }).type === "session-changed";
}

function safeDispose(connection: PhotoWebConnection | null): void {
  if (connection === null) return;
  try {
    connection.dispose();
  } catch {
    // Disposal is a fence. Adapter cleanup failures must not revive its authority.
  }
}

function safeCall(callback: (() => void) | null): void {
  if (callback === null) return;
  try {
    callback();
  } catch {
    // Cleanup failure never restores authority or exposes private details.
  }
}

function snapshotDownloadBudget(value: unknown): Readonly<CreatePhotoWebRuntimeOptions["downloadBudget"]> | null {
  try {
    if (value === null || typeof value !== "object") return null;
    const candidate = value as { readonly maxBytes?: unknown; readonly maxEntries?: unknown };
    const maxBytes = candidate.maxBytes;
    const maxEntries = candidate.maxEntries;
    if (!Number.isSafeInteger(maxBytes)
      || Number(maxBytes) <= 0
      || Number(maxBytes) > MAX_DOWNLOAD_BYTES
      || !Number.isSafeInteger(maxEntries)
      || Number(maxEntries) <= 0
      || Number(maxEntries) > MAX_DOWNLOAD_ENTRIES) return null;
    return Object.freeze({ maxBytes: Number(maxBytes), maxEntries: Number(maxEntries) });
  } catch {
    return null;
  }
}

export function createPhotoWebRuntime(options: CreatePhotoWebRuntimeOptions): PhotoWebRuntime {
  const configuredEnvironment = options.environment ?? defaultEnvironment();
  const windowTarget = configuredEnvironment.window;
  const documentTarget = configuredEnvironment.document;
  const addWindowEventListener = windowTarget.addEventListener.bind(windowTarget);
  const removeWindowEventListener = windowTarget.removeEventListener.bind(windowTarget);
  const addDocumentEventListener = documentTarget.addEventListener.bind(documentTarget);
  const removeDocumentEventListener = documentTarget.removeEventListener.bind(documentTarget);
  const createAnchor = documentTarget.createElement.bind(documentTarget);
  const appendToBody = documentTarget.body.append.bind(documentTarget.body);
  const pageOrigin = windowTarget.location?.origin ?? globalThis.location?.origin ?? "";
  const reloadPage = windowTarget.location?.reload.bind(windowTarget.location) ?? (() => undefined);
  const urlSource = configuredEnvironment.urls;
  const createObjectURL = urlSource.createObjectURL.bind(urlSource);
  const revokeObjectURL = urlSource.revokeObjectURL.bind(urlSource);
  const serviceWorker = configuredEnvironment.serviceWorker;
  const registerServiceWorker = serviceWorker?.register.bind(serviceWorker);
  const createBroadcastChannel = configuredEnvironment.createBroadcastChannel?.bind(configuredEnvironment);
  const now = configuredEnvironment.now?.bind(configuredEnvironment) ?? Date.now;
  const setTimer = configuredEnvironment.setTimer?.bind(configuredEnvironment)
    ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = configuredEnvironment.clearTimer?.bind(configuredEnvironment)
    ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const queryClient = options.queryClient ?? new QueryClient();
  const hostBridge = options.sessionHost ?? createBrowserPhotoSessionHost({ now, setTimer, clearTimer });
  const connectPort = typeof options.connect === "function" ? options.connect : null;
  const cancelDialogsPort = typeof options.cancelDialogs === "function" ? options.cancelDialogs : null;
  const guardSource = options.guards;
  const guardCanLeavePort = typeof guardSource?.canLeave === "function" ? guardSource.canLeave.bind(guardSource) : null;
  const guardHasPendingPort = typeof guardSource?.hasPending === "function" ? guardSource.hasPending.bind(guardSource) : null;
  const scopeRevokedPort = typeof guardSource?.onScopeRevoked === "function"
    ? guardSource.onScopeRevoked.bind(guardSource)
    : null;
  const failedCopy = typeof options.copy?.failed === "string" ? options.copy.failed : "";
  const downloadBudget = snapshotDownloadBudget(options.downloadBudget);
  const session = new PhotoSessionController(hostBridge, { now, setTimer, clearTimer });
  const portsValid = connectPort !== null
    && cancelDialogsPort !== null
    && guardCanLeavePort !== null
    && guardHasPendingPort !== null
    && scopeRevokedPort !== null
    && failedCopy.length > 0
    && downloadBudget !== null;
  const cloudEnabled = options.enabled === true && portsValid;
  const listeners = new Set<(snapshot: PhotoWebRuntimeSnapshot) => void>();
  const ownedUrls = new Map<string, { timer: unknown; readonly bytes: number }>();
  const removers: Array<() => void> = [];
  const cleanupEligibleScopes = new Set<string>();
  let transferProjections = new WeakMap<object, PhotoWebTransferBinding>();
  let ownedUrlBytes = 0;

  let disposed = false;
  let started = false;
  let resourceGeneration = 0;
  let connection: PhotoWebConnection | null = null;
  let connectionUnsubscribe: (() => void) | null = null;
  let scopeController: AbortController | null = null;
  let acceptedCore: Omit<PhotoWebViewBinding, "host"> | null = null;
  let binding: PhotoWebViewBinding | null = null;
  let pendingConnect: Promise<void> | null = null;
  let rejectedGeneration: number | null = null;
  let suppressConnection = false;
  let verificationInFlight: Promise<void> | null = null;
  let verificationQueuedFresh = false;
  let activeVerificationFence = 0;
  let fenceGeneration = 0;
  let verifiedFenceGeneration = 0;
  let revocationCleanup: Promise<void> | null = null;
  let revocationBlocked = false;
  let routeGuard: LeaveGuard | null = null;
  let guardInFlight: Promise<boolean> | null = null;
  let guardCancel: (() => void) | null = null;
  let proactiveTimer: unknown | null = null;
  let proactiveAttemptedExpiresAt: string | null = null;
  let broadcast: PhotoWebBroadcastChannel | null = null;
  let pwaController: PhotoPwaUpdateController | null = null;
  let pwaUnsubscribe: (() => void) | null = null;
  let initialReadSignalled = false;

  const makeRegistrar = (generation: number) => (guard: LeaveGuard | null): void => {
    if (disposed || generation !== resourceGeneration) return;
    if (guard !== null && typeof guard !== "function") return;
    routeGuard = guard;
  };
  let routeRegistrar = makeRegistrar(resourceGeneration);
  const requestPwaUpdate = () => pwaController?.requestUpdate() ?? Promise.resolve("failed" as const);

  const online = (): boolean => windowTarget.navigator?.onLine !== false;
  const dialogScopeKey = (): string => `${logicalScope(session.getSnapshot().identity)}:${resourceGeneration}`;
  const pwaView = (): PhotoWebRuntimeSnapshot["pwa"] => pwaController === null ? null : Object.freeze({
    snapshot: pwaController.getSnapshot(),
    requestUpdate: requestPwaUpdate,
  });

  let snapshot: PhotoWebRuntimeSnapshot = Object.freeze({
    session: session.getSnapshot(),
    binding: null,
    dialogScopeKey: dialogScopeKey(),
    online: online(),
    pwa: null,
    queryClient,
  });

  const publish = (): void => {
    if (disposed && session.getSnapshot().phase !== "disposed") return;
    const next = Object.freeze({
      session: session.getSnapshot(),
      binding,
      dialogScopeKey: dialogScopeKey(),
      online: online(),
      pwa: pwaView(),
      queryClient,
    });
    if (snapshot.session === next.session
      && snapshot.binding === next.binding
      && snapshot.dialogScopeKey === next.dialogScopeKey
      && snapshot.online === next.online
      && snapshot.pwa?.snapshot === next.pwa?.snapshot
      && snapshot.pwa?.requestUpdate === next.pwa?.requestUpdate) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One React subscriber cannot block the authority fence for the others.
      }
    }
  };

  const revokeUrl = (url: string): void => {
    if (!ownedUrls.has(url)) return;
    const entry = ownedUrls.get(url);
    ownedUrls.delete(url);
    if (entry !== undefined) {
      ownedUrlBytes = Math.max(0, ownedUrlBytes - entry.bytes);
      try {
        clearTimer(entry.timer);
      } catch {
        // The URL is already removed from the owned set.
      }
    }
    try {
      revokeObjectURL(url);
    } catch {
      // An already revoked browser URL is inert.
    }
  };

  const revokeAllUrls = (): void => {
    for (const url of [...ownedUrls.keys()]) revokeUrl(url);
  };

  const clearDerived = (): void => {
    const previousScopeController = scopeController;
    const previousUnsubscribe = connectionUnsubscribe;
    const previousConnection = connection;
    const cancelGuard = guardCancel;
    scopeController = null;
    connectionUnsubscribe = null;
    connection = null;
    acceptedCore = null;
    transferProjections = new WeakMap<object, PhotoWebTransferBinding>();
    binding = null;
    routeGuard = null;
    guardCancel = null;
    resourceGeneration += 1;
    routeRegistrar = makeRegistrar(resourceGeneration);
    safeCall(previousScopeController === null ? null : () => previousScopeController.abort());
    safeCall(cancelDialogsPort);
    safeCall(cancelGuard);
    safeCall(previousUnsubscribe);
    safeDispose(previousConnection);
    revokeAllUrls();
    try {
      void Promise.resolve(queryClient.cancelQueries()).catch(() => undefined);
    } catch {
      // Continue to clear() even when cancellation itself fails synchronously.
    }
    try {
      queryClient.clear();
    } catch {
      // The generation fence is already authoritative.
    }
    publish();
  };

  const currentScope = (generation: number, identity: PhotoIdentity, signal: AbortSignal): boolean => {
    const current = session.getSnapshot();
    return !disposed
      && generation === resourceGeneration
      && !signal.aborted
      && current.phase === "ready"
      && current.cloudOperationsAvailable
      && current.identity !== null
      && !isPhotoIdentityExpired(current.identity, now())
      && samePhotoIdentityScope(identity, current.identity);
  };

  const createScopedHost = (
    generation: number,
    identity: PhotoIdentity,
    controller: AbortController,
  ): ScopedPhotoWebEditingHost => {
    const isScopeCurrent = () => currentScope(generation, identity, controller.signal);
    return Object.freeze({
      scopeSignal: controller.signal,
      isScopeCurrent,
      nativeFileSaveAvailable: () => false,
      isDesktopApp: () => false,
      isNativeViewport: () => false,
      notifyPhotosChanged(): void {
        if (!isScopeCurrent()) return;
        try {
          void queryClient.invalidateQueries().catch(() => undefined);
        } catch {
          // The notification is deliberately fire-and-forget.
        }
      },
      async saveFile(file: Parameters<ScopedPhotoWebEditingHost["saveFile"]>[0]): Promise<"downloaded"> {
        const captured = await session.runCaptured(async () => file);
        if (captured.status !== "accepted" || !isScopeCurrent() || downloadBudget === null) throw new Error(failedCopy);
        let anchor: ReturnType<PhotoWebRuntimeEnvironment["document"]["createElement"]> | null = null;
        let url: string | null = null;
        try {
          const blobBytes = captured.value.blob.size;
          if (!Number.isSafeInteger(blobBytes)
            || blobBytes < 0
            || ownedUrls.size >= downloadBudget.maxEntries
            || blobBytes > downloadBudget.maxBytes - ownedUrlBytes) throw new Error(failedCopy);
          // No await may be inserted between this final authority check and click().
          if (!isScopeCurrent()) throw new Error(failedCopy);
          url = createObjectURL(captured.value.blob);
          const ownedUrl = url;
          if (ownedUrls.has(ownedUrl)) {
            revokeUrl(ownedUrl);
            throw new Error(failedCopy);
          }
          const entry = { timer: undefined as unknown, bytes: blobBytes };
          ownedUrls.set(ownedUrl, entry);
          ownedUrlBytes += blobBytes;
          const timer = setTimer(() => revokeUrl(ownedUrl), URL_LIFETIME_MS);
          if (ownedUrls.get(ownedUrl) === entry) entry.timer = timer;
          if (!ownedUrls.has(ownedUrl)) throw new Error(failedCopy);
          anchor = createAnchor("a");
          anchor.href = ownedUrl;
          anchor.download = captured.value.fileName;
          appendToBody(anchor);
          anchor.click();
          return "downloaded";
        } catch {
          if (url !== null) revokeUrl(url);
          throw new Error(failedCopy);
        } finally {
          try {
            anchor?.remove();
          } catch {
            // Detached anchors are already harmless.
          }
        }
      },
    });
  };

  const readValidBinding = (
    handle: PhotoWebConnection,
    identity: PhotoIdentity,
    expected: Omit<PhotoWebViewBinding, "host"> | null,
  ): Omit<PhotoWebViewBinding, "host"> | null => {
    let candidate: Omit<PhotoWebViewBinding, "host">;
    try {
      candidate = handle.getSnapshot();
    } catch {
      return null;
    }
    try {
      if (candidate === null || typeof candidate !== "object"
        || candidate.actorId !== identity.userId
        || !validBoundKey(candidate.key)
        || !validBoundKey(candidate.scopeKey)
        || candidate.library?.place !== "cloud"
        || typeof candidate.canEdit !== "boolean"
        || typeof candidate.cloudOriginalsAllowed !== "boolean"
        || typeof candidate.mobileEditingAllowed !== "boolean"
        || typeof candidate.disableCloudDelete !== "boolean") return null;
      const usage = copyUsage(candidate.usage);
      if (usage === undefined) return null;
      let transfer: PhotoWebTransferBinding | undefined;
      if (candidate.transfer !== undefined) {
        const source = candidate.transfer as unknown;
        if (typeof source !== "object" || source === null) return null;
        transfer = transferProjections.get(source);
        if (transfer === undefined) {
          transfer = copyTransferBinding(source);
          if (transfer === undefined) return null;
          transferProjections.set(source, transfer);
        }
      }
      if (expected !== null && (
        candidate.actorId !== expected.actorId
        || candidate.key !== expected.key
        || candidate.scopeKey !== expected.scopeKey
        || candidate.library !== expected.library
      )) return null;
      return Object.freeze({
        key: candidate.key,
        scopeKey: candidate.scopeKey,
        actorId: candidate.actorId,
        library: candidate.library,
        canEdit: candidate.canEdit,
        cloudOriginalsAllowed: candidate.cloudOriginalsAllowed,
        mobileEditingAllowed: candidate.mobileEditingAllowed,
        disableCloudDelete: candidate.disableCloudDelete,
        usage,
        ...(transfer === undefined ? {} : { transfer }),
      });
    } catch {
      return null;
    }
  };

  const scheduleConnection = (): void => {
    if (!cloudEnabled || disposed || suppressConnection || connection !== null || pendingConnect !== null
      || revocationCleanup !== null || revocationBlocked || rejectedGeneration === resourceGeneration
      || connectPort === null) return;
    const current = session.getSnapshot();
    if (current.phase !== "ready" || !current.cloudOperationsAvailable || current.identity === null) return;
    const generation = resourceGeneration;
    const identity = current.identity;
    const run = async (): Promise<void> => {
      if (revocationCleanup !== null || revocationBlocked
        || !currentScope(generation, identity, new AbortController().signal) || suppressConnection) return;
      const controller = new AbortController();
      scopeController = controller;
      const scopedHost = createScopedHost(generation, identity, controller);
      cleanupEligibleScopes.add(logicalScope(identity));
      const constructed: { value: PhotoWebConnection | null } = { value: null };
      const result = await session.runCaptured(async (capture) => {
        const abort = () => controller.abort();
        capture.signal.addEventListener("abort", abort, { once: true });
        if (capture.signal.aborted) controller.abort();
        try {
          constructed.value = await connectPort({ identity: capture.identity, signal: controller.signal, host: scopedHost, session });
          return constructed.value;
        } finally {
          capture.signal.removeEventListener("abort", abort);
        }
      });
      const handle = constructed.value;
      if (result.status === "failed") {
        if (generation === resourceGeneration) rejectedGeneration = generation;
        controller.abort();
        safeDispose(handle);
        if (scopeController === controller) scopeController = null;
        return;
      }
      if (result.status === "accepted" && (handle === null || result.value !== handle)) {
        if (generation === resourceGeneration) rejectedGeneration = generation;
        controller.abort();
        safeDispose(handle);
        if (scopeController === controller) scopeController = null;
        return;
      }
      if (handle === null || result.status !== "accepted" || !currentScope(generation, identity, controller.signal) || suppressConnection) {
        controller.abort();
        safeDispose(handle);
        if (scopeController === controller) scopeController = null;
        return;
      }
      const initial = readValidBinding(handle, identity, null);
      if (initial === null) {
        safeDispose(handle);
        controller.abort();
        if (scopeController === controller) scopeController = null;
        rejectedGeneration = generation;
        publish();
        return;
      }
      connection = handle;
      acceptedCore = initial;
      binding = Object.freeze({ ...initial, host: scopedHost });
      const subscribedGeneration = generation;
      let localUnsubscribe: (() => void) | null = null;
      try {
        localUnsubscribe = handle.subscribe(() => {
          if (disposed || connection !== handle || subscribedGeneration !== resourceGeneration) return;
          const next = readValidBinding(handle, identity, acceptedCore);
          if (next === null) {
            rejectedGeneration = subscribedGeneration;
            clearDerived();
            rejectedGeneration = resourceGeneration;
            return;
          }
          acceptedCore = next;
          binding = Object.freeze({ ...next, host: scopedHost });
          publish();
        });
        if (typeof localUnsubscribe !== "function") throw new TypeError("invalid connection subscription");
        if (disposed || connection !== handle || subscribedGeneration !== resourceGeneration) {
          safeCall(localUnsubscribe);
          return;
        }
        connectionUnsubscribe = localUnsubscribe;
      } catch {
        rejectedGeneration = generation;
        clearDerived();
        rejectedGeneration = resourceGeneration;
        safeCall(localUnsubscribe);
        return;
      }
      publish();
    };
    pendingConnect = run().catch(() => {
      if (generation === resourceGeneration) rejectedGeneration = generation;
    }).finally(() => {
      pendingConnect = null;
      scheduleConnection();
    });
  };

  const notifyPeers = (): void => {
    try {
      broadcast?.postMessage(Object.freeze({ type: "session-changed" }));
    } catch {
      // Peer notification is advisory; local fencing remains authoritative.
    }
  };

  const requestVerification = (fence: boolean, initial = false): Promise<void> => {
    if (!cloudEnabled || disposed) return Promise.resolve();
    const accepted = session.getSnapshot();
    if (!fence && !initial && !online() && accepted.phase === "ready" && accepted.identity !== null
      && !isPhotoIdentityExpired(accepted.identity, now())) return Promise.resolve();
    if (fence) {
      fenceGeneration += 1;
      suppressConnection = true;
      clearDerived();
    }
    if (verificationInFlight !== null) {
      if (fence && activeVerificationFence < fenceGeneration) verificationQueuedFresh = true;
      return verificationInFlight;
    }
    const runBatch = async (): Promise<void> => {
      let readInitial = initial;
      for (;;) {
        verificationQueuedFresh = false;
        const startedFence = fenceGeneration;
        activeVerificationFence = startedFence;
        const result = readInitial ? await session.read() : await session.refresh();
        if (startedFence === fenceGeneration) {
          verifiedFenceGeneration = startedFence;
          if (readInitial && !initialReadSignalled && result.phase === "ready") {
            initialReadSignalled = true;
            notifyPeers();
          }
        }
        readInitial = false;
        if (!verificationQueuedFresh || disposed) return;
      }
    };
    verificationInFlight = runBatch().finally(() => {
      verificationInFlight = null;
      activeVerificationFence = 0;
      verificationQueuedFresh = false;
      if (verifiedFenceGeneration === fenceGeneration) suppressConnection = false;
      scheduleConnection();
    });
    return verificationInFlight;
  };

  const scheduleProactiveRefresh = (): void => {
    if (proactiveTimer !== null) clearTimer(proactiveTimer);
    proactiveTimer = null;
    const current = session.getSnapshot();
    if (disposed || current.phase !== "ready" || current.identity === null
      || proactiveAttemptedExpiresAt === current.identity.expiresAt) return;
    const expiresAt = current.identity.expiresAt;
    const delay = Math.max(0, Date.parse(expiresAt) - now() - REFRESH_EARLY_MS);
    proactiveTimer = setTimer(() => {
      proactiveTimer = null;
      const latest = session.getSnapshot();
      if (disposed || !online() || documentTarget.visibilityState !== "visible" || latest.phase !== "ready"
        || latest.identity?.expiresAt !== expiresAt || proactiveAttemptedExpiresAt === expiresAt) return;
      proactiveAttemptedExpiresAt = expiresAt;
      void requestVerification(false);
    }, delay);
  };

  const onSessionEvent = (event: PhotoSessionEvent): void => {
    if (event.type === "operations-invalidated") {
      clearDerived();
      return;
    }
    if (event.type !== "scope-invalidated" || event.reason === "disposed") return;
    const scope = logicalScope(event.previous);
    if (!cleanupEligibleScopes.delete(scope)) return;
    const reason = event.reason as Exclude<ScopeReason, "disposed">;
    if (revocationCleanup !== null || scopeRevokedPort === null) {
      revocationBlocked = true;
      return;
    }
    const pending = Promise.resolve().then(() => scopeRevokedPort(event.previous, reason));
    revocationCleanup = pending;
    void pending.then(
      () => {
        if (revocationCleanup !== pending) return;
        revocationCleanup = null;
        scheduleConnection();
      },
      () => {
        revocationBlocked = true;
      },
    );
  };

  removers.push(session.onEvent(onSessionEvent));
  removers.push(session.subscribe(() => {
    publish();
    scheduleProactiveRefresh();
    scheduleConnection();
  }));

  const addWindowListener = (type: string, listener: EventListener): void => {
    addWindowEventListener(type, listener);
    removers.push(() => removeWindowEventListener(type, listener));
  };
  const addDocumentListener = (type: string, listener: EventListener): void => {
    addDocumentEventListener(type, listener);
    removers.push(() => removeDocumentEventListener(type, listener));
  };
  const onOnlineState = () => {
    if (online()) void requestVerification(false);
    publish();
  };
  const onNormalReverify = () => {
    if (online() && documentTarget.visibilityState === "visible") void requestVerification(false);
  };
  const onBeforeUnload = (event: Event) => {
    if (!cloudEnabled) return;
    let pending = true;
    try {
      pending = guardHasPendingPort?.() === true;
    } catch {
      pending = true;
    }
    if (!pending) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
  const onPageHide = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted === true) clearDerived();
    else dispose();
  };
  const onPageShow = (event: Event) => {
    if ((event as Event & { persisted?: boolean }).persisted === true) void requestVerification(true);
  };
  addWindowListener("online", onOnlineState);
  addWindowListener("offline", onOnlineState);
  addWindowListener("focus", onNormalReverify);
  addDocumentListener("visibilitychange", onNormalReverify);
  addWindowListener("beforeunload", onBeforeUnload);
  addWindowListener("pagehide", onPageHide);
  addWindowListener("pageshow", onPageShow);

  if (cloudEnabled && createBroadcastChannel) {
    try {
      broadcast = createBroadcastChannel(BROADCAST_NAME);
      const onMessage = (event: Event) => {
        const data = (event as MessageEvent<unknown>).data;
        if (exactSessionChanged(data)) void requestVerification(true);
      };
      broadcast.addEventListener("message", onMessage);
      removers.push(() => broadcast?.removeEventListener("message", onMessage));
    } catch {
      broadcast = null;
    }
  }

  const canLeave = (leaveOptions: { readonly release?: boolean } = {}): Promise<boolean> => {
    if (!portsValid || disposed || guardInFlight !== null || guardCanLeavePort === null) return Promise.resolve(false);
    const generation = resourceGeneration;
    const identity = session.getSnapshot().identity;
    const controller = new AbortController();
    const evaluation = (async (): Promise<boolean> => {
      try {
        const shared = routeGuard;
        if (shared !== null && await shared({ release: leaveOptions.release === true }) !== true) return false;
        if (generation !== resourceGeneration || disposed) return false;
        return await guardCanLeavePort(identity, {
          release: leaveOptions.release === true,
          signal: controller.signal,
        }) === true && generation === resourceGeneration && !disposed;
      } catch {
        return false;
      }
    })();
    guardInFlight = evaluation;
    void evaluation.finally(() => {
      if (guardInFlight === evaluation) guardInFlight = null;
    });
    let timer: unknown | null = null;
    let cancel: () => void = () => undefined;
    const timeout = new Promise<false>((resolve) => {
      cancel = () => {
        try {
          controller.abort();
        } finally {
          resolve(false);
        }
      };
      guardCancel = cancel;
      timer = setTimer(cancel, GUARD_TIMEOUT_MS);
    });
    return Promise.race([evaluation, timeout]).finally(() => {
      if (timer !== null) safeCall(() => clearTimer(timer));
      if (guardCancel === cancel) guardCancel = null;
    });
  };

  const setupPwa = async (): Promise<void> => {
    if (!cloudEnabled || serviceWorker === undefined || registerServiceWorker === undefined || disposed) return;
    let registration: ServiceWorkerRegistration;
    try {
      registration = await registerServiceWorker("/photo-sw.js", { scope: "/" });
    } catch {
      return;
    }
    if (disposed) return;
    try {
      const controller = createPhotoPwaUpdateController({
        registration,
        serviceWorker,
        origin: pageOrigin,
        canLeave: () => canLeave({ release: false }),
        reload: reloadPage,
      });
      pwaController = controller;
      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = controller.subscribe(publish);
      } catch {
        if (pwaController === controller) pwaController = null;
        safeCall(() => controller.dispose());
        return;
      }
      if (disposed || pwaController !== controller) {
        safeCall(unsubscribe);
        safeCall(() => controller.dispose());
        return;
      }
      pwaUnsubscribe = unsubscribe;
      publish();
    } catch {
      pwaController = null;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (proactiveTimer !== null) safeCall(() => clearTimer(proactiveTimer));
    proactiveTimer = null;
    const cancelGuard = guardCancel;
    guardCancel = null;
    safeCall(cancelGuard);
    const unsubscribePwa = pwaUnsubscribe;
    pwaUnsubscribe = null;
    const previousPwaController = pwaController;
    pwaController = null;
    safeCall(unsubscribePwa);
    safeCall(previousPwaController === null ? null : () => previousPwaController.dispose());
    for (const remove of removers.splice(0)) {
      safeCall(remove);
    }
    const previousBroadcast = broadcast;
    broadcast = null;
    safeCall(previousBroadcast === null ? null : () => previousBroadcast.close());
    safeCall(() => session.dispose());
    clearDerived();
    cleanupEligibleScopes.clear();
    snapshot = Object.freeze({
      session: session.getSnapshot(),
      binding: null,
      dialogScopeKey: dialogScopeKey(),
      online: online(),
      pwa: null,
      queryClient,
    });
    listeners.clear();
    void revocationCleanup?.catch(() => undefined);
  };

  const runtime = {
    getSnapshot: () => snapshot,
    subscribe(listener: (next: PhotoWebRuntimeSnapshot) => void): () => void {
      if (typeof listener !== "function" || disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(): Promise<void> {
      if (started || disposed) return;
      started = true;
      if (!cloudEnabled) return;
      await Promise.all([requestVerification(false, true), setupPwa()]);
    },
    async retry(): Promise<void> {
      if (disposed || !cloudEnabled) return;
      rejectedGeneration = null;
      await requestVerification(false);
      scheduleConnection();
    },
    async logout(): Promise<void> {
      if (disposed || !cloudEnabled) return;
      const generation = resourceGeneration;
      const identity = session.getSnapshot().identity;
      if (identity === null || await canLeave({ release: true }) !== true) return;
      const current = session.getSnapshot();
      if (disposed || generation !== resourceGeneration || current.identity === null
        || !samePhotoIdentityScope(identity, current.identity)) return;
      await session.logout();
      if (!disposed && session.getSnapshot().phase === "signed-out") notifyPeers();
    },
    canLeave,
    get registerRouteLeaveGuard() {
      return routeRegistrar;
    },
    dispose,
  } satisfies PhotoWebRuntime;

  return Object.freeze(runtime);
}
