import { responses } from "@niho/photo-personal-cloud-contract/fixtures";
import { describe, expect, it } from "vitest";

import {
  cancelPersonalPhotoResumableUpload,
  runPersonalPhotoResumableUpload,
  type PersonalPhotoResumableUploadState,
} from "../src/browser";
import { FakeClient } from "./support";

const SHA = "a".repeat(64);
const PHOTO_ID = "photo-mask-owner";
const DEADLINE = "2026-11-03T00:30:00.000Z";
const NOW = Date.parse("2026-11-03T00:00:00.000Z");

function state(overrides: Partial<PersonalPhotoResumableUploadState> = {}): PersonalPhotoResumableUploadState {
  return {
    target: { kind: "mask", photoId: PHOTO_ID },
    sizeBytes: 3,
    sha256: SHA,
    contentType: "image/png",
    startKey: "start-key",
    completeKey: "complete-key",
    cancelKey: "cancel-key",
    uploadId: null,
    deadline: null,
    offsetBytes: 0,
    phase: "start-pending",
    ...overrides,
  };
}

function upload(current: PersonalPhotoResumableUploadState, uploadedBytes = 0) {
  return {
    id: current.uploadId ?? "upload-mask",
    target: current.target,
    sizeBytes: current.sizeBytes,
    sha256: current.sha256,
    expiresAt: current.deadline ?? DEADLINE,
    state: "reserved" as const,
    uploadedBytes,
  };
}

function stored(current: PersonalPhotoResumableUploadState, overrides: Record<string, unknown> = {}) {
  return {
    ...upload(current, current.sizeBytes),
    state: "stored" as const,
    result: {
      kind: "mask" as const,
      photoId: PHOTO_ID,
      asset: {
        ...responses["masks.get"],
        id: SHA,
        sha256: SHA,
        sizeBytes: current.sizeBytes,
        width: 1,
        height: 1,
      },
    },
    ...overrides,
  };
}

function harness(initial: PersonalPhotoResumableUploadState, client = new FakeClient()) {
  let durable = structuredClone(initial);
  const persisted: string[] = [];
  const store = {
    async compareAndSet(expected: PersonalPhotoResumableUploadState, next: PersonalPhotoResumableUploadState) {
      expect(expected).toEqual(durable);
      durable = structuredClone(next);
      persisted.push(JSON.stringify(next));
    },
  };
  const options = { client, state: initial, source: new Blob([new Uint8Array([1, 2, 3])]), store, signal: new AbortController().signal, now: () => NOW, trustedUploadOrigin: "https://upload.example.test" };
  return { client, options, persisted, durable: () => durable };
}

describe("target-independent resumable upload", () => {
  it.each(["run", "cancel"] as const)("requires a durable state before %s can send a mutation", async (operation) => {
    const run = harness(state({ phase: operation === "cancel" ? "cancel-pending" : "start-pending" }));
    const options = { ...run.options, store: { async compareAndSet() { throw new Error("not durable"); } } };
    const execute = operation === "cancel" ? cancelPersonalPhotoResumableUpload : runPersonalPhotoResumableUpload;
    await expect(execute(options)).rejects.toThrow("not durable");
    expect(run.client.calls).toHaveLength(0);
  });

  it("preserves the first cloud file name when the same original is deduplicated", async () => {
    const initial = state({ target: { kind: "original", fileName: "renamed.jpg", format: "jpeg" }, contentType: "image/jpeg" });
    const run = harness(initial);
    const photo = { ...responses["photos.get"], fileName: "first.jpg", format: "jpeg" as const,
      original: { ...responses["photos.get"].original, sha256: SHA, sizeBytes: 3, contentType: "image/jpeg" } };
    run.client.dispatch = async () => ({ value: { kind: "existing", photo }, replayed: false });
    expect((await runPersonalPhotoResumableUpload(run.options)).existingPhoto?.fileName).toBe("first.jpg");

    run.client.dispatch = async () => ({ value: { kind: "upload", upload: { ...upload(initial),
      target: { kind: "original", fileName: "first.jpg", format: "jpeg" }, state: "verifying", jobId: "job" }, ticket: null }, replayed: false });
    expect((await runPersonalPhotoResumableUpload({ ...run.options, state: run.durable() })).state.phase).toBe("verifying");
  });

  it.each([
    ["format", { format: "png" }],
    ["content-type", { original: { ...responses["photos.get"].original, sha256: SHA, sizeBytes: 3, contentType: "image/png" } }],
    ["asset-kind", { original: { ...responses["photos.get"].original, sha256: SHA, sizeBytes: 3, contentType: "image/jpeg", kind: "mask" } }],
  ] as const)("rejects mismatched original %s", async (_name, mismatch) => {
    const initial = state({ target: { kind: "original", fileName: "photo.jpg", format: "jpeg" }, contentType: "image/jpeg" });
    const run = harness(initial);
    run.client.dispatch = async () => ({ value: { kind: "existing", photo: { ...responses["photos.get"], format: "jpeg",
      original: { ...responses["photos.get"].original, sha256: SHA, sizeBytes: 3, contentType: "image/jpeg" }, ...mismatch } }, replayed: false });
    expect((await runPersonalPhotoResumableUpload(run.options)).error).toBeTruthy();
  });

  it("replays an unknown mask start with the same durable key and never persists its ticket", async () => {
    const first = harness(state());
    first.client.dispatch = async () => { throw new Error("lost"); };
    expect((await runPersonalPhotoResumableUpload(first.options)).state.phase).toBe("start-pending");

    first.client.dispatch = async (operation, request) => {
      expect(operation).toBe("uploads.start");
      const current = state();
      expect(request).toMatchObject({ target: current.target, sha256: SHA, sizeBytes: 3 });
      return { value: { kind: "upload", upload: { ...upload(current), state: "verifying", jobId: "job" }, ticket: null }, replayed: true };
    };
    const replay = await runPersonalPhotoResumableUpload({ ...first.options, state: first.durable() });
    expect(replay.state.phase).toBe("verifying");
    expect(first.client.calls.filter((call) => call.operation === "uploads.start").map((call) => call.idempotencyKey)).toEqual(["start-key", "start-key"]);
    expect(first.persisted.join(" ")).not.toMatch(/ticket|url|headers|credential|upload\.example/i);
  });

  it("replays a lost complete ACK with the same receipt and validates the stored mask binding", async () => {
    const initial = state({ phase: "complete-pending", uploadId: "upload-mask", deadline: DEADLINE, offsetBytes: 3 });
    const run = harness(initial);
    let completes = 0;
    run.client.dispatch = async (operation) => {
      if (operation === "uploads.get") return upload(initial, 3);
      if (operation === "uploads.complete") {
        completes += 1;
        if (completes === 1) throw new Error("lost");
        return { value: stored(initial), replayed: true };
      }
      throw new Error(`unexpected ${operation}`);
    };
    expect((await runPersonalPhotoResumableUpload(run.options)).error).toBeTruthy();
    const replay = await runPersonalPhotoResumableUpload({ ...run.options, state: run.durable() });
    expect(replay.stored).toMatchObject({ kind: "mask", photoId: PHOTO_ID, asset: { sha256: SHA, sizeBytes: 3 } });
    expect(run.client.calls.filter((call) => call.operation === "uploads.complete").map((call) => call.idempotencyKey)).toEqual(["complete-key", "complete-key"]);
  });

  it.each([
    ["target", { target: { kind: "mask", photoId: "other-photo" } }],
    ["sha", { sha256: "b".repeat(64) }],
    ["size", { sizeBytes: 2 }],
    ["result-photo", { result: { kind: "mask", photoId: "other-photo", asset: { ...responses["masks.get"], id: SHA, sha256: SHA, sizeBytes: 3, width: 1, height: 1 } } }],
  ] as const)("rejects a stored mask with a mismatched %s", async (_name, mismatch) => {
    const initial = state({ phase: "verifying", uploadId: "upload-mask", deadline: DEADLINE, offsetBytes: 3 });
    const run = harness(initial);
    run.client.dispatch = async () => ({ ...stored(initial), ...mismatch });
    expect((await runPersonalPhotoResumableUpload(run.options)).error).toBeTruthy();
  });

  it("reconciles an unknown start before cancelling its reservation with the fixed keys", async () => {
    const initial = state({ phase: "cancel-pending" });
    const run = harness(initial);
    run.client.dispatch = async (operation) => {
      if (operation === "uploads.start") return { value: { kind: "upload", upload: upload(initial), ticket: null }, replayed: true };
      if (operation === "uploads.cancel") return { value: { ...upload({ ...initial, uploadId: "upload-mask", deadline: DEADLINE }), state: "cancelled" }, replayed: false };
      throw new Error(`unexpected ${operation}`);
    };
    expect((await cancelPersonalPhotoResumableUpload(run.options)).state.phase).toBe("cancelled");
    expect(run.client.calls.map((call) => [call.operation, call.idempotencyKey])).toEqual([
      ["uploads.start", "start-key"],
      ["uploads.cancel", "cancel-key"],
    ]);
  });
});
