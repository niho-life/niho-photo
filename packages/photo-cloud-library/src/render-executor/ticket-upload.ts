/**
 * Uploads one finished output to the ticket `renderJobs.startOutput` returned (#195 bearer ticket). Reuses the personal
 * upload's ticket validation (trusted origin, expiry, size, content type) and its provider chunk protocol; the ticket
 * stays in memory only and is never logged.
 */
import { PersonalPhotoCloudError } from "../errors";
import { putProviderChunk } from "../browser/resumable-upload";
import { GCS_CHUNK_BYTES, TRUSTED_GCS_UPLOAD_ORIGIN, validateTicket } from "../wire";

import type { UploadTicket } from "./contract";

/** The executor's upload port: put these exact bytes behind this ticket, or throw. */
export interface RenderOutputUploader {
  upload(ticket: UploadTicket, bytes: Uint8Array, contentType: string, signal: AbortSignal): Promise<void>;
}

export interface CreateTicketUploaderOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly trustedUploadOrigin?: string;
}

const MAX_CHUNK_STEPS = 64;

export function createTicketUploader(options: CreateTicketUploaderOptions = {}): RenderOutputUploader {
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const now = options.now ?? Date.now;
  const trustedOrigin = options.trustedUploadOrigin ?? TRUSTED_GCS_UPLOAD_ORIGIN;
  return {
    async upload(raw, bytes, contentType, signal) {
      const ticket = validateTicket(raw, { trustedOrigin, expectedContentType: contentType, expectedSize: bytes.byteLength, now: now() });
      // A ticket resumed at the end means the provider already holds every byte.
      if (ticket.resumeOffsetBytes === bytes.byteLength) return;
      const source = new Blob([bytes.slice()], { type: contentType });
      let offset = ticket.resumeOffsetBytes;
      for (let step = 0; step < MAX_CHUNK_STEPS; step += 1) {
        const endExclusive = Math.min(offset + GCS_CHUNK_BYTES, bytes.byteLength);
        const result = await putProviderChunk(
          { fetch: fetchFn, url: ticket.url, contentType, source, start: offset, endExclusive, totalBytes: bytes.byteLength },
          signal,
        );
        if (result.offsetBytes !== null) {
          // 308: the provider confirms how much it has. Continue from there; no progress at all is a failure.
          if (result.offsetBytes <= offset) throw new PersonalPhotoCloudError("unavailable");
          if (result.offsetBytes === bytes.byteLength) return;
          offset = result.offsetBytes;
          continue;
        }
        if (endExclusive === bytes.byteLength && (result.status === 200 || result.status === 201)) return;
        throw new PersonalPhotoCloudError("unavailable");
      }
      throw new PersonalPhotoCloudError("unavailable");
    },
  };
}
