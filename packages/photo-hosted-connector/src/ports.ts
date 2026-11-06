/**
 * OS-dependent ports of the hosted Mac connector (B03 #244). The service core is OS independent so that the same
 * protocol and core serve Linux/Docker/NAS later (B11). Paths never leave these ports.
 */
import type { HostConnectorClient, RenderCapability, RenderJob, RenderOutputRequest } from "../../photo-library-sharing-contract/src/v1.ts";

/** A connector transport authenticated by one device credential secret, or none for pairing start/poll. */
export type ConnectorTransport = (credentialSecret: string | null) => Pick<HostConnectorClient, "request">;

/** Device credential and other secrets of this install. macOS: Keychain. Never logged, journaled or shown. */
export interface CredentialVault {
  read(): Promise<VaultContents>;
  /** Atomic replace of the whole contents. */
  write(next: VaultContents): Promise<void>;
}
export interface VaultContents {
  /** Random key for localKey derivation; survives index loss so localKeys stay stable. */
  readonly installSalt: string | null;
  readonly credential: { readonly secret: string; readonly generation: number; readonly connectorId: string; readonly libraryId: string } | null;
  /** Secrets of a pairing in progress, written before the request is sent. */
  readonly pairing: {
    readonly key: string;
    readonly pollSecret: string;
    readonly credentialSecret: string;
    readonly displayName: string;
    readonly pairingId: string | null;
    readonly userCode: string | null;
    readonly expiresAt: string | null;
  } | null;
  /** Next credential of a rotation in progress, written before the request is sent. */
  readonly rotation: { readonly key: string; readonly nextSecret: string } | null;
}

/** A folder the owner registered. The adapter maps id to a real location that never leaves this Mac. */
export interface RegisteredRoot {
  readonly id: string;
}
export interface DirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /** Device + inode (or equivalent): detects a file replaced under the same name. */
  readonly fileId: string;
  /**
   * Changes whenever the bytes may have changed: modification and status-change times at full precision. A cheap
   * filter only; render jobs still verify the bytes themselves.
   */
  readonly changeToken: string;
}
export interface OpenedFile {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly fileId: string;
  readonly changeToken: string;
  /** Read-only stream of the whole file. */
  read(signal: AbortSignal): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
/**
 * Read-only access below registered roots. Implementations must never write, must not follow symlinks in any path
 * component, must refuse anything that resolves outside the root, and must run no command.
 */
export interface RootFileSystem {
  rootStatus(root: RegisteredRoot, signal: AbortSignal): Promise<"available" | "unmounted">;
  /** `relativeDir` uses "/" separators; "" is the root. */
  list(root: RegisteredRoot, relativeDir: string, signal: AbortSignal): Promise<readonly DirectoryEntry[]>;
  /** Opens a regular file; rejects symlinks, non-files and anything outside the root. */
  open(root: RegisteredRoot, relativePath: string, signal: AbortSignal): Promise<OpenedFile>;
  /** Current metadata of a regular file, or null when it is gone (same containment rules as open). */
  stat(root: RegisteredRoot, relativePath: string, signal: AbortSignal): Promise<DirectoryEntry | null>;
  /**
   * Optional: SHA-256 of a whole regular file, computed where the bytes are (macOS: natively, so originals never pass
   * through the connector page). null when the identity was not `expected` when opened or after the read.
   */
  hash?(
    root: RegisteredRoot,
    relativePath: string,
    expected: Pick<DirectoryEntry, "sizeBytes" | "fileId" | "changeToken">,
    signal: AbortSignal,
  ): Promise<{ readonly sha256: string; readonly bytes: number } | null>;
}

/** Keeps the Mac awake while work runs; releasing restores the owner's power settings (macOS: IOPM assertion). */
export interface PowerAssertions {
  hold(reason: "jobs" | "scan" | "sync"): Promise<{ release(): Promise<void> }>;
}

export interface LocalIndexEntry {
  readonly localKey: string;
  readonly rootId: string;
  /** Local only; never sent to NIHO. */
  readonly relativePath: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly fileId: string;
  readonly changeToken: string;
  /** SHA-256 of the bytes as of (sizeBytes, fileId, changeToken); null until hashed. */
  readonly sha256: string | null;
  readonly photoId: string | null;
  /** Excluded in NIHO: never hashed, rendered or re-added; the original stays where it is. */
  readonly excluded: boolean;
  readonly state: "present" | "missing" | "unmounted";
  /** Scan generation that last saw this file. */
  readonly seenInScan: number;
  /** True when NIHO has not yet received the current identity/availability. */
  readonly dirty: boolean;
  /**
   * After an index rebuild, bytes that do not match NIHO's record are held: not hashed, reported or rendered until
   * the owner decides. They are never relinked automatically.
   */
  readonly hold: "sourceMismatch" | null;
  /** NIHO's recorded SHA-256 for an original that was unavailable during an index rebuild: checked on its first hash. */
  readonly verifyAgainst: string | null;
}
export interface ScanCheckpoint {
  readonly scan: number;
  /** Directories still to list, as (rootId, relativeDir). */
  readonly pending: readonly { readonly rootId: string; readonly dir: string }[];
  readonly unmountedRoots: readonly string[];
  /** Directories that could not be listed in this pass: their files keep their last state and are retried next pass. */
  readonly skipped: readonly { readonly rootId: string; readonly dir: string }[];
  readonly startedAt: number;
}
/** Local index of this Mac (macOS: a file in Application Support). Rebuildable with recoverLocalIndex. */
export interface LocalIndexStore {
  get(localKey: string): Promise<LocalIndexEntry | null>;
  byPhotoId(photoId: string): Promise<LocalIndexEntry | null>;
  put(entries: readonly LocalIndexEntry[]): Promise<void>;
  entries(): AsyncIterable<LocalIndexEntry>;
  checkpoint(): Promise<ScanCheckpoint | null>;
  setCheckpoint(checkpoint: ScanCheckpoint | null): Promise<void>;
  /** Drops every entry (index loss); the vault and replica are separate. */
  clear(): Promise<void>;
}

/** Output of a render executor. Previews and renditions only; the original is never an output. */
export interface ExecutorOutput {
  readonly request: RenderOutputRequest;
  readonly bytes: Uint8Array;
}
/**
 * Rendering lives elsewhere (B07): the connector only resolves the original and uploads what the executor returns.
 * `original` is a single sequential pass; the connector hashes every byte it yields (and the rest afterwards) and
 * discards the output unless the bytes match the job's source hash.
 */
export interface JobExecutor {
  readonly renderer: RenderCapability | null;
  run(input: { readonly job: RenderJob; readonly original: OpenedFile; readonly signal: AbortSignal }): Promise<ExecutorOutput>;
}
export type JobExecutors = { readonly [K in RenderJob["purpose"]["kind"]]?: JobExecutor };

/** Sends output bytes to the upload ticket NIHO issued (#195 transfer). */
export interface OutputUploader {
  put(ticket: { readonly url: string; readonly method: "PUT"; readonly headers: Readonly<Record<string, string>> }, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

export interface Clock {
  now(): number;
}

/** Streaming SHA-256 of a file (node: createHash). */
export interface StreamHasher {
  hash(chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<{ readonly sha256: string; readonly bytes: number }>;
}
