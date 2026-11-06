/**
 * Node adapters for development and measurement on macOS. Read-only file access with symlink and containment checks,
 * and a streaming SHA-256. The packaged Mac connector supplies the same ports natively (Keychain, power assertions).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
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

/**
 * `roots` maps a registered root id to its absolute folder. Only regular files below it are readable: every path
 * component is lstat-checked (no symlink is followed), the resolved path must stay inside the root, and files are
 * opened O_RDONLY|O_NOFOLLOW and compared with the checked inode. Nothing here writes or runs a command.
 */
export function createNodeRootFileSystem(roots: ReadonlyMap<string, string>): RootFileSystem & { bytesRead(): number } {
  let readTotal = 0;
  const base = (root: RegisteredRoot): string => {
    const folder = roots.get(root.id);
    if (!folder || !path.isAbsolute(folder)) throw new Error("unknown root");
    return folder;
  };
  const resolve = async (root: RegisteredRoot, relative: string, allowRoot: boolean): Promise<string> => {
    const folder = base(root);
    if (relative === "" && allowRoot) return folder;
    const parts = relative.split("/");
    if (!relative || relative.includes("\\") || relative.includes("\u0000") || parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("outside root");
    }
    let current = folder;
    for (const part of parts) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink");
    }
    const real = await realpath(current);
    const realRoot = await realpath(folder);
    if (!real.startsWith(`${realRoot}${path.sep}`)) throw new Error("outside root");
    return real;
  };
  return {
    bytesRead: () => readTotal,
    async rootStatus(root) {
      try {
        return (await stat(base(root))).isDirectory() ? "available" : "unmounted";
      } catch {
        return "unmounted";
      }
    },
    async list(root, relativeDir) {
      const dir = await resolve(root, relativeDir, true);
      const out: DirectoryEntry[] = [];
      for (const dirent of await readdir(dir, { withFileTypes: true })) {
        const info = await lstat(path.join(dir, dirent.name)).catch(() => null);
        if (!info) continue;
        const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
        out.push({ name: dirent.name, kind, sizeBytes: info.size, mtimeMs: Math.trunc(info.mtimeMs), fileId: fileId(info) });
      }
      return out;
    },
    async stat(root, relativePath) {
      try {
        const info = await lstat(await resolve(root, relativePath, false));
        return info.isFile()
          ? { name: path.basename(relativePath), kind: "file", sizeBytes: info.size, mtimeMs: Math.trunc(info.mtimeMs), fileId: fileId(info) }
          : null;
      } catch {
        return null;
      }
    },
    async open(root, relativePath): Promise<OpenedFile> {
      const resolved = await resolve(root, relativePath, false);
      const checked = await lstat(resolved);
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || fileId(info) !== fileId(checked)) {
        await handle.close();
        throw new Error("replaced");
      }
      return {
        sizeBytes: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
        fileId: fileId(info),
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
