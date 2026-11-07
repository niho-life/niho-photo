import { describe, expect, it } from "vitest";

import { encodeRenderJobRequest, validateRenderJobRequest, validateRenderJobResponse } from "../src/render-executor";
import { bindingFor, recipeFor } from "./render-support";

const recipe = recipeFor(1);
const job = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  purpose: { kind: "albumItem", albumId: "album-1", itemId: "item-1", itemRevision: 0 },
  executor: { kind: "userDevice", userId: "user-1" },
  photo: { libraryId: "library-1", photoId: "photo-1" },
  binding: bindingFor("c".repeat(64), recipe),
  recipe,
  state: "claimed",
  attempt: 1,
  createdAt: "2026-11-07T00:00:00.000Z",
  leaseExpiresAt: "2026-11-07T00:15:00.000Z",
  failure: null,
  expectedOutput: { width: 1200, height: 800 },
  ...overrides,
});
const claimed = (value: Record<string, unknown> = {}) => ({ job: job(value), lease: { jobId: "job-1", leaseToken: "lease-token", expiresAt: "2026-11-07T00:15:00.000Z" } });
const ticket = { url: "https://storage.googleapis.com/synthetic/u1", method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: "2026-11-07T00:30:00.000Z", resumeOffsetBytes: 0 };
const rendition = { kind: "rendition", sizeBytes: 100, sha256: "b".repeat(64), contentType: "image/jpeg", width: 10, height: 10, metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 } } as const;

const refused = (run: () => unknown) => expect(run).toThrow();

describe("render job wire (B07 on USER_RENDER_ROUTES)", () => {
  it("places each operation on the contract's user render table with its key rule", () => {
    expect(encodeRenderJobRequest("renderJobs.claim", { maxJobs: 2, purposes: ["albumItem"], prefer: { photoIds: ["photo-1"] } }, "key-1")).toMatchObject({ method: "POST", path: "/cloud/sharing/v1/render-jobs/claim", idempotencyKey: "key-1" });
    expect(encodeRenderJobRequest("renderJobs.renewOutput", { jobId: "job-1", leaseToken: "lease-token", uploadId: "u1" }, undefined)).toMatchObject({ path: "/cloud/sharing/v1/render-jobs/job-1/outputs/u1/renew", idempotencyKey: null });
    refused(() => encodeRenderJobRequest("renderJobs.claim", {}, undefined));
    refused(() => encodeRenderJobRequest("renderJobs.renewOutput", { jobId: "job-1", leaseToken: "lease-token", uploadId: "u1" }, "key"));
    refused(() => encodeRenderJobRequest("connector.heartbeat", {}, undefined));
  });

  it("refuses requests outside the contract's values", () => {
    for (const request of [
      { maxJobs: 0 }, { maxJobs: 17 }, { purposes: [] }, { purposes: ["albumItem", "albumItem"] }, { purposes: ["other"] },
      { prefer: { photoIds: Array.from({ length: 61 }, (_, index) => `p${index}`) } }, { prefer: { photoIds: ["a/b"] } }, { extra: true },
    ]) refused(() => validateRenderJobRequest("renderJobs.claim", request));
    refused(() => validateRenderJobRequest("renderJobs.fail", { jobId: "job-1", leaseToken: "lease-token", code: "other" }));
    refused(() => validateRenderJobRequest("renderJobs.commit", { jobId: "job-1", leaseToken: "has space", uploadId: "u1" }));
    refused(() => validateRenderJobRequest("renderJobs.startOutput", { jobId: "job-1", leaseToken: "t", output: { ...rendition, contentType: "image/png" } }));
    refused(() => validateRenderJobRequest("renderJobs.startOutput", { jobId: "job-1", leaseToken: "t", output: { ...rendition, metadata: { gps: "x" } } }));
    refused(() => validateRenderJobRequest("renderJobs.startOutput", { jobId: "job-1", leaseToken: "t", output: { ...rendition, width: 100_000, height: 100_000 } }));
    expect(() => validateRenderJobRequest("renderJobs.startOutput", { jobId: "job-1", leaseToken: "t", output: rendition })).not.toThrow();
  });

  it("refuses answers that are not the contract's shape or do not answer the request", () => {
    const claim = (jobs: unknown[], maxJobs = 2) => () => validateRenderJobResponse("renderJobs.claim", { maxJobs }, { value: { jobs }, replayed: false });
    expect(claim([claimed()])).not.toThrow();
    refused(claim([claimed(), claimed()]));
    refused(claim([claimed()], 0));
    refused(claim([claimed({ executor: { kind: "hostedMac", connectorId: "c1" } })]));
    refused(claim([claimed({ state: "queued" })]));
    refused(claim([{ ...claimed(), lease: { jobId: "job-2", leaseToken: "t", expiresAt: "2026-11-07T00:15:00.000Z" } }]));
    refused(claim([claimed({ recipe: { ...recipe, settings: { engine: "niho-14" } } })]));
    refused(claim([claimed({ ownerEmail: "someone@example.test" })]));

    const start = { jobId: "job-1", leaseToken: "t", output: rendition };
    expect(() => validateRenderJobResponse("renderJobs.startOutput", start, { value: { uploadId: "u1", expiresAt: "2026-11-07T00:30:00.000Z", ticket }, replayed: false })).not.toThrow();
    refused(() => validateRenderJobResponse("renderJobs.startOutput", start, { value: { uploadId: "u1", expiresAt: "2026-11-07T00:30:00.000Z", ticket }, replayed: true }));
    refused(() => validateRenderJobResponse("renderJobs.startOutput", start, { value: { uploadId: "u1", expiresAt: "2026-11-07T00:30:00.000Z", ticket: null }, replayed: false }));
    refused(() => validateRenderJobResponse("renderJobs.renewOutput", { jobId: "job-1", leaseToken: "t", uploadId: "u1" }, { uploadId: "u2", expiresAt: "2026-11-07T00:30:00.000Z", ticket }));
    refused(() => validateRenderJobResponse("renderJobs.commit", { jobId: "job-1", leaseToken: "t", uploadId: "u1" }, { value: job({ id: "job-2" }), replayed: false }));
    expect(() => validateRenderJobResponse("renderJobs.fail", { jobId: "job-1", leaseToken: "t", code: "decoder_failed" }, { value: job({ state: "failed", failure: "decoder_failed", leaseExpiresAt: null }), replayed: false })).not.toThrow();
  });
});
