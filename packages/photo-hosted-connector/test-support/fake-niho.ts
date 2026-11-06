/**
 * Synthetic NIHO for the connector protocol: pairing, device credentials by hash, heartbeat, index, replica (the B01
 * canonical mock) and render jobs. It follows the B00 contract; it is not the private service and grants nothing.
 */
import { compareIdempotency } from "../../photo-library-sharing-contract/src/policy.ts";
import type { IdempotencyRecord, RenderJob, RenderOutputRequest } from "../../photo-library-sharing-contract/src/v1.ts";
import { LIBRARY, OWNER, SyntheticHostedCanonical, contractError, networkError } from "../../photo-hosted-library/test-support/canonical.ts";
import { canonicalSha256 } from "../../photo-hosted-library/src/shared.ts";
import { sha256Bytes, sha256Text } from "../src/crypto.ts";
import type { ConnectorTransport } from "../src/ports.ts";

const START = Date.parse("2026-11-07T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

interface Pairing {
  id: string;
  userCode: string;
  pollSecretSha256: string;
  credentialSha256: string;
  expiresAt: number;
  connectorId: string | null;
}
interface Connector {
  id: string;
  libraryId: string;
  ownerId: string;
  generation: number;
  credentialSha256: string;
  revoked: boolean;
  state: "online" | "sleeping";
}
interface Job {
  job: RenderJob;
  leaseToken: string | null;
  output: { uploadId: string; url: string; request: RenderOutputRequest } | null;
}

export class FakeNiho {
  readonly canonical = new SyntheticHostedCanonical();
  now = START;
  readonly requests: { operation: string; body: unknown; credential: string | null }[] = [];
  /** Operations whose next response is lost after the server applied it. */
  readonly dropNextResponse = new Set<string>();
  readonly connectors = new Map<string, Connector>();
  readonly jobs = new Map<string, Job>();
  readonly committedOutputs = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, Uint8Array>();
  private readonly pairings = new Map<string, Pairing>();
  private readonly idempotency = new Map<string, { record: IdempotencyRecord; result: unknown }>();
  private seq = 1;

  /** Owner action in NIHO's own screen (signed-in user session). */
  approve(userCode: string, ownerId: string, target: { kind: "newLibrary" } | { kind: "existingLibrary"; libraryId: string; libraryOwner: string }): string {
    const pairing = [...this.pairings.values()].find((item) => item.userCode === userCode);
    if (!pairing || pairing.connectorId || this.now >= pairing.expiresAt) throw contractError("pairing_unavailable");
    if (target.kind === "existingLibrary" && target.libraryOwner !== ownerId) throw contractError("not_found");
    const id = `synthetic-connector-${this.seq++}`;
    this.connectors.set(id, {
      id, libraryId: target.kind === "existingLibrary" ? target.libraryId : LIBRARY, ownerId, generation: 1,
      credentialSha256: pairing.credentialSha256, revoked: false, state: "online",
    });
    pairing.connectorId = id;
    return id;
  }
  revoke(connectorId: string): void {
    const connector = this.connectors.get(connectorId);
    if (connector) connector.revoked = true;
  }
  enqueue(purpose: "preview" | "albumItem", photoId: string): string {
    const photo = this.canonical.photoOf(photoId);
    const recipe = this.canonical.recipeOf(photoId);
    const connector = [...this.connectors.values()].find((item) => !item.revoked);
    if (!photo || !recipe || !connector || !photo.source.sha256) throw new Error("cannot enqueue");
    const id = `synthetic-job-${this.seq++}`;
    this.jobs.set(id, {
      job: {
        id,
        purpose: purpose === "preview" ? { kind: "preview" } : { kind: "albumItem", albumId: "synthetic-album", itemId: "synthetic-item", itemRevision: 0 },
        executor: { kind: "hostedMac", connectorId: connector.id },
        photo: { libraryId: LIBRARY, photoId },
        binding: {
          sourceGeneration: photo.source.generation, sourceSha256: photo.source.sha256, recipeRevision: recipe.revision,
          settingsSha256: recipe.settingsSha256, engine: recipe.settings.engine, rendererManifestSha256: "c".repeat(64), maskSurfaceIds: recipe.maskSurfaceIds,
        },
        recipe, state: "queued", attempt: 1, createdAt: iso(this.now), leaseExpiresAt: null, failure: null,
      },
      leaseToken: null,
      output: null,
    });
    return id;
  }

  private async replayable<T>(actor: IdempotencyRecord["actor"], operation: IdempotencyRecord["operation"], key: string | undefined, body: unknown, run: () => Promise<T>) {
    if (!key) throw contractError("invalid_request");
    const record: IdempotencyRecord = { actor, scope: { kind: "library", libraryId: LIBRARY }, operation, key, payloadSha256: await canonicalSha256(body) };
    const identity = JSON.stringify([actor, operation, key]);
    const stored = this.idempotency.get(identity);
    const outcome = compareIdempotency(stored?.record ?? null, record);
    if (outcome === "conflict") throw contractError("idempotency_conflict");
    if (outcome === "replay" && stored) return { value: stored.result as T, replayed: true };
    const value = await run();
    this.idempotency.set(identity, { record, result: value });
    return { value, replayed: false };
  }

  private async authenticate(secret: string | null): Promise<Connector> {
    if (!secret) throw contractError("unauthenticated");
    const hash = await sha256Text(secret);
    const connector = [...this.connectors.values()].find((item) => item.credentialSha256 === hash);
    if (!connector || connector.revoked) throw contractError("unauthenticated");
    return connector;
  }

  readonly transport: ConnectorTransport = (secret) => ({
    request: (async (operation: string, body: Record<string, unknown>, options: { idempotencyKey?: string }) => {
      this.requests.push({ operation, body: structuredClone(body), credential: secret });
      const result = await this.handle(operation, body, options.idempotencyKey, secret);
      if (this.dropNextResponse.delete(operation)) throw networkError();
      return result;
    }) as never,
  });

  private async handle(operation: string, body: Record<string, unknown>, key: string | undefined, secret: string | null): Promise<unknown> {
    if (operation === "connector.startPairing") {
      return this.replayable({ kind: "pairingAttempt", pollSecretSha256: body.pollSecretSha256 as string }, "connector.startPairing", key, body, async () => {
        const id = `synthetic-pairing-${this.seq++}`;
        const pairing: Pairing = {
          id, userCode: `SYN-${String(this.seq).padStart(4, "0")}`, pollSecretSha256: body.pollSecretSha256 as string,
          credentialSha256: body.credentialSha256 as string, expiresAt: this.now + 10 * 60 * 1000, connectorId: null,
        };
        this.pairings.set(id, pairing);
        return { pairingId: id, userCode: pairing.userCode, expiresAt: iso(pairing.expiresAt) };
      });
    }
    if (operation === "connector.pollPairing") {
      const pairing = this.pairings.get(body.pairingId as string);
      if (!pairing || (await sha256Text(body.pollSecret as string)) !== pairing.pollSecretSha256) throw contractError("not_found");
      // Approved or not, a pairing answers only until it expires.
      if (this.now >= pairing.expiresAt) throw contractError("pairing_unavailable");
      if (pairing.connectorId) {
        const connector = this.connectors.get(pairing.connectorId) as Connector;
        return {
          state: "approved",
          connector: {
            id: connector.id, owner: { type: "user", userId: connector.ownerId }, libraryId: connector.libraryId, platform: "macos",
            displayName: "Synthetic Mac", lifecycle: "active", credentialGeneration: connector.generation, state: "online",
            lastSeenAt: null, renderer: null, transport: "outboundOnly",
          },
          credentialGeneration: connector.generation,
        };
      }
      return { state: "pending", expiresAt: iso(pairing.expiresAt) };
    }
    const connector = await this.authenticate(secret);
    const actor = { kind: "connector" as const, connectorId: connector.id };
    switch (operation) {
      case "connector.rotateCredential":
        return this.replayable(actor, "connector.rotateCredential", key, body, async () => {
          connector.credentialSha256 = body.nextCredentialSha256 as string;
          connector.generation++;
          return { credentialGeneration: connector.generation };
        });
      case "connector.heartbeat":
        connector.state = body.state as "online" | "sleeping";
        return { serverTime: iso(this.now), metadataRevision: this.canonical.revision, queuedJobs: [...this.jobs.values()].filter((job) => job.job.state === "queued").length };
      case "connector.putIndex":
        return this.replayable(actor, "connector.putIndex", key, body, async () => ({ results: await this.canonical.putIndex(body.entries as never) }));
      case "connector.pullReplica":
      case "connector.ackReplica":
      case "connector.getReplicaContent":
        return this.canonical.client().request(operation as never, body as never, { idempotencyKey: key } as never);
      case "renderJobs.claim": {
        const purposes = (body.purposes as string[] | undefined) ?? [];
        const claimed = [...this.jobs.values()]
          .filter((item) => item.job.state === "queued" && purposes.includes(item.job.purpose.kind) && item.job.executor.kind === "hostedMac" && item.job.executor.connectorId === connector.id)
          .slice(0, (body.maxJobs as number | undefined) ?? 1);
        return {
          jobs: claimed.map((item) => {
            item.leaseToken = `lease-${this.seq++}`;
            item.job = { ...item.job, state: "claimed", leaseExpiresAt: iso(this.now + 15 * 60 * 1000) };
            return { job: item.job, lease: { jobId: item.job.id, leaseToken: item.leaseToken, expiresAt: item.job.leaseExpiresAt } };
          }),
        };
      }
      case "renderJobs.startOutput":
      case "renderJobs.commit":
      case "renderJobs.fail": {
        const item = this.jobs.get(body.jobId as string);
        if (!item || item.leaseToken !== body.leaseToken || item.job.executor.kind !== "hostedMac" || item.job.executor.connectorId !== connector.id) throw contractError("not_found");
        return this.replayable(actor, operation as "renderJobs.commit", key, body, async () => {
          if (item.job.state !== "claimed") throw contractError("stale_render");
          if (operation === "renderJobs.startOutput") {
            const uploadId = `synthetic-output-${this.seq++}`;
            item.output = { uploadId, url: `https://upload.example.test/${uploadId}`, request: body.output as RenderOutputRequest };
            return { uploadId, expiresAt: iso(this.now + 30 * 60 * 1000), ticket: { url: item.output.url, method: "PUT", headers: {}, expiresAt: iso(this.now + 30 * 60 * 1000), resumeOffsetBytes: 0 } };
          }
          if (operation === "renderJobs.fail") {
            item.job = { ...item.job, state: "failed", failure: body.code as never, leaseExpiresAt: null };
            return item.job;
          }
          const bytes = item.output && item.output.uploadId === body.uploadId ? this.uploads.get(item.output.url) : undefined;
          if (!bytes || !item.output || (await sha256Bytes(bytes)) !== item.output.request.sha256) throw contractError("content_rejected");
          this.committedOutputs.set(item.job.id, bytes);
          item.job = { ...item.job, state: "committed", leaseExpiresAt: null };
          return item.job;
        });
      }
      default:
        throw contractError("not_found");
    }
  }

  /** The upload endpoint behind tickets (provider storage), recording every byte that left the Mac. */
  readonly uploader = {
    put: async (ticket: { readonly url: string }, bytes: Uint8Array) => {
      this.uploads.set(ticket.url, bytes);
    },
  };
}

export { LIBRARY, OWNER };
