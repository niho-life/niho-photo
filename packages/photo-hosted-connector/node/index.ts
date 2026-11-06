/**
 * Node adapters for development and measurement on macOS. Read-only file access with symlink and containment checks,
 * and a streaming SHA-256.
 *
 * Not the distribution boundary: Node cannot walk a path relative to directory descriptors (openat with O_NOFOLLOW
 * per component), so a parent directory swapped between the checks and the open is narrowed, not closed. The packaged
 * connector implements RootFileSystem natively with descriptor-relative traversal, and the Keychain and power ports.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DirectoryEntry, OpenedFile, RegisteredRoot, RootFileSystem, StreamHasher } from "../src/ports.ts";

const CHUNK = 1024 * 1024;

export const nodeHasher: StreamHasher = {
  async hash(chunks, signal) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of chunks) {
      if (signal.aborted) throw new Error("aborted");
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    return { sha256: hash.digest("hex"), bytes };
  },
};

const fileId = (info: { readonly dev: number | bigint; readonly ino: number | bigint }): string => `${info.dev}:${info.ino}`;
/** Full-precision modification and status-change times: a rewrite that restores mtime still changes ctime. */
const changeToken = (info: { readonly mtimeNs: bigint; readonly ctimeNs: bigint }): string => `${info.mtimeNs}:${info.ctimeNs}`;

/**
 * `roots` maps a registered root id to its absolute folder. Only regular files below it are readable: every path
 * component is lstat-checked (no symlink is followed), the resolved path must stay inside the root, and files are
 * opened O_RDONLY|O_NOFOLLOW and compared with the checked inode. Nothing here writes or runs a command.
 */
export function createNodeRootFileSystem(roots: ReadonlyMap<string, string>): RootFileSystem & { bytesRead(): number } {
  let readTotal = 0;
  /** The root's real path and directory identity, pinned when first seen (at registration). */
  const pinned = new Map<string, { readonly real: string; readonly id: string }>();
  const base = (root: RegisteredRoot): string => {
    const folder = roots.get(root.id);
    if (!folder || !path.isAbsolute(folder)) throw new Error("unknown root");
    return folder;
  };
  /** The registered folder itself must be a real directory, the same one as when it was registered. */
  const checkRoot = async (root: RegisteredRoot): Promise<string> => {
    const folder = base(root);
    const info = await lstat(folder, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("root is not a directory");
    const real = await realpath(folder);
    const id = fileId(info);
    const pin = pinned.get(root.id);
    if (!pin) pinned.set(root.id, { real, id });
    else if (pin.real !== real || pin.id !== id) throw new Error("root replaced");
    return real;
  };
  const resolve = async (root: RegisteredRoot, relative: string, allowRoot: boolean): Promise<string> => {
    const realRoot = await checkRoot(root);
    if (relative === "" && allowRoot) return realRoot;
    const parts = relative.split("/");
    if (!relative || relative.includes("\\") || relative.includes("\u0000") || parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("outside root");
    }
    let current = realRoot;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink");
    }
    const real = await realpath(current);
    if (real !== current || !real.startsWith(`${realRoot}${path.sep}`)) throw new Error("outside root");
    return real;
  };
  return {
    bytesRead: () => readTotal,
    async rootStatus(root) {
      try {
        await checkRoot(root);
        return "available";
      } catch {
        // Unmounted, unreadable, replaced or a symlink: unavailable, never followed and never a deletion.
        return "unmounted";
      }
    },
    async list(root, relativeDir) {
      const dir = await resolve(root, relativeDir, true);
      const out: DirectoryEntry[] = [];
      for (const dirent of await readdir(dir, { withFileTypes: true })) {
        const info = await lstat(path.join(dir, dirent.name), { bigint: true }).catch(() => null);
        if (!info) continue;
        const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
        out.push({ name: dirent.name, kind, sizeBytes: Number(info.size), mtimeMs: Number(info.mtimeMs), fileId: fileId(info), changeToken: changeToken(info) });
      }
      return out;
    },
    async stat(root, relativePath) {
      try {
        const info = await lstat(await resolve(root, relativePath, false), { bigint: true });
        return info.isFile()
          ? { name: path.basename(relativePath), kind: "file", sizeBytes: Number(info.size), mtimeMs: Number(info.mtimeMs), fileId: fileId(info), changeToken: changeToken(info) }
          : null;
      } catch {
        return null;
      }
    },
    async open(root, relativePath): Promise<OpenedFile> {
      const resolved = await resolve(root, relativePath, false);
      const checked = await lstat(resolved, { bigint: true });
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || fileId(info) !== fileId(checked)) {
        await handle.close();
        throw new Error("replaced");
      }
      return {
        sizeBytes: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        fileId: fileId(info),
        changeToken: changeToken(info),
        async *read(signal) {
          const buffer = new Uint8Array(CHUNK);
          let position = 0;
          for (;;) {
            if (signal.aborted) throw new Error("aborted");
            const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
            if (!bytesRead) return;
            position += bytesRead;
            readTotal += bytesRead;
            yield buffer.slice(0, bytesRead);
          }
        },
        close: () => handle.close(),
      };
    },
  };
}
