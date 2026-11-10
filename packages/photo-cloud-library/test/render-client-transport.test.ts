import { describe, expect, it, vi } from "vitest";

import { createRenderJobClientOnTransport } from "../src/render-executor";
import type { EncodedSharingRequest, SharingTransport } from "../src/sharing";

describe("native render-job client", () => {
  it("uses the same validated render wire over the signed-in native transport", async () => {
    const sent: EncodedSharingRequest<string>[] = [];
    const dispose = vi.fn();
    const transport = {
      scope: { actorId: "user-1", sessionEpoch: "epoch-1" },
      async exchange(encoded: EncodedSharingRequest<string>, _limit: number, signal: AbortSignal) {
        expect(signal.aborted).toBe(false);
        sent.push(encoded);
        return { status: 200, value: { value: { jobs: [] }, replayed: false } };
      },
      async stream() { throw new Error("render-job calls do not stream content"); },
      dispose,
    } satisfies SharingTransport;

    const client = createRenderJobClientOnTransport(transport);
    const result = await client.request(
      "renderJobs.claim",
      { maxJobs: 2, purposes: ["albumItem"] },
      { signal: new AbortController().signal, idempotencyKey: "claim-1" },
    );

    expect(result).toEqual({ value: { jobs: [] }, replayed: false });
    expect(sent).toEqual([{
      operation: "renderJobs.claim",
      method: "POST",
      path: "/cloud/sharing/v1/render-jobs/claim",
      body: new TextEncoder().encode(JSON.stringify({ maxJobs: 2, purposes: ["albumItem"] })),
      idempotencyKey: "claim-1",
    }]);
    client.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
