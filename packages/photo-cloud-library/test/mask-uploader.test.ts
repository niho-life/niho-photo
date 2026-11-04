import { describe, expect, it, vi } from "vitest";
import type { Upload } from "@niho/photo-personal-cloud-contract";
import { IDS } from "@niho/photo-personal-cloud-contract/fixtures";

import { createBrowserPersonalPhotoCloudMaskUploader } from "../src/browser";
import { maskPngDimensions } from "../src/mask-surface";
import { FakeClient, FakeIdentity, maskPngFixture } from "./support";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const UPLOAD_URL = "https://storage.googleapis.com/synthetic-mask-upload";
const UPLOAD_EXPIRES = "2026-11-03T00:30:00.000Z";
const TICKET_EXPIRES = "2026-11-03T00:10:00.000Z";

function reservedUpload(bytes: Uint8Array, surfaceId: string, uploadedBytes = 0): Upload {
  return {
    id: IDS.upload,
    target: { kind: "mask", photoId: IDS.photo },
    sizeBytes: bytes.byteLength,
    sha256: surfaceId,
    expiresAt: UPLOAD_EXPIRES,
    state: "reserved",
    uploadedBytes,
  };
}

function storedUpload(bytes: Uint8Array, surfaceId: string): Upload {
  return {
    id: IDS.upload,
    target: { kind: "mask", photoId: IDS.photo },
    sizeBytes: bytes.byteLength,
    sha256: surfaceId,
    expiresAt: UPLOAD_EXPIRES,
    state: "stored",
    result: {
      kind: "mask",
      photoId: IDS.photo,
      asset: {
        id: IDS.mask,
        kind: "mask",
        sha256: surfaceId,
        sizeBytes: bytes.byteLength,
        contentType: "image/png",
        width: 1,
        height: 1,
      },
    },
  };
}

function ticket(offset = 0) {
  return {
    url: UPLOAD_URL,
    method: "PUT" as const,
    headers: { "Content-Type": "image/png" },
    expiresAt: TICKET_EXPIRES,
    resumeOffsetBytes: offset,
  };
}

describe("browser mask uploader", () => {
  it("accepts only drawable grayscale PNG surface headers", () => {
    const { bytes } = maskPngFixture();
    expect(maskPngDimensions(bytes)).toEqual({ width: 1, height: 1 });

    const badHeaderChecksum = bytes.slice();
    badHeaderChecksum[29] ^= 1;
    expect(maskPngDimensions(badHeaderChecksum)).toBeNull();

    const noImageData = bytes.slice();
    noImageData.set(new TextEncoder().encode("IEND"), 37);
    expect(maskPngDimensions(noImageData)).toBeNull();
  });

  it("uploads a bounded PNG with a photo-bound target and completes only after stored reconciliation", async () => {
    const { bytes, surfaceId } = maskPngFixture();
    const client = new FakeClient();
    client.dispatch = async (operation, request) => {
      if (operation === "uploads.start") {
        expect(request).toEqual({
          target: { kind: "mask", photoId: IDS.photo },
          sizeBytes: bytes.byteLength,
          sha256: surfaceId,
          contentType: "image/png",
        });
        return { value: { kind: "upload", upload: reservedUpload(bytes, surfaceId), ticket: ticket() }, replayed: false };
      }
      if (operation === "uploads.get") return reservedUpload(bytes, surfaceId, bytes.byteLength);
      if (operation === "uploads.complete") return { value: storedUpload(bytes, surfaceId), replayed: false };
      throw new Error(`unexpected ${operation}`);
    };
    const put = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(UPLOAD_URL);
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.headers).toMatchObject({ "Content-Type": "image/png", "Content-Range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` });
      expect(Array.from(init?.body as Uint8Array)).toEqual(Array.from(bytes));
      return new Response(null, { status: 200 });
    });
    const uploader = createBrowserPersonalPhotoCloudMaskUploader({
      client,
      identity: new FakeIdentity(),
      fetch: put,
      now: () => NOW,
      trustedUploadOrigin: "https://storage.googleapis.com",
    });
    try {
      await expect(uploader.upload({
        photoId: IDS.photo,
        surfaceId,
        bytes,
        idempotencyKey: "mask-start-key",
        signal: new AbortController().signal,
      })).resolves.toBeUndefined();
      expect(client.calls.map((call) => call.operation)).toEqual(["uploads.start", "uploads.get", "uploads.complete"]);
      expect(client.calls[0]?.idempotencyKey).toBe("mask-start-key");
      expect(client.calls[2]?.idempotencyKey).toBe("mask-start-key-complete");
    } finally { uploader.dispose(); }
  });

  it("reconciles an unknown provider result before sending another chunk", async () => {
    const { bytes, surfaceId } = maskPngFixture(64);
    const client = new FakeClient();
    client.dispatch = async (operation) => {
      if (operation === "uploads.start") return { value: { kind: "upload", upload: reservedUpload(bytes, surfaceId), ticket: ticket() }, replayed: false };
      if (operation === "uploads.get") return reservedUpload(bytes, surfaceId, bytes.byteLength);
      if (operation === "uploads.complete") return { value: storedUpload(bytes, surfaceId), replayed: false };
      throw new Error(`unexpected ${operation}`);
    };
    const put = vi.fn(async () => { throw new Error("provider response lost after receiving bytes"); });
    const uploader = createBrowserPersonalPhotoCloudMaskUploader({
      client, identity: new FakeIdentity(), fetch: put, now: () => NOW,
      trustedUploadOrigin: "https://storage.googleapis.com",
    });
    try {
      await expect(uploader.upload({
        photoId: IDS.photo,
        surfaceId,
        bytes,
        idempotencyKey: "mask-unknown-key",
        signal: new AbortController().signal,
      })).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledOnce();
      expect(client.calls.filter((call) => call.operation === "uploads.get")).toHaveLength(1);
      expect(client.calls.filter((call) => call.operation === "uploads.complete")).toHaveLength(1);
    } finally { uploader.dispose(); }
  });
});
