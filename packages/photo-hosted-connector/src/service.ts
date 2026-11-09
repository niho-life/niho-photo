/**
 * The hosted Mac connector service (B03 #244): one OS-independent loop driven by the platform's resident process.
 * Every call is outbound to NIHO. Order per tick: heartbeat → replica sync (B01) → scan → hash → report → jobs.
 * Sleep, wake, restart, revocation and disconnection never delete originals or the local index.
 */
import { createHostedReplicaSync, recoverLocalIndex } from "../../photo-hosted-library/src/index.ts";
import type { ReplicaStatus, ReplicaStore, SourceScanner } from "../../photo-hosted-library/src/index.ts";
import type { HostConnectorClient } from "../../photo-library-sharing-contract/src/v1.ts";
import { localKeyFor, randomSecret } from "./crypto.ts";
import { ConnectorError, createCredentialManager, isUnauthenticated } from "./credentials.ts";
import { createIndexer, formatOf, isHiddenName, shouldDescend } from "./indexer.ts";
import type { IndexProgress } from "./indexer.ts";
import { createJobRunner } from "./jobs.ts";
import type { JobStepResult } from "./jobs.ts";
import type {
  Clock,
  ConnectorTransport,
  CredentialVault,
  JobExecutors,
  LocalIndexEntry,
  LocalIndexStore,
  OutputUploader,
  PowerAssertions,
  RegisteredRoot,
  RootFileSystem,
  StreamHasher,
} from "./ports.ts";

export interface ConnectorBudget {
  readonly maxDirectories: number;
  readonly maxHashBytes: number;
  readonly maxHashFiles: number;
  readonly maxJobs: number;
}
export const DEFAULT_BUDGET: ConnectorBudget = { maxDirectories: 200, maxHashBytes: 2 * 1024 ** 3, maxHashFiles: 200, maxJobs: 2 };

export type ConnectorPhase = "unpaired" | "pairing" | "active" | "sleeping" | "revoked";
export interface ConnectorStatus {
  readonly phase: ConnectorPhase;
  readonly replica: ReplicaStatus | null;
  readonly index: IndexProgress | null;
  readonly jobs: { readonly committed: number; readonly failed: number; readonly uploadedBytes: number };
  readonly lastTickAt: number | null;
}
export interface TickResult {
  readonly phase: ConnectorPhase;
  readonly replicaRevision?: number;
  readonly scanComplete?: boolean;
  readonly hashed?: { readonly files: number; readonly bytes: number };
  readonly reported?: number;
  readonly jobs?: JobStepResult;
}

export interface HostedConnectorOptions {
  readonly vault: CredentialVault;
  readonly transport: ConnectorTransport;
  readonly fs: RootFileSystem;
  readonly roots: readonly RegisteredRoot[];
  readonly index: LocalIndexStore;
  /** B01 replica store on this Mac. */
  readonly replica: ReplicaStore;
  readonly hasher: StreamHasher;
  readonly power: PowerAssertions;
  readonly uploader: OutputUploader;
  /** Rendering is plugged in later (B07); without executors no job is claimed. */
  readonly executors: JobExecutors;
  readonly clock: Clock;
  readonly budget?: ConnectorBudget;
}

export function createHostedConnector(options: HostedConnectorOptions) {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const credentials = createCredentialManager({ vault: options.vault, transport: options.transport });
  const indexer = createIndexer({
    fs: options.fs, roots: options.roots, store: options.index, hasher: options.hasher,
    installSalt: () => credentials.installSalt(), clock: options.clock,
  });
  const jobs = createJobRunner({
    executors: options.executors, store: options.index, fs: options.fs, roots: options.roots, power: options.power, uploader: options.uploader,
    hasher: options.hasher,
  });
  const renderer = Object.values(options.executors).find((executor) => executor?.renderer)?.renderer ?? null;
  /** Resolves the current credential per request, so a rotation never strands a long-lived client. */
  const client: Pick<HostConnectorClient, "request"> = {
    request: (async (operation: never, request: never, requestOptions: never) =>
      (await credentials.client()).request(operation, request, requestOptions)) as HostConnectorClient["request"],
  };
  const replicaSync = createHostedReplicaSync({ client, store: options.replica });
  let phase: ConnectorPhase = "unpaired";
  let sleeping = false;
  let lastTickAt: number | null = null;
  let jobTotals = { committed: 0, failed: 0, uploadedBytes: 0 };

  const heartbeat = async (target: Pick<HostConnectorClient, "request">, state: "online" | "sleeping", signal: AbortSignal) =>
    target.request("connector.heartbeat", { state, renderer, replicaRevision: await options.replica.revision() }, { signal });
  const probe = (signal: AbortSignal) => (target: Pick<HostConnectorClient, "request">) => heartbeat(target, "online", signal);

  /** Runs an authenticated step; a refused credential either finishes a lost rotation or ends in revoked. */
  const authenticated = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!isUnauthenticated(error)) throw error;
      try {
        await credentials.onUnauthenticated(probe(signal), signal);
      } catch (revoked) {
        if (revoked instanceof ConnectorError && revoked.code === "revoked") phase = "revoked";
        throw revoked;
      }
      return run();
    }
  };

  const refreshPhase = async (): Promise<ConnectorPhase> => {
    if (phase === "revoked") return phase;
    const vault = await options.vault.read();
    phase = vault.credential ? (sleeping ? "sleeping" : "active") : vault.pairing ? "pairing" : "unpaired";
    return phase;
  };

  /** Locates registered originals by recomputing localKeys while walking the roots; no stored path is trusted. */
  const locate = async (signal: AbortSignal) => {
    const salt = await credentials.installSalt();
    const located = new Map<string, { readonly root: RegisteredRoot; readonly relativePath: string }>();
    const unmounted = new Set<string>();
    for (const root of options.roots) {
      if ((await options.fs.rootStatus(root, signal)) !== "available") {
        unmounted.add(root.id);
        continue;
      }
      const queue = [""];
      while (queue.length) {
        const dir = queue.shift() as string;
        // Same rules as the indexer: hidden entries and other apps' libraries are never walked.
        const listing = await options.fs.list(root, dir, signal).catch(() => []);
        for (const item of listing) {
          if (isHiddenName(item.name)) continue;
          const relativePath = dir ? `${dir}/${item.name}` : item.name;
          if (item.kind === "directory") {
            if (shouldDescend(item.name)) queue.push(relativePath);
          }
          else if (item.kind === "file" && formatOf(item.name)) located.set(await localKeyFor(salt, root.id, relativePath), { root, relativePath });
        }
      }
    }
    const scanner: SourceScanner = {
      async stat(localKey, scanSignal) {
        const found = located.get(localKey);
        // Not found while a volume is away: it may be on that volume, so it is unavailable rather than missing.
        if (!found) return unmounted.size ? { state: "unmounted" } : { state: "missing" };
        const meta = await options.fs.stat(found.root, found.relativePath, scanSignal);
        return meta ? { state: "present", sizeBytes: meta.sizeBytes } : { state: "missing" };
      },
      async sha256(localKey, scanSignal) {
        const found = located.get(localKey);
        if (!found) throw new Error("missing");
        const opened = await options.fs.open(found.root, found.relativePath, scanSignal);
        try {
          return (await options.hasher.hash(opened.read(scanSignal), scanSignal)).sha256;
        } finally {
          await opened.close();
        }
      },
    };
    return { located, scanner };
  };

  return {
    async status(): Promise<ConnectorStatus> {
      return {
        phase: await refreshPhase(),
        replica: (await credentials.paired()) ? replicaSync.status() : null,
        index: (await credentials.paired()) ? await indexer.progress() : null,
        jobs: jobTotals,
        lastTickAt,
      };
    },
    /** Shows the short code to confirm in NIHO. */
    async pair(displayName: string, signal: AbortSignal) {
      const started = await credentials.startPairing(displayName, signal);
      phase = "pairing";
      return started;
    },
    async poll(signal: AbortSignal) {
      const answer = await credentials.pollPairing(signal);
      await refreshPhase();
      return answer;
    },
    /** One bounded cycle. Throws revoked (and stays revoked) when NIHO refuses the device. */
    async tick(signal: AbortSignal): Promise<TickResult> {
      if ((await refreshPhase()) !== "active") return { phase };
      const hold = await options.power.hold("sync");
      try {
        const beat = await authenticated(signal, () => heartbeat(client, "online", signal));
        const synced = await authenticated(signal, () => replicaSync.sync({ canonicalRevision: beat.metadataRevision, signal }));
        let scanned = { complete: false };
        let hashed = { files: 0, bytes: 0 };
        let reported = { sent: 0 };
        let ran: JobStepResult = { claimed: 0, committed: 0, failed: 0, dropped: 0, uploadedBytes: 0 };
        // Do not inspect originals or execute jobs until the replica includes every change visible to this heartbeat.
        if (synced.replicaRevision >= beat.metadataRevision) {
          const exclusions = new Set<string>();
          for await (const exclusion of options.replica.records("exclusion")) exclusions.add(exclusion.id);
          await indexer.reconcileExclusions(exclusions);
          await indexer.beginScan(signal);
          scanned = await indexer.scanStep(signal, budget.maxDirectories);
          hashed = await indexer.hashStep(signal, { maxBytes: budget.maxHashBytes, maxFiles: budget.maxHashFiles });
          reported = await authenticated(signal, () => indexer.report(client, signal));
          ran = await authenticated(signal, () => jobs.step(client, signal, budget.maxJobs));
        }
        jobTotals = {
          committed: jobTotals.committed + ran.committed,
          failed: jobTotals.failed + ran.failed,
          uploadedBytes: jobTotals.uploadedBytes + ran.uploadedBytes,
        };
        lastTickAt = options.clock.now();
        return { phase, replicaRevision: synced.replicaRevision, scanComplete: scanned.complete, hashed, reported: reported.sent, jobs: ran };
      } finally {
        await hold.release();
      }
    },
    /** System sleep is coming: tell NIHO (best effort). The caller aborts the running tick. */
    async willSleep(signal: AbortSignal) {
      sleeping = true;
      if ((await options.vault.read()).credential) await heartbeat(client, "sleeping", signal).catch(() => undefined);
      await refreshPhase();
    },
    /** After wake the next tick continues from the checkpoint and pulls only the replica diff. */
    async didWake() {
      sleeping = false;
      await refreshPhase();
    },
    async rotateCredential(signal: AbortSignal) {
      return credentials.rotate(probe(signal), signal);
    },
    /**
     * Rebuilds the local index from the NIHO replica and the originals (B01). Exact matches are relinked; mismatches
     * are held; unavailable originals stay registered. Availability goes to NIHO with NIHO's own identity.
     */
    async recoverIndex(signal: AbortSignal) {
      if ((await refreshPhase()) !== "active") throw new ConnectorError("not_paired");
      const { located, scanner } = await locate(signal);
      const report = await recoverLocalIndex({ store: options.replica, scanner, signal });
      const entries: LocalIndexEntry[] = [];
      for (const item of report.entries) {
        const photo = await options.replica.get("photo", item.photoId);
        if (!photo) continue;
        const found = located.get(item.localKey);
        const meta = found && item.state !== "excluded" ? await options.fs.stat(found.root, found.relativePath, signal) : null;
        const relinked = item.state === "relinked" && meta !== null;
        entries.push({
          localKey: item.localKey,
          // Unlocated originals keep an empty location until a scan finds their localKey again.
          rootId: found?.root.id ?? "",
          relativePath: found?.relativePath ?? "",
          fileName: photo.body.fileName,
          sizeBytes: meta?.sizeBytes ?? photo.body.source.sizeBytes,
          mtimeMs: meta?.mtimeMs ?? 0,
          fileId: meta?.fileId ?? "",
          changeToken: meta?.changeToken ?? "",
          sha256: relinked ? photo.body.source.sha256 : null,
          photoId: item.photoId,
          excluded: item.state === "excluded",
          state: meta ? "present" : item.reason === "unmounted" ? "unmounted" : "missing",
          seenInScan: 0,
          dirty: item.state !== "excluded",
          reportMutationId: item.state !== "excluded" ? randomSecret() : null,
          hold: item.state === "sourceMismatch" ? "sourceMismatch" : null,
          verifyAgainst: item.state === "sourceUnavailable" ? photo.body.source.sha256 : null,
        });
      }
      await options.index.clear();
      await options.index.put(entries);
      await options.index.setCheckpoint(null);
      return report;
    },
    /** Local disconnect: wipes the device credential. Originals, the local index and the replica stay. */
    async disconnect() {
      await credentials.forget();
      phase = "unpaired";
    },
  };
}
export type HostedConnector = ReturnType<typeof createHostedConnector>;
