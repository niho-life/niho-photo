/** Secrets and keyed identifiers. WebCrypto only, so the core runs wherever the connector does. */
import type { StreamHasher } from "./ports.ts";

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
};

/** 256-bit random secret, base64url. */
export function randomSecret(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Text(text: string): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy(new TextEncoder().encode(text)))));
}

/**
 * Opaque localKey for a file: HMAC-SHA256(installSalt, rootId NUL relativePath). Stable for the same file and install,
 * reveals neither the path nor the inode, and can be recomputed by walking the roots after the index was lost.
 */
export async function localKeyFor(installSalt: string, rootId: string, relativePath: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey("raw", copy(new TextEncoder().encode(installSalt)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await globalThis.crypto.subtle.sign("HMAC", key, copy(new TextEncoder().encode(`${rootId}\u0000${relativePath}`)));
  return `lk-${toHex(new Uint8Array(mac))}`;
}

/** Fallback hasher that buffers one file (tests and small files). Platform adapters stream (node: createHash). */
export const bufferingHasher: StreamHasher = {
  async hash(chunks, signal) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      if (signal.aborted) throw new Error("aborted");
      parts.push(chunk);
      total += chunk.byteLength;
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.byteLength;
    }
    return { sha256: toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", all))), bytes: total };
  },
};

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy(bytes))));
}
