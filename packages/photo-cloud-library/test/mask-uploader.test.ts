import { describe, expect, it, vi } from "vitest";
import type { Upload } from "@niho/photo-personal-cloud-contract";
import { IDS, responses } from "@niho/photo-personal-cloud-contract/fixtures";

import { createBrowserPersonalPhotoCloudMaskUploader } from "../src/browser";
import type { PersonalPhotoResumableUploadState } from "../src/browser";
import { validateMaskSurfaceBytes } from "../src/mask-surface";
import { FakeClient, FakeIdentity, maskPngFixture, testMaskValidator } from "./support";

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

function uploadInput(bytes: Uint8Array, surfaceId: string, idempotencyKey: string, signal: AbortSignal) {
  let current: PersonalPhotoResumableUploadState = {
    target: { kind: "mask", photoId: IDS.photo },
    sizeBytes: bytes.byteLength,
    sha256: surfaceId,
    contentType: "image/png",
    startKey: idempotencyKey,
    completeKey: `${idempotencyKey}-complete`,
    cancelKey: `${idempotencyKey}-cancel`,
    uploadId: null,
    deadline: null,
    offsetBytes: 0,
    phase: "start-pending",
  };
  const transitions: string[] = [current.phase];
  return {
    photoId: IDS.photo,
    surfaceId,
    bytes,
    idempotencyKey,
    uploadState: current,
    transitions,
    async compareAndSetUploadState(expected: PersonalPhotoResumableUploadState, next: PersonalPhotoResumableUploadState) {
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      current = structuredClone(next);
      transitions.push(next.phase);
      return true;
    },
    signal,
  };
}

describe("browser mask uploader", () => {
  it("delegates PNG drawability to the common SDK decoder and binds validation to the content hash", async () => {
    const { bytes, surfaceId } = maskPngFixture();
    const signal = new AbortController().signal;
    await expect(validateMaskSurfaceBytes(bytes, surfaceId, testMaskValidator, signal)).resolves.toEqual({ width: 1, height: 1 });

    const wrongHash = bytes.slice();
    wrongHash[29] ^= 1;
    await expect(validateMaskSurfaceBytes(wrongHash, surfaceId, testMaskValidator, signal)).resolves.toBeNull();

    const rejectingDecoder = { validateMaskSurface: vi.fn(async () => { throw new Error("mask PNG decoder rejected bytes"); }) };
    await expect(validateMaskSurfaceBytes(bytes, surfaceId, rejectingDecoder, signal)).resolves.toBeNull();
    expect(rejectingDecoder.validateMaskSurface).toHaveBeenCalledOnce();
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
      const input = uploadInput(bytes, surfaceId, "mask-start-key", new AbortController().signal);
      await expect(uploader.upload(input))
        .resolves.toBeUndefined();
      expect(client.calls.map((call) => call.operation)).toEqual(["uploads.start", "uploads.get", "uploads.complete"]);
      expect(client.calls[0]?.idempotencyKey).toBe("mask-start-key");
      expect(client.calls[2]?.idempotencyKey).toBe("mask-start-key-complete");
      expect(input.transitions).toContain("uploading");
      expect(input.transitions).toContain("complete-pending");
      expect(input.transitions).toContain("verifying");
    } finally { uploader.dispose(); }
  });

  it("lets the adapter reconcile an existing start through a fresh mask readback", async () => {
    const { bytes, surfaceId } = maskPngFixture();
    const client = new FakeClient();
    client.dispatch = async (operation) => {
      if (operation === "uploads.start") return { value: { kind: "existing", photo: responses["photos.get"] }, replayed: true };
      throw new Error(`unexpected ${operation}`);
    };
    const put = vi.fn();
    const uploader = createBrowserPersonalPhotoCloudMaskUploader({
      client, identity: new FakeIdentity(), fetch: put, now: () => NOW,
      trustedUploadOrigin: "https://storage.googleapis.com",
    });
    try {
      await expect(uploader.upload(uploadInput(bytes, surfaceId, "mask-existing", new AbortController().signal)))
        .resolves.toBeUndefined();
      expect(client.calls.map((call) => call.operation)).toEqual(["uploads.start"]);
      expect(put).not.toHaveBeenCalled();
    } finally { uploader.dispose(); }
  });

  it("rejects an existing upload receipt bound to a different library", async () => {
    const { bytes, surfaceId } = maskPngFixture();
    const client = new FakeClient();
    client.dispatch = async (operation) => {
      if (operation === "uploads.start") {
        return { value: { kind: "existing", photo: { ...responses["photos.get"], libraryId: IDS.library + "-other" } }, replayed: true };
      }
      throw new Error(`unexpected ${operation}`);
    };
    const uploader = createBrowserPersonalPhotoCloudMaskUploader({ client, identity: new FakeIdentity(), fetch: vi.fn() });
    try {
      await expect(uploader.upload(uploadInput(bytes, surfaceId, "mask-wrong-library", new AbortController().signal)))
        .rejects.toMatchObject({ code: "invalid_response" });
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
      await expect(uploader.upload(uploadInput(bytes, surfaceId, "mask-unknown-key", new AbortController().signal)))
        .resolves.toBeUndefined();
      expect(put).toHaveBeenCalledOnce();
      expect(client.calls.filter((call) => call.operation === "uploads.get")).toHaveLength(1);
      expect(client.calls.filter((call) => call.operation === "uploads.complete")).toHaveLength(1);
    } finally { uploader.dispose(); }
  });
});
