import { canonical } from "../../photo-library-sharing-contract/src/policy.ts";
import { SHARING_ERROR_STATUS } from "../../photo-library-sharing-contract/src/v1.ts";
import type { SharingErrorCode } from "../../photo-library-sharing-contract/src/v1.ts";

/** Local failures of this core. Contract errors keep their SharingErrorCode. */
export type HostedLibraryErrorCode =
  | SharingErrorCode
  | "invalid_response"
  | "integrity_mismatch"
  | "store_conflict"
  | "incomplete_replica"
  | "aborted";

/** Fixed diagnostics only: never paths, bytes, URLs or upstream messages. */
export class HostedLibraryError extends Error {
  readonly code: HostedLibraryErrorCode;
  constructor(code: HostedLibraryErrorCode) {
    super(`photo-hosted-library: ${code}`);
    this.name = "HostedLibraryError";
    this.code = code;
  }
}

/** Reads the contract code a transport attached to a thrown error, if any. */
export function sharingErrorCode(error: unknown): SharingErrorCode | null {
  const code = error !== null && typeof error === "object" ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(SHARING_ERROR_STATUS, code) ? (code as SharingErrorCode) : null;
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HostedLibraryError("aborted");
}

const HEX = /^[0-9a-f]{64}$/;
export const isSha256 = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the sorted-key JSON, the same identity the contract uses for recipes and manifests. */
export async function canonicalSha256(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonical(value)));
}

/** Reads a bounded stream completely, rejecting anything larger than maxBytes. */
export async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new HostedLibraryError("integrity_mismatch");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
