import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  PHOTO_LIMITS,
  type PersonalPhotoCloudClient,
  type PhotoContent,
  type PhotoOperation,
  type PhotoOperationMap,
  type PhotoRequestOptions,
  type VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import {
  JSON_LIMITS,
  PersonalPhotoCloudError,
  PersonalPhotoScope,
  TRANSPORT_TIMEOUT_MS,
  awaitBounded,
  encodeOperation,
  parsePhotoError,
  responseJsonLimit,
  validateJsonValue,
  validateOperationResponse,
  type WireOperation,
} from "@niho/photo-cloud-library/protocol";

/*
 * Keep the native metadata boundary aligned with the browser wire validator.
 * Native still verifies the complete original before this metadata is returned.
 */
const CONTENT_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]*"))*$/u;
const MAX_CHUNK = 1024 * 1024;
const OPEN_TIMEOUT_MS = 600_000;
const MAX_MASK_SELECTORS = 256;
const ALLOWED_JSON = new Set<WireOperation>([
  "library.get",
  "photos.list",
  "photos.get",
  "photos.info",
  "photos.lookup",
  "masks.get",
  "recipes.put",
  "recipe-conflicts.list",
  "recipe-conflicts.get",
  "recipe-conflicts.resolve",
  "photos.delete",
]);

export type NativePhotoInvoke = (command: string, args: { readonly input: unknown }) => Promise<unknown>;

export interface CreateNativePersonalPhotoCloudClientOptions {
  readonly identity: PersonalPhotoCloudIdentity;
  readonly invoke?: NativePhotoInvoke;
  readonly now?: () => number;
  readonly requestId?: () => string;
}

type NativeScope = Readonly<{
  userId: string;
  sessionId: string;
  sessionEpoch: string;
  transport: "mac-bearer";
}>;

type NativeJsonResponse = Readonly<{ status: number; body: unknown }>;
type NativeOpenResponse = Readonly<{
  handle: string;
  contentType: string;
  sha256: string;
  totalBytes: number;
  range: Readonly<{ start: number; endInclusive: number }>;
  sizeBytes: number;
}>;

export async function createNativePersonalPhotoCloudClient(
  options: CreateNativePersonalPhotoCloudClientOptions,
): Promise<PersonalPhotoCloudClient> {
  const invoke = options.invoke ?? ((command, args) => tauriInvoke(command, args));
  const now = options.now ?? Date.now;
  const actor = currentMacActor(options.identity, now);
  const lifecycle = new AbortController();
  const probeController = new AbortController();
  const stopProbe = options.identity.subscribe(() => {
    const next = options.identity.getSnapshot();
    if (next === null || !sameLogicalActor(actor, next)) {
      probeController.abort(new PersonalPhotoCloudError("scope_changed"));
    }
  });
  let libraryId: string;
  try {
    const encoded = encodeOperation("library.get", {}, undefined);
    const response = await invokeJson(
      invoke,
      actorScope(actor),
      encoded.operation,
      {},
      undefined,
      probeController.signal,
    );
    const raw = successfulBody(response, encoded.operation);
    if (!isRecord(raw) || typeof raw.id !== "string") invalidResponse();
    libraryId = validateOperationResponse("library.get", raw, actor.userId, raw.id).id;
    const fresh = options.identity.getSnapshot();
    if (fresh === null || !sameLogicalActor(actor, fresh)) throw new PersonalPhotoCloudError("scope_changed");
  } finally {
    stopProbe();
  }

  let scope: PersonalPhotoScope;
  let disposed = false;
  // Successful masks.get is the only authority for attaching a surface selector to an opaque asset id.
  // This map belongs to this captured native scope and is discarded with the client.
  const maskSelectors = new Map<string, string>();
  const client: PersonalPhotoCloudClient = {
    scope: Object.freeze({ actorId: actor.userId, libraryId, sessionEpoch: actor.sessionEpoch }),
    async request<K extends PhotoOperation>(
      operation: K,
      request: PhotoOperationMap[K]["request"],
      requestOptions: PhotoRequestOptions<K>,
    ): Promise<PhotoOperationMap[K]["response"]> {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      const scoped = scope.begin(requestOptions.signal);
      let contentOwnsScope = false;
      try {
        const key = "idempotencyKey" in requestOptions ? requestOptions.idempotencyKey : undefined;
        const encoded = encodeOperation(operation, request, key);
        const capture = currentMacActor(options.identity, now);
        if (operation === "content.get") {
          const contentRequest = request as PhotoOperationMap["content.get"]["request"];
          const content = await openNativeContent(
            invoke,
            actorScope(capture),
            contentRequest,
            scoped,
            options.requestId ?? randomRequestId,
            maskSelectors.get(maskSelectorKey(contentRequest.photoId, contentRequest.assetId)),
          );
          contentOwnsScope = true;
          return content as PhotoOperationMap[K]["response"];
        }
        if (!ALLOWED_JSON.has(encoded.operation)) throw new PersonalPhotoCloudError("unsupported");
        const response = await invokeJson(
          invoke,
          actorScope(capture),
          encoded.operation,
          request,
          encoded.idempotencyKey ?? undefined,
          scoped.signal,
        );
        scoped.assertCurrent();
        const raw = successfulBody(response, encoded.operation);
        const checked = validateOperationResponse(
          encoded.operation,
          raw,
          actor.userId,
          libraryId,
          encoded.responseContext,
        ) as PhotoOperationMap[K]["response"];
        if (operation === "masks.get") {
          const requested = request as PhotoOperationMap["masks.get"]["request"];
          const asset = validateNativeMaskAsset(checked, requested.surfaceId);
          const selectorKey = maskSelectorKey(requested.photoId, asset.id);
          maskSelectors.delete(selectorKey);
          maskSelectors.set(selectorKey, requested.surfaceId);
          if (maskSelectors.size > MAX_MASK_SELECTORS) {
            const oldest = maskSelectors.keys().next().value;
            if (oldest !== undefined) maskSelectors.delete(oldest);
          }
        }
        return checked;
      } catch (error) {
        if (isUnauthenticated(error)) scope.invalidateAuthentication();
        throw error;
      } finally {
        if (!contentOwnsScope) scoped.release();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
      maskSelectors.clear();
      scope.dispose();
    },
  };
  scope = new PersonalPhotoScope(client, options.identity, now);
  scope.onInvalidated(() => maskSelectors.clear());
  return client;
}

async function invokeJson(
  invoke: NativePhotoInvoke,
  scope: NativeScope,
  operation: WireOperation,
  request: unknown,
  idempotencyKey: string | undefined,
  signal: AbortSignal,
): Promise<NativeJsonResponse> {
  const promise = invoke("camera_photo_request", {
    input: { scope, operation, request, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
  });
  const raw = await awaitBounded(promise, { signal, timeoutMs: TRANSPORT_TIMEOUT_MS });
  if (!isRecord(raw) || !exactKeys(raw, ["status", "body"]) || !safeInteger(raw.status) || raw.status < 100 || raw.status > 599) {
    invalidResponse();
  }
  const maximum = raw.status >= 200 && raw.status < 300 ? responseJsonLimit(operation) : JSON_LIMITS.error;
  validateJsonValue(raw.body, maximum, 38);
  return { status: raw.status, body: raw.body };
}

function successfulBody(response: NativeJsonResponse, operation: WireOperation): unknown {
  if (response.status >= 200 && response.status < 300) return response.body;
  throw parsePhotoError(response.body, response.status);
}

async function openNativeContent(
  invoke: NativePhotoInvoke,
  scope: NativeScope,
  request: PhotoOperationMap["content.get"]["request"],
  scoped: ReturnType<PersonalPhotoScope["begin"]>,
  nextRequestId: () => string,
  maskSurfaceId: string | undefined,
): Promise<PhotoContent> {
  const requestId = nextRequestId();
  if (!boundedOpaque(requestId)) invalidResponse();
  let settledHandle: string | null = null;
  const cancelOpen = (): void => {
    void invoke("camera_photo_content_cancel", { input: { scope, requestId } }).catch(() => undefined);
  };
  const closeLate = (value: unknown): void => {
    const open = parseOpen(value, request, maskSurfaceId);
    const handle = open?.handle ?? extractHandle(value);
    if (handle !== null) void closeHandle(invoke, scope, handle);
  };
  let open: NativeOpenResponse;
  try {
    const promise = invoke("camera_photo_content_open", {
      input: {
        scope,
        requestId,
        photoId: request.photoId,
        assetId: request.assetId,
        ...(maskSurfaceId === undefined ? {} : { maskSurfaceId }),
        ...(request.range === undefined ? {} : { range: request.range }),
      },
    });
    const raw = await awaitBounded(promise, {
      signal: scoped.signal,
      timeoutMs: OPEN_TIMEOUT_MS,
      onAbort: cancelOpen,
      onTimeout: cancelOpen,
      onLateResolve: closeLate,
    });
    const parsed = parseOpen(raw, request, maskSurfaceId);
    if (parsed === null) {
      const handle = extractHandle(raw);
      if (handle !== null) void closeHandle(invoke, scope, handle);
      invalidResponse();
    }
    open = parsed;
    settledHandle = open.handle;
    scoped.assertCurrent();
  } catch (error) {
    if (settledHandle !== null) {
      const handle = settledHandle;
      settledHandle = null;
      void closeHandle(invoke, scope, handle);
    }
    scoped.release();
    throw error;
  }

  let offset = 0;
  let finished = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    scoped.signal.removeEventListener("abort", abort);
    scoped.release();
  };
  const close = (): void => {
    if (settledHandle !== null) {
      const handle = settledHandle;
      settledHandle = null;
      void closeHandle(invoke, scope, handle);
    }
    finish();
  };
  const abort = (): void => {
    close();
    try {
      controllerRef?.error(scoped.signal.reason instanceof Error ? scoped.signal.reason : new DOMException("Aborted", "AbortError"));
    } catch {
      // Consumer already cancelled.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      scoped.signal.addEventListener("abort", abort, { once: true });
      if (scoped.signal.aborted) abort();
    },
    async pull(controller) {
      if (finished || settledHandle === null) return;
      try {
        scoped.assertCurrent();
        const remaining = open.sizeBytes - offset;
        if (remaining === 0) {
          close();
          controller.close();
          return;
        }
        const expectedMaximum = Math.min(MAX_CHUNK, remaining);
        const raw = await awaitBounded(
          invoke("camera_photo_content_read", {
            input: { scope, handle: settledHandle, offset, maxBytes: expectedMaximum },
          }),
          { signal: scoped.signal, timeoutMs: TRANSPORT_TIMEOUT_MS, onAbort: close, onTimeout: close },
        );
        scoped.assertCurrent();
        const bytes = toBytes(raw);
        if (bytes.byteLength === 0 || bytes.byteLength > expectedMaximum) invalidResponse();
        offset += bytes.byteLength;
        if (offset > open.sizeBytes) invalidResponse();
        controller.enqueue(bytes);
        if (offset === open.sizeBytes) {
          close();
          controller.close();
        }
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
  return {
    body,
    contentType: open.contentType,
    sha256: open.sha256,
    totalBytes: open.totalBytes,
    range: open.range,
  };
}

function parseOpen(
  value: unknown,
  request: PhotoOperationMap["content.get"]["request"],
  maskSurfaceId?: string,
): NativeOpenResponse | null {
  if (!isRecord(value) || !exactKeys(value, ["handle", "contentType", "sha256", "totalBytes", "range", "sizeBytes"])) return null;
  if (!boundedOpaque(value.handle) || typeof value.contentType !== "string"
    || new TextEncoder().encode(value.contentType).byteLength > 255 || !CONTENT_TYPE.test(value.contentType)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)
    || maskSurfaceId !== undefined && value.sha256 !== maskSurfaceId) return null;
  if (!safePositive(value.totalBytes) || value.totalBytes > PHOTO_LIMITS.maxFileBytes
    || !safePositive(value.sizeBytes) || value.sizeBytes > PHOTO_LIMITS.maxFileBytes
    || !isRecord(value.range) || !exactKeys(value.range, ["start", "endInclusive"])) return null;
  if (!safeInteger(value.range.start) || !safeInteger(value.range.endInclusive) || value.range.endInclusive < value.range.start || value.range.endInclusive >= value.totalBytes) return null;
  const expectedStart = request.range?.start ?? 0;
  const expectedEnd = request.range?.endInclusive ?? value.totalBytes - 1;
  if (value.range.start !== expectedStart || value.range.endInclusive !== expectedEnd || value.sizeBytes !== expectedEnd - expectedStart + 1) return null;
  return value as unknown as NativeOpenResponse;
}

function validateNativeMaskAsset(value: unknown, expectedSurfaceId: string): { readonly id: string } {
  if (!isRecord(value) || !exactKeys(value, ["id", "kind", "sha256", "sizeBytes", "contentType", "width", "height"])) {
    invalidResponse();
  }
  if (
    !boundedOpaque(value.id) ||
    value.kind !== "mask" ||
    value.sha256 !== expectedSurfaceId ||
    value.contentType !== "image/png" ||
    !safePositive(value.sizeBytes) ||
    value.sizeBytes > PHOTO_LIMITS.maxMaskBytes ||
    !safePositive(value.width) ||
    value.width > PHOTO_LIMITS.maxMaskEdge ||
    !safePositive(value.height) ||
    value.height > PHOTO_LIMITS.maxMaskEdge
  ) {
    invalidResponse();
  }
  return value as { readonly id: string };
}

function maskSelectorKey(photoId: string, assetId: string): string {
  return `${photoId.length}:${photoId}${assetId}`;
}

function extractHandle(value: unknown): string | null {
  return isRecord(value) && boundedOpaque(value.handle) ? value.handle : null;
}

async function closeHandle(invoke: NativePhotoInvoke, scope: NativeScope, handle: string): Promise<void> {
  await invoke("camera_photo_content_close", { input: { scope, handle } }).catch(() => undefined);
}

function currentMacActor(identity: PersonalPhotoCloudIdentity, now: () => number): VerifiedPhotoActor {
  const actor = identity.getSnapshot();
  if (actor === null || actor.transport !== "mac-bearer" || !boundedOpaque(actor.userId) || !boundedOpaque(actor.sessionId)
    || !boundedOpaque(actor.sessionEpoch) || !Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now()) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
  return actor;
}

function actorScope(actor: VerifiedPhotoActor): NativeScope {
  if (actor.transport !== "mac-bearer") throw new PersonalPhotoCloudError("invalid_identity");
  return Object.freeze({
    userId: actor.userId,
    sessionId: actor.sessionId,
    sessionEpoch: actor.sessionEpoch,
    transport: actor.transport,
  });
}

function sameLogicalActor(left: VerifiedPhotoActor, right: VerifiedPhotoActor): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId
    && left.sessionEpoch === right.sessionEpoch && left.transport === right.transport;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  invalidResponse();
}

function randomRequestId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isUnauthenticated(value: unknown): boolean {
  return isRecord(value) && isRecord(value.error) && value.error.code === "unauthenticated";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 512
    && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safePositive(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function invalidResponse(): never {
  throw new PersonalPhotoCloudError("invalid_response");
}
