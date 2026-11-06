/** Synthetic in-memory ports for tests. Not product storage: the Mac keeps secrets in the Keychain. */
import type {
  Clock,
  CredentialVault,
  DirectoryEntry,
  LocalIndexEntry,
  LocalIndexStore,
  OpenedFile,
  OutputUploader,
  PowerAssertions,
  RegisteredRoot,
  RootFileSystem,
  ScanCheckpoint,
  VaultContents,
} from "../src/ports.ts";

export class MemoryVault implements CredentialVault {
  contents: VaultContents = { installSalt: null, credential: null, pairing: null, rotation: null };
  writes = 0;
  async read(): Promise<VaultContents> {
    return structuredClone(this.contents);
  }
  async write(next: VaultContents): Promise<void> {
    this.writes++;
    this.contents = structuredClone(next);
  }
}

export class MemoryIndexStore implements LocalIndexStore {
  private data = new Map<string, LocalIndexEntry>();
  private saved: ScanCheckpoint | null = null;
  async get(localKey: string): Promise<LocalIndexEntry | null> {
    return this.data.get(localKey) ?? null;
  }
  async byPhotoId(photoId: string): Promise<LocalIndexEntry | null> {
    for (const entry of this.data.values()) if (entry.photoId === photoId) return entry;
    return null;
  }
  async put(entries: readonly LocalIndexEntry[]): Promise<void> {
    for (const entry of entries) this.data.set(entry.localKey, entry);
  }
  async *entries(): AsyncIterable<LocalIndexEntry> {
    for (const entry of [...this.data.values()]) yield entry;
  }
  async checkpoint(): Promise<ScanCheckpoint | null> {
    return this.saved;
  }
  async setCheckpoint(checkpoint: ScanCheckpoint | null): Promise<void> {
    this.saved = checkpoint;
  }
  async clear(): Promise<void> {
    this.data.clear();
    this.saved = null;
  }
  all(): LocalIndexEntry[] {
    return [...this.data.values()];
  }
}

export class MemoryPower implements PowerAssertions {
  active = 0;
  holds: string[] = [];
  async hold(reason: "jobs" | "scan" | "sync") {
    this.active++;
    this.holds.push(reason);
    let released = false;
    return {
      release: async () => {
        if (!released) {
          released = true;
          this.active--;
        }
      },
    };
  }
}

export class ManualClock implements Clock {
  current = Date.parse("2026-11-07T00:00:00.000Z");
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class CapturingUploader implements OutputUploader {
  readonly uploaded = new Map<string, Uint8Array>();
  async put(ticket: { readonly url: string }, bytes: Uint8Array): Promise<void> {
    this.uploaded.set(ticket.url, bytes);
  }
  totalBytes(): number {
    return [...this.uploaded.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }
}

interface FakeFile {
  bytes: Uint8Array;
  mtimeMs: number;
  fileId: string;
}
interface FakeRoot {
  mounted: boolean;
  files: Map<string, FakeFile>;
  symlinks: Map<string, string>;
}

/** Read-only synthetic volumes. There is no write path; tests mutate them only through the helpers below. */
export class FakeFileSystem implements RootFileSystem {
  readonly roots = new Map<string, FakeRoot>();
  bytesRead = 0;
  private nextFileId = 1;
  private clock = 1_000;

  private root(rootId: string): FakeRoot {
    let root = this.roots.get(rootId);
    if (!root) {
      root = { mounted: true, files: new Map(), symlinks: new Map() };
      this.roots.set(rootId, root);
    }
    return root;
  }
  addFile(rootId: string, path: string, text: string): void {
    this.root(rootId).files.set(path, { bytes: new TextEncoder().encode(text), mtimeMs: this.clock++, fileId: `fid-${this.nextFileId++}` });
  }
  /** In-place edit: same file, new bytes and mtime. */
  modify(rootId: string, path: string, text: string): void {
    const file = this.root(rootId).files.get(path);
    if (!file) throw new Error("no file");
    file.bytes = new TextEncoder().encode(text);
    file.mtimeMs = this.clock++;
  }
  /** Another file moved in under the same name, keeping size and mtime: only the file id differs. */
  replace(rootId: string, path: string, text: string): void {
    const file = this.root(rootId).files.get(path);
    if (!file) throw new Error("no file");
    this.root(rootId).files.set(path, { bytes: new TextEncoder().encode(text), mtimeMs: file.mtimeMs, fileId: `fid-${this.nextFileId++}` });
  }
  remove(rootId: string, path: string): void {
    this.root(rootId).files.delete(path);
  }
  addSymlink(rootId: string, path: string, target: string): void {
    this.root(rootId).symlinks.set(path, target);
  }
  setMounted(rootId: string, mounted: boolean): void {
    this.root(rootId).mounted = mounted;
  }
  /** Every original's bytes, to prove nothing was written. */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [rootId, root] of this.roots) for (const [path, file] of root.files) out.set(`${rootId}:${path}`, new TextDecoder().decode(file.bytes));
    return out;
  }

  private checkPath(root: FakeRoot, path: string): void {
    const parts = path.split("/");
    if (!path || path.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) throw new Error("outside root");
    for (let index = 1; index <= parts.length; index++) {
      if (root.symlinks.has(parts.slice(0, index).join("/"))) throw new Error("symlink");
    }
  }
  async rootStatus(root: RegisteredRoot): Promise<"available" | "unmounted"> {
    return this.root(root.id).mounted ? "available" : "unmounted";
  }
  async list(root: RegisteredRoot, relativeDir: string): Promise<readonly DirectoryEntry[]> {
    const state = this.root(root.id);
    if (!state.mounted) throw new Error("unmounted");
    if (relativeDir) this.checkPath(state, relativeDir);
    const prefix = relativeDir ? `${relativeDir}/` : "";
    const entries = new Map<string, DirectoryEntry>();
    for (const [path, file] of state.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [name, ...more] = rest.split("/");
      if (!name) continue;
      entries.set(name, more.length
        ? { name, kind: "directory", sizeBytes: 0, mtimeMs: 0, fileId: `dir-${prefix}${name}` }
        : { name, kind: "file", sizeBytes: file.bytes.byteLength, mtimeMs: file.mtimeMs, fileId: file.fileId });
    }
    for (const path of state.symlinks.keys()) {
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      if (name && !name.includes("/")) entries.set(name, { name, kind: "symlink", sizeBytes: 0, mtimeMs: 0, fileId: `link-${path}` });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async stat(root: RegisteredRoot, relativePath: string): Promise<DirectoryEntry | null> {
    const state = this.root(root.id);
    if (!state.mounted) return null;
    this.checkPath(state, relativePath);
    const file = state.files.get(relativePath);
    const name = relativePath.split("/").at(-1) as string;
    return file ? { name, kind: "file", sizeBytes: file.bytes.byteLength, mtimeMs: file.mtimeMs, fileId: file.fileId } : null;
  }
  async open(root: RegisteredRoot, relativePath: string): Promise<OpenedFile> {
    const state = this.root(root.id);
    if (!state.mounted) throw new Error("unmounted");
    this.checkPath(state, relativePath);
    const file = state.files.get(relativePath);
    if (!file) throw new Error("missing");
    const bytes = file.bytes;
    const fs = this;
    return {
      sizeBytes: bytes.byteLength,
      mtimeMs: file.mtimeMs,
      fileId: file.fileId,
      async *read() {
        for (let offset = 0; offset < bytes.byteLength; offset += 4) {
          const chunk = bytes.slice(offset, offset + 4);
          fs.bytesRead += chunk.byteLength;
          yield chunk;
        }
      },
      async close() {},
    };
  }
}
