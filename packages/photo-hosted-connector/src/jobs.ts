/**
 * Render jobs on the hosted Mac (B03 #244 plumbing, B07 #248 executors). The connector claims only jobs it has an
 * executor for, resolves the original read-only from its own index, checks the job's source binding, keeps the Mac
 * awake while running, and uploads only the executor's output. Originals never leave the Mac.
 */
import type { HostConnectorClient, RenderFailureCode, RenderJob } from "../../photo-library-sharing-contract/src/v1.ts";
import { sha256Bytes } from "./crypto.ts";
import type { JobExecutors, LocalIndexStore, OutputUploader, PowerAssertions, RegisteredRoot, RootFileSystem } from "./ports.ts";

export interface JobStepResult {
  readonly claimed: number;
  readonly committed: number;
  readonly failed: number;
  readonly dropped: number;
  readonly uploadedBytes: number;
}

const codeOf = (error: unknown): string | null => {
  const code = error !== null && typeof error === "object" ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
};
class JobFailure extends Error {
  readonly failure: RenderFailureCode;
  constructor(failure: RenderFailureCode) {
    super(`render job failed: ${failure}`);
    this.failure = failure;
  }
}

export function createJobRunner(options: {
  readonly executors: JobExecutors;
  readonly store: LocalIndexStore;
  readonly fs: RootFileSystem;
  readonly roots: readonly RegisteredRoot[];
  readonly power: PowerAssertions;
  readonly uploader: OutputUploader;
}) {
  const roots = new Map(options.roots.map((root) => [root.id, root]));
  const purposes = (Object.keys(options.executors) as RenderJob["purpose"]["kind"][]).filter((kind) => options.executors[kind]);

  const runOne = async (client: Pick<HostConnectorClient, "request">, job: RenderJob, leaseToken: string, signal: AbortSignal): Promise<number> => {
    const executor = options.executors[job.purpose.kind];
    if (!executor) throw new JobFailure("renderer_unavailable");
    const entry = await options.store.byPhotoId(job.photo.photoId);
    const root = entry ? roots.get(entry.rootId) : undefined;
    if (!entry || !root || entry.excluded || entry.state !== "present") throw new JobFailure("source_missing");
    // Render only the exact bytes the job is bound to; held or changed originals are never rendered.
    if (entry.hold || entry.sha256 !== job.binding.sourceSha256) throw new JobFailure("source_changed");
    const original = await options.fs.open(root, entry.relativePath, signal).catch(() => { throw new JobFailure("source_missing"); });
    try {
      if (original.sizeBytes !== entry.sizeBytes || original.mtimeMs !== entry.mtimeMs || original.fileId !== entry.fileId) {
        throw new JobFailure("source_changed");
      }
      const output = await executor.run({ job, original, signal });
      const expected = job.purpose.kind === "preview" ? "preview" : "rendition";
      if (output.request.kind !== expected || output.bytes.byteLength !== output.request.sizeBytes || (await sha256Bytes(output.bytes)) !== output.request.sha256) {
        throw new JobFailure("renderer_unavailable");
      }
      const started = await client.request(
        "renderJobs.startOutput",
        { jobId: job.id, leaseToken, output: output.request },
        { signal, idempotencyKey: `job-${job.id}-${job.attempt}-output` },
      );
      const ticket = started.value.ticket;
      if (ticket) await options.uploader.put(ticket, output.bytes, signal);
      await client.request(
        "renderJobs.commit",
        { jobId: job.id, leaseToken, uploadId: started.value.uploadId },
        { signal, idempotencyKey: `job-${job.id}-${job.attempt}-commit` },
      );
      return output.bytes.byteLength;
    } finally {
      await original.close();
    }
  };

  return {
    purposes: () => purposes,
    async step(client: Pick<HostConnectorClient, "request">, signal: AbortSignal, maxJobs: number): Promise<JobStepResult> {
      if (!purposes.length) return { claimed: 0, committed: 0, failed: 0, dropped: 0, uploadedBytes: 0 };
      const claimed = await client.request("renderJobs.claim", { maxJobs, purposes }, { signal });
      let committed = 0;
      let failed = 0;
      let dropped = 0;
      let uploadedBytes = 0;
      if (!claimed.jobs.length) return { claimed: 0, committed, failed, dropped, uploadedBytes };
      const hold = await options.power.hold("jobs");
      try {
        for (const { job, lease } of claimed.jobs) {
          if (signal.aborted) break;
          try {
            uploadedBytes += await runOne(client, job, lease.leaseToken, signal);
            committed++;
          } catch (error) {
            if (error instanceof JobFailure) {
              await client.request(
                "renderJobs.fail",
                { jobId: job.id, leaseToken: lease.leaseToken, code: error.failure },
                { signal, idempotencyKey: `job-${job.id}-${job.attempt}-fail` },
              ).catch(() => undefined);
              failed++;
              continue;
            }
            const code = codeOf(error);
            // A newer job or an expired lease made this result obsolete: drop it without retrying.
            if (code === "stale_render" || code === "lease_expired" || code === "item_removed" || code === "not_found") {
              dropped++;
              continue;
            }
            throw error;
          }
        }
      } finally {
        await hold.release();
      }
      return { claimed: claimed.jobs.length, committed, failed, dropped, uploadedBytes };
    },
  };
}
export type JobRunner = ReturnType<typeof createJobRunner>;
