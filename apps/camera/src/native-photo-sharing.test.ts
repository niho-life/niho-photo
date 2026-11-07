import { describe, expect, it, vi } from "vitest";
import type { VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import {
  createSharedAlbumClientOnTransport,
  createSharedAlbumItems,
  createSharedAlbumMockServer,
  prepareAlbumFile,
} from "@niho/photo-cloud-library/sharing";

import { syntheticJpeg } from "../../../packages/photo-cloud-library/test/render-support";
import type { NativePhotoInvoke } from "./native-photo-client";
import type { NativePhotoBinaryInvoke } from "./native-photo-mask-uploader";
import {
  PHOTO_WEB_ORIGIN,
  SHARING_UPLOAD_HEADER,
  createMacSharedAlbums,
  createNativeSharingTransport,
  createNativeSharingUploader,
} from "./native-photo-sharing";

const OWNER = "synthetic-user-owner";
const NOW = Date.parse("2026-11-07T00:00:00.000Z");
const actor: VerifiedPhotoActor = {
  userId: OWNER,
  sessionId: "synthetic-session",
  sessionEpoch: "synthetic-epoch",
  transport: "mac-bearer",
  expiresAt: "2026-11-08T00:00:00.000Z",
};

function identity(initial: VerifiedPhotoActor | null = actor) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    port: {
      getSnapshot: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies PersonalPhotoCloudIdentity,
    set(next: VerifiedPhotoActor | null) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

const PLACEHOLDER = /^https:\/\/upload\.native\.invalid\/[0-9a-f]{32}$/u;

/**
 * Stands in for `photo_sharing.rs`: forwards each route to the synthetic sharing server with the native session's
 * headers, keeps upload tickets on the native side and hands the page a placeholder, and serves verified content.
 */
function fakeNative() {
  const server = createSharedAlbumMockServer({
    users: [{ userId: OWNER, displayName: "Synthetic Owner" }],
    now: () => NOW,
    newSecret: () => "synthetic-invite-secret-value",
  });
  const tickets = new Map<string, unknown>();
  const contents = new Map<string, Uint8Array>();
  const seenByPage: unknown[] = [];
  let handles = 0;
  const handle = () => (++handles).toString(16).padStart(32, "0");
  const headersFor = (scope: { userId: string; sessionId: string; sessionEpoch: string }, key?: string) => ({
    "X-NIHO-Photo-Actor-Id": scope.userId,
    "X-NIHO-Photo-Session-Id": scope.sessionId,
    "X-NIHO-Photo-Session-Epoch": scope.sessionEpoch,
    ...(key ? { "Idempotency-Key": key } : {}),
  });
  const keepTickets = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(keepTickets);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === "ticket" && typeof child === "object" && child !== null) {
        const id = handle();
        tickets.set(id, child);
        const real = child as { expiresAt: string; resumeOffsetBytes: number };
        out[key] = { url: `https://upload.native.invalid/${id}`, method: "PUT", headers: {}, expiresAt: real.expiresAt, resumeOffsetBytes: real.resumeOffsetBytes };
      } else {
        out[key] = keepTickets(child);
      }
    }
    return out;
  };
  const invoke = vi.fn<NativePhotoInvoke>(async (command, args) => {
    const input = args.input as Record<string, unknown>;
    if (command === "camera_sharing_status") return { configured: true };
    if (command === "camera_sharing_request") {
      expect(Object.keys(input).every((key) => ["scope", "method", "path", "body", "idempotencyKey"].includes(key))).toBe(true);
      const scope = input.scope as { userId: string; sessionId: string; sessionEpoch: string; transport: string };
      expect(scope.transport).toBe("mac-bearer");
      const response = await server.fetch(new Request(new URL(String(input.path), "https://photo.example.test"), {
        method: String(input.method),
        headers: { ...headersFor(scope, input.idempotencyKey as string | undefined), ...(input.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }));
      const body = keepTickets(await response.json());
      seenByPage.push(body);
      return { status: response.status, body };
    }
    if (command === "camera_sharing_content_open") {
      const scope = input.scope as { userId: string; sessionId: string; sessionEpoch: string };
      const response = await server.fetch(new Request(new URL(String(input.path), "https://photo.example.test"), { headers: headersFor(scope) }));
      if (!response.ok) throw "rejected";
      const bytes = new Uint8Array(await response.arrayBuffer());
      const id = handle();
      contents.set(id, bytes);
      return { handle: id, contentType: response.headers.get("Content-Type") ?? "", sha256: "a".repeat(64), totalBytes: bytes.byteLength };
    }
    if (command === "camera_sharing_content_read") {
      const bytes = contents.get(String(input.handle)) ?? new Uint8Array();
      const offset = Number(input.offset);
      return bytes.slice(offset, offset + 1024 * 1024).buffer;
    }
    if (command === "camera_sharing_content_close") {
      contents.delete(String(input.handle));
      return null;
    }
    throw new Error(`unexpected ${command}`);
  });
  const invokeBinary = vi.fn<NativePhotoBinaryInvoke>(async (command, bytes, headers) => {
    expect(command).toBe("camera_sharing_upload");
    const meta = JSON.parse(headers[SHARING_UPLOAD_HEADER] ?? "{}") as { ticketUrl: string; contentType: string };
    expect(meta.ticketUrl).toMatch(PLACEHOLDER);
    const real = tickets.get(meta.ticketUrl.split("/").at(-1) ?? "");
    if (!real) throw "expired";
    await server.uploader.upload(real as never, bytes, meta.contentType, new AbortController().signal);
    return null;
  });
  return { server, invoke, invokeBinary, seenByPage, contents };
}

describe("Mac shared albums over the native session", () => {
  it("adds a finished photo while the upload ticket never reaches the page, and downloads it back", async () => {
    const native = fakeNative();
    const who = identity();
    const transport = createNativeSharingTransport({ identity: who.port, invoke: native.invoke, now: () => NOW });
    const client = createSharedAlbumClientOnTransport(transport);
    let keys = 0;
    const items = createSharedAlbumItems({
      client,
      uploader: createNativeSharingUploader({ identity: who.port, invokeBinary: native.invokeBinary, now: () => NOW }),
      newIdempotencyKey: () => `key-${++keys}`,
      sleep: async () => undefined,
    });
    const signal = new AbortController().signal;
    const album = await items.createAlbum("Synthetic album", signal);
    const file = prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 9 }));
    const item = await items.addFile(album.id, file, signal);
    expect(item.state).toBe("published");
    expect(native.invokeBinary).toHaveBeenCalledTimes(1);
    // The page saw only placeholders, never the provider URL.
    const seen = JSON.stringify(native.seenByPage);
    expect(seen).toContain("upload.native.invalid");
    expect(seen).not.toMatch(/https:\/\/storage\.googleapis\.com/u);

    const renditionId = item.rendition?.id;
    expect(renditionId).toBeTruthy();
    const content = await client.download({ albumId: album.id, itemId: item.id, renditionId: renditionId!, variant: "full" }, signal);
    const read = new Uint8Array(await new Response(content.body).arrayBuffer());
    expect(read.byteLength).toBe(content.totalBytes);
    expect(native.contents.size).toBe(0);
  });

  it("closes the native content handle when the download is aborted mid-stream", async () => {
    const native = fakeNative();
    const who = identity();
    const transport = createNativeSharingTransport({ identity: who.port, invoke: native.invoke, now: () => NOW });
    const client = createSharedAlbumClientOnTransport(transport);
    let keys = 0;
    const items = createSharedAlbumItems({
      client,
      uploader: createNativeSharingUploader({ identity: who.port, invokeBinary: native.invokeBinary, now: () => NOW }),
      newIdempotencyKey: () => `key-${++keys}`,
      sleep: async () => undefined,
    });
    const setup = new AbortController().signal;
    const album = await items.createAlbum("Synthetic album", setup);
    const item = await items.addFile(album.id, prepareAlbumFile(syntheticJpeg({ width: 1200, height: 800, seed: 11 })), setup);
    const request = { albumId: album.id, itemId: item.id, renditionId: item.rendition!.id, variant: "full" as const };

    // Aborted after open, before the page consumes the body: the handle is released and nothing more is read.
    const reads = () => native.invoke.mock.calls.filter(([command]) => command === "camera_sharing_content_read").length;
    const early = new AbortController();
    const opened = await client.download(request, early.signal);
    expect(native.contents.size).toBe(1);
    early.abort();
    await Promise.resolve();
    expect(native.contents.size).toBe(0);
    const readsAtAbort = reads();
    await expect(new Response(opened.body).arrayBuffer()).rejects.toBeDefined();
    expect(reads()).toBe(readsAtAbort);

    // Already aborted: nothing is left open.
    const gone = new AbortController();
    gone.abort();
    await expect(client.download(request, gone.signal)).rejects.toBeDefined();
    expect(native.contents.size).toBe(0);
  });

  it("refuses a range, a non-placeholder ticket, and use after the session changed", async () => {
    const native = fakeNative();
    const who = identity();
    const transport = createNativeSharingTransport({ identity: who.port, invoke: native.invoke, now: () => NOW });
    const signal = new AbortController().signal;
    await expect(transport.stream({ operation: "albumItems.download", method: "GET", path: "/cloud/sharing/v1/x", body: null, idempotencyKey: null }, { start: 0 }, signal))
      .rejects.toMatchObject({ code: "unsupported" });
    const uploader = createNativeSharingUploader({ identity: who.port, invokeBinary: native.invokeBinary, now: () => NOW });
    await expect(uploader.upload({ url: "https://storage.googleapis.com/x", method: "PUT", headers: {}, expiresAt: "2026-11-08T00:00:00.000Z", resumeOffsetBytes: 0 }, new Uint8Array([1]), "image/jpeg", signal))
      .rejects.toMatchObject({ code: "invalid_response" });
    who.set({ ...actor, sessionEpoch: "another-epoch" });
    const client = createSharedAlbumClientOnTransport(transport);
    await expect(client.request("albums.list", {}, { signal })).rejects.toMatchObject({ code: "scope_changed" });
    expect(native.invoke).not.toHaveBeenCalledWith("camera_sharing_request", expect.anything());
  });

  it("opens the screens only when native says sharing is configured, with Photo Web invite links", async () => {
    const native = fakeNative();
    const closed = vi.fn<NativePhotoInvoke>(async () => ({ configured: false }));
    expect(await createMacSharedAlbums({ identity: identity().port, invoke: closed, invokeBinary: native.invokeBinary, saveFile: async () => "saved", now: () => NOW })).toBeNull();
    const failing = vi.fn<NativePhotoInvoke>(async () => { throw "not_configured"; });
    expect(await createMacSharedAlbums({ identity: identity().port, invoke: failing, invokeBinary: native.invokeBinary, saveFile: async () => "saved", now: () => NOW })).toBeNull();
    const port = await createMacSharedAlbums({ identity: identity().port, invoke: native.invoke, invokeBinary: native.invokeBinary, saveFile: async () => "saved", now: () => NOW });
    expect(port).not.toBeNull();
    port?.dispose();
    expect(PHOTO_WEB_ORIGIN).toBe("https://photo.niho.life");
  });
});
