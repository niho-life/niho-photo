import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { MacPhotoCloudScope, MacPhotoCopyNative, MacPhotoCopyStatus } from "./personal-cloud-binding";

type Invoke = (command: string, args: { input: unknown }) => Promise<unknown>;

/** Strict safe-DTO bridge. Source identity, bytes, paths, tickets, headers and credentials stay native-only. */
export function createMacPhotoCopyNative(invoke: Invoke = (command, args) => tauriInvoke(command, args)): MacPhotoCopyNative {
  return {
    async recover(scope, photoId) {
      const value = await invoke("camera_photo_copy_recover", { input: { scope: nativeScope(scope), photoId } });
      if (value === null) return null;
      if (!record(value) || !exact(value, ["requestId", "photoId"]) || !opaque(value.requestId) || !opaque(value.photoId)) invalid();
      return { requestId: value.requestId, photoId: value.photoId };
    },
    async start(scope, request) {
      if (!opaque(request.requestId) || !opaque(request.photoId) || !exact(request, ["requestId", "photoId"])) invalid();
      const value = await invoke("camera_photo_copy_start", { input: { scope: nativeScope(scope), ...request } });
      if (value !== null && value !== undefined) invalid();
    },
    async status(scope, requestId) {
      if (!opaque(requestId)) invalid();
      const value = await invoke("camera_photo_copy_status", { input: { scope: nativeScope(scope), requestId } });
      if (value === null) return null;
      return parseStatus(value);
    },
    async cancel(scope, requestId) {
      if (!opaque(requestId)) invalid();
      const value = await invoke("camera_photo_copy_cancel", { input: { scope: nativeScope(scope), requestId } });
      if (value !== null && value !== undefined) invalid();
    },
  };
}

function nativeScope(scope: MacPhotoCloudScope) {
  return {
    userId: scope.actorId,
    libraryId: scope.libraryId,
    sessionId: scope.sessionId,
    sessionEpoch: scope.sessionEpoch,
    transport: scope.transport,
  };
}

function parseStatus(value: unknown): MacPhotoCopyStatus {
  if (!record(value) || !exact(value, ["requestId", "photoId", "phase", "fraction", "completed"], true)
    || !opaque(value.requestId) || !opaque(value.photoId)
    || !["pending", "copying", "verifying", "stored", "cancelled", "failed"].includes(String(value.phase))
    || value.fraction !== null && (typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1)) invalid();
  let completed: MacPhotoCopyStatus["completed"];
  if (value.completed !== undefined) {
    if (!record(value.completed) || !exact(value.completed, ["original", "masks", "recipe", "cloudPhotoId"])
      || value.completed.original !== true || value.completed.masks !== true || value.completed.recipe !== true
      || !opaque(value.completed.cloudPhotoId) || value.phase !== "stored") invalid();
    completed = { original: true, masks: true, recipe: true, cloudPhotoId: value.completed.cloudPhotoId };
  }
  if (value.phase === "stored" && completed === undefined) invalid();
  return {
    requestId: value.requestId,
    photoId: value.photoId,
    phase: value.phase as MacPhotoCopyStatus["phase"],
    fraction: value.fraction,
    ...(completed === undefined ? {} : { completed }),
  };
}

function invalid(): never { throw new Error("invalid native copy response"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: object, keys: readonly string[], optional = false): boolean {
  const actual = Object.keys(value);
  return actual.every((key) => keys.includes(key)) && keys.filter((key) => !(optional && key === "completed")).every((key) => actual.includes(key));
}
function opaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}
