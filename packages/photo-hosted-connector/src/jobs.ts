/**
 * Render jobs on the hosted Mac (B03 #244 plumbing, B07 #248 executors). The connector claims only jobs it has an
 * executor for, resolves the original read-only from its own index, checks the job's source binding, keeps the Mac
 * awake while running, and uploads only the executor's output. Originals never leave the Mac.
 */
import type { ConnectorOperationMap, HostConnectorClient, RenderFailureCode, RenderJob } from "../../photo-library-sharing-contract/src/v1.ts";
import { randomSecret, sha256Bytes } from "./crypto.ts";
import type {
  JobExecutors,
  LocalIndexStore,
  OpenedFile,
  OutputUploader,
  PowerAssertions,
  RegisteredRoot,
  RootFileSystem,
  StreamHasher,
} from "./ports.ts";

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

type Client = Pick<HostConnectorClient, "request">;
/**
 * Keyed job requests (claim, start, commit) are retried once with the same key when the answer was lost: a claim
 * would otherwise strand the jobs it leased until the lease expires. Answers the server gave are never retried.
 */
async function sendKeyed<O extends "renderJobs.claim" | "renderJobs.startOutput" | "renderJobs.commit">(
  client: Client,
  operation: O,
  body: ConnectorOperationMap[O]["request"],
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<ConnectorOperationMap[O]["response"]> {
  const send = () => client.request(operation, body, { signal, idempotencyKey } as never);
  try {
    return await send();
  } catch (error) {
    if (codeOf(error) !== null || signal.aborted) throw error;
    return send();
  }
}

/** Chunks pushed by one producer, consumed once by the hasher. */
function chunkQueue() {
  const items: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  return {
    push(chunk: Uint8Array) {
      items.push(chunk);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *iterate(): AsyncIterable<Uint8Array> {
      for (;;) {
        const next = items.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
      }
    },
  };
}

/**
 * One sequential pass over the original for the executor, hashing every byte it reads; `finish` reads whatever the
 * executor left and returns the hash of the whole file. The output is only kept when that hash is the job's.
 */
function verifiedPass(original: OpenedFile, hasher: StreamHasher, signal: AbortSignal) {
  const queue = chunkQueue();
  const hashed = hasher.hash(queue.iterate(), signal);
  let source: AsyncIterator<Uint8Array> | null = null;
  let done = false;
  const pull = async (): Promise<Uint8Array | null> => {
    source ??= original.read(signal)[Symbol.asyncIterator]();
    const next = await source.next();
    if (next.done) {
      done = true;
      return null;
    }
    queue.push(next.value);
    return next.value;
  };
  let started = false;
  const file: OpenedFile = {
    sizeBytes: original.sizeBytes,
    mtimeMs: original.mtimeMs,
    fileId: original.fileId,
    changeToken: original.changeToken,
    async *read() {
      if (started) throw new Error("single pass");
      started = true;
      for (;;) {
        const chunk = await pull();
        if (!chunk) return;
        yield chunk;
      }
    },
    close: async () => {},
  };
  return {
    file,
    async finish() {
      while (!done) await pull();
      queue.end();
      return hashed;
    },
  };
}

export function createJobRunner(options: {
  readonly executors: JobExecutors;
  readonly store: LocalIndexStore;
  readonly fs: RootFileSystem;
  readonly roots: readonly RegisteredRoot[];
  readonly power: PowerAssertions;
  readonly uploader: OutputUploader;
  readonly hasher: StreamHasher;
}) {
  const roots = new Map(options.roots.map((root) => [root.id, root]));
  const purposes = (Object.keys(options.executors) as RenderJob["purpose"]["kind"][]).filter((kind) => options.executors[kind]);

  const runOne = async (client: Client, job: RenderJob, leaseToken: string, signal: AbortSignal): Promise<number> => {
    const executor = options.executors[job.purpose.kind];
    if (!executor) throw new JobFailure("renderer_unavailable");
    const entry = await options.store.byPhotoId(job.photo.photoId);
    const root = entry ? roots.get(entry.rootId) : undefined;
    if (!entry || !root || entry.excluded || entry.state !== "present") throw new JobFailure("source_missing");
    // Render only the exact bytes the job is bound to; held or changed originals are never rendered.
    if (entry.hold || entry.sha256 !== job.binding.sourceSha256) throw new JobFailure("source_changed");
    const original = await options.fs.open(root, entry.relativePath, signal).catch(() => { throw new JobFailure("source_missing"); });
    try {
      if (original.sizeBytes !== entry.sizeBytes || original.fileId !== entry.fileId || original.changeToken !== entry.changeToken) {
        throw new JobFailure("source_changed");
      }
      const pass = verifiedPass(original, options.hasher, signal);
      const output = await executor.run({ job, original: pass.file, signal });
      // The bytes the executor rendered must be the bytes the job is bound to, whatever the metadata said.
      const verified = await pass.finish();
      if (verified.sha256 !== job.binding.sourceSha256 || verified.bytes !== entry.sizeBytes) throw new JobFailure("source_changed");
      const expected = job.purpose.kind === "preview" ? "preview" : "rendition";
      if (output.request.kind !== expected || output.bytes.byteLength !== output.request.sizeBytes || (await sha256Bytes(output.bytes)) !== output.request.sha256) {
        throw new JobFailure("renderer_unavailable");
      }
      const started = await sendKeyed(
        client,
        "renderJobs.startOutput",
        { jobId: job.id, leaseToken, output: output.request },
        `job-${job.id}-${job.attempt}-output`,
        signal,
      );
      // A replayed start has no ticket: whether the bytes arrived is unknown, so renew the ticket and send them again.
      const ticket = started.value.ticket ?? (await client.request(
        "renderJobs.renewOutput",
        { jobId: job.id, leaseToken, uploadId: started.value.uploadId },
        { signal },
      )).ticket;
      await options.uploader.put(ticket, output.bytes, signal);
      await sendKeyed(client, "renderJobs.commit", { jobId: job.id, leaseToken, uploadId: started.value.uploadId }, `job-${job.id}-${job.attempt}-commit`, signal);
      return output.bytes.byteLength;
    } finally {
      await original.close();
    }
  };

  return {
    purposes: () => purposes,
    async step(client: Client, signal: AbortSignal, maxJobs: number): Promise<JobStepResult> {
      if (!purposes.length) return { claimed: 0, committed: 0, failed: 0, dropped: 0, uploadedBytes: 0 };
      const claimed = (await sendKeyed(client, "renderJobs.claim", { maxJobs, purposes }, `claim-${randomSecret()}`, signal)).value;
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
