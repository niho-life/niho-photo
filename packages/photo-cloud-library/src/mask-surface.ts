import { sha256 } from "@noble/hashes/sha2.js";

export function hashMaskSurface(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
