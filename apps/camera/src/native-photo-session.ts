import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

import {
  readTrustedMacPhotoIdentity,
  type PhotoIdentity,
} from "../../../packages/photo-cloud-session/src/index.ts";

export const PHOTO_IDENTITY_INVALIDATED_EVENT = "camera-photo-identity-invalidated";
export const PHOTO_IDENTITY_MAY_HAVE_CHANGED_EVENT = "camera-photo-identity-may-have-changed";
type IdentityInvoke = (command: "camera_photo_identity") => Promise<unknown>;
type InvalidationListen = (
  event: typeof PHOTO_IDENTITY_INVALIDATED_EVENT,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;
const localInvalidations = new EventTarget();
let identityFence = {};

type InvalidationSignal = Readonly<{ invalidated: true }>;

function parseInvalidationSignal(value: unknown): InvalidationSignal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.invalidated === true ? { invalidated: true } : null;
}

/** Reads only the native safe five-field identity. The bearer never enters JS. */
export async function readNativePhotoIdentity(
  signal: AbortSignal,
  { invoke = tauriInvoke, now = Date.now }: { invoke?: IdentityInvoke; now?: () => number } = {},
): Promise<PhotoIdentity | null> {
  const capturedFence = identityFence;
  const identity = await readTrustedMacPhotoIdentity(
    async () => invoke("camera_photo_identity"),
    signal,
    now,
  );
  return capturedFence === identityFence ? identity : null;
}

/** Synchronous UI fence used at logout start, before native cleanup can finish. */
export function invalidateNativePhotoIdentity(): void {
  identityFence = {};
  localInvalidations.dispatchEvent(new Event(PHOTO_IDENTITY_INVALIDATED_EVENT));
}

/** Account restore/login/refresh may have completed; coalescing and reads stay in the bootstrap owner. */
export function notifyNativePhotoIdentityMayHaveChanged(): void {
  localInvalidations.dispatchEvent(new Event(PHOTO_IDENTITY_MAY_HAVE_CHANGED_EVENT));
}

export type NativePhotoIdentityWatch = Readonly<{
  invalidated(): void;
  mayHaveChanged(): void;
}>;

/** Subscribes to both the synchronous UI fence and the native account invalidation event. */
export async function watchNativePhotoIdentityInvalidation(
  handler: () => void,
  { listen = tauriListen }: { listen?: InvalidationListen } = {},
): Promise<() => void> {
  const local = () => handler();
  localInvalidations.addEventListener(PHOTO_IDENTITY_INVALIDATED_EVENT, local);
  try {
    const unlisten = await listen(PHOTO_IDENTITY_INVALIDATED_EVENT, (event) => {
      if (parseInvalidationSignal(event.payload)) {
        identityFence = {};
        handler();
      }
    });
    return () => {
      localInvalidations.removeEventListener(PHOTO_IDENTITY_INVALIDATED_EVENT, local);
      unlisten();
    };
  } catch (error) {
    localInvalidations.removeEventListener(PHOTO_IDENTITY_INVALIDATED_EVENT, local);
    throw error;
  }
}

/** Registers both fences before the bootstrap performs its first identity read. */
export async function watchNativePhotoIdentity(
  watch: NativePhotoIdentityWatch,
  options: { listen?: InvalidationListen } = {},
): Promise<() => void> {
  const changed = () => watch.mayHaveChanged();
  localInvalidations.addEventListener(PHOTO_IDENTITY_MAY_HAVE_CHANGED_EVENT, changed);
  try {
    const stopInvalidation = await watchNativePhotoIdentityInvalidation(watch.invalidated, options);
    return () => {
      localInvalidations.removeEventListener(PHOTO_IDENTITY_MAY_HAVE_CHANGED_EVENT, changed);
      stopInvalidation();
    };
  } catch (error) {
    localInvalidations.removeEventListener(PHOTO_IDENTITY_MAY_HAVE_CHANGED_EVENT, changed);
    throw error;
  }
}
