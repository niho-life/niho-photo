import { Buffer } from "node:buffer";

import type { PhotoWebCloudHandler } from "./types.ts";

/**
 * Private ops configuration of the pending-invite cookie (B05 #246): the AES-256 keys and the trusted upstream prefix
 * of the sharing routes. Like the rest of the BFF settings they come from the runtime environment that the private
 * operations side supplies; no value lives in source, and errors never echo one.
 */
export const PHOTO_WEB_PENDING_INVITE_ENV = Object.freeze({
  /** One or two base64url keys of 32 bytes, comma separated: the first seals, both open (rotation). */
  keys: "PHOTO_WEB_PENDING_INVITE_KEYS",
  upstreamPathPrefix: "PHOTO_WEB_SHARING_UPSTREAM_PATH_PREFIX",
});

export interface PhotoWebPendingInviteConfiguration {
  readonly keys: readonly Uint8Array[];
  readonly upstreamPathPrefix: string;
}

const KEY = /^[A-Za-z0-9_-]{43}$/u;

/** Both set: the routes are served. Neither set: they are not mounted. One without the other refuses to start. */
export function readPhotoWebPendingInviteConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): PhotoWebPendingInviteConfiguration | null {
  const keys = env[PHOTO_WEB_PENDING_INVITE_ENV.keys];
  const upstreamPathPrefix = env[PHOTO_WEB_PENDING_INVITE_ENV.upstreamPathPrefix];
  if (keys === undefined && upstreamPathPrefix === undefined) return null;
  if (keys === undefined || upstreamPathPrefix === undefined) throw new Error("Photo Web pending invite configuration is incomplete");
  const values = keys.split(",").map((value) => value.trim());
  if (values.length < 1 || values.length > 2 || values.some((value) => !KEY.test(value))) {
    throw new Error("Photo Web pending invite keys are invalid");
  }
  const decoded = values.map((value) => Uint8Array.from(Buffer.from(value, "base64url")));
  if (decoded.some((key) => key.byteLength !== 32)) throw new Error("Photo Web pending invite keys are invalid");
  return Object.freeze({ keys: Object.freeze(decoded), upstreamPathPrefix });
}

/** The pending-invite routes first; anything they do not answer goes to the next handler. */
export function chainPhotoWebCloudHandlers(first: PhotoWebCloudHandler, next: PhotoWebCloudHandler): PhotoWebCloudHandler {
  return async (request) => (await first(request)) ?? (await next(request));
}
