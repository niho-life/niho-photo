import { parsePhotoIdentity, type PhotoIdentity } from "./identity.ts";
import { PhotoSessionHostError } from "./controller.ts";

export const PHOTO_MAC_CLIENT_ID = "niho-camera" as const;

/** Trusted native code may expose metadata only. A token accessor is intentionally absent. */
export type TrustedMacPhotoIdentityReader = (signal: AbortSignal) => Promise<unknown | null>;

export async function readTrustedMacPhotoIdentity(
  reader: TrustedMacPhotoIdentityReader,
  signal: AbortSignal,
  now: () => number,
): Promise<PhotoIdentity | null> {
  if (signal.aborted) return null;
  try {
    const value = await reader(signal);
    if (signal.aborted || value === null) return null;
    const identity = parsePhotoIdentity(value, { now: now(), requiredTransport: "mac-bearer" });
    return signal.aborted ? null : identity;
  } catch (error) {
    if (signal.aborted) return null;
    if (error instanceof PhotoSessionHostError) throw error;
    throw new PhotoSessionHostError("temporarily-unavailable");
  }
}
