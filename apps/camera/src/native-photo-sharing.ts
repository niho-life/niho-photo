/**
 * 共有アルバム（`/cloud/sharing/v1`、Epic #240 / B08 #249）の Mac の native transport。画面の共有の client
 * （`@niho/photo-cloud-library/sharing`）が route の表で作った要求を、本人クラウド v2 と同じ native の通信
 * （`src-tauri/src/photo_sharing.rs`）へ渡す。応答の意味の検査は client（`SharingWire`）が、資格・宛先・upload の ticket は
 * native が持つ。
 *
 * - upload の ticket は native に留まり、画面には `https://upload.native.invalid/<handle>` の代わりが届く。完成写真の bytes は
 *   その代わりを添えて native へ渡し（raw IPC）、native が ticket の先へ送る（`createNativeSharingUploader`）。
 * - download は native が SHA-256 と長さを確かめてから 1MiB ずつ渡す。Range は使わない（全体を読む）。
 * - 保留の招待（BFF だけ）は native にない。招待のリンクはブラウザ（Photo Web）で開く。
 */
import type { VerifiedPhotoActor } from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";
import { PersonalPhotoCloudError } from "@niho/photo-cloud-library/protocol";
import type { RenderOutputUploader } from "@niho/photo-cloud-library/render-executor";
import {
  createSharedAlbumClientOnTransport,
  createSharedAlbumItems,
  createSharedAlbumMembership,
  createSharedAlbumMembershipClientOnTransport,
  createSharedAlbumScreensPort,
  prepareBrowserAlbumFile,
  type SharingTransport,
} from "@niho/photo-cloud-library/sharing";
import type { PhotoSharedAlbumPort } from "niho-photo-editing/shared-album/photo-shared-album-port";

import type { NativePhotoInvoke } from "./native-photo-client";
import type { NativePhotoBinaryInvoke } from "./native-photo-mask-uploader";
import type { NativePhotoRenderJobs } from "./native-photo-render-jobs";

/** `photo_sharing.rs` の raw IPC の添え書き。 */
export const SHARING_UPLOAD_HEADER = "x-niho-photo-sharing-upload";
/** 招待のリンクを開く Photo Web（`apps/photo-web` README の正式な提供先）。秘密は fragment に置く（Photo Web と同じ形）。 */
export const PHOTO_WEB_ORIGIN = "https://photo.niho.life";

type NativeScope = Readonly<{ userId: string; sessionId: string; sessionEpoch: string; transport: "mac-bearer" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentActor(identity: PersonalPhotoCloudIdentity, now: () => number): VerifiedPhotoActor {
  const actor = identity.getSnapshot();
  if (actor === null || actor.transport !== "mac-bearer" || Date.parse(actor.expiresAt) <= now()) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
  return actor;
}

function sameActor(left: VerifiedPhotoActor, right: VerifiedPhotoActor): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId
    && left.sessionEpoch === right.sessionEpoch && left.transport === right.transport;
}

function nativeScope(actor: VerifiedPhotoActor): NativeScope {
  return Object.freeze({ userId: actor.userId, sessionId: actor.sessionId, sessionEpoch: actor.sessionEpoch, transport: "mac-bearer" });
}

/** native の失敗（`AccountError` の名前）を client の失敗へ。 */
function nativeFailure(error: unknown): PersonalPhotoCloudError {
  if (error instanceof PersonalPhotoCloudError) return error;
  const code = typeof error === "string" ? error : isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "expired" || code === "cancelled") return new PersonalPhotoCloudError("scope_changed");
  if (code === "not_configured") return new PersonalPhotoCloudError("unsupported");
  if (code === "invalid_response") return new PersonalPhotoCloudError("invalid_response");
  return new PersonalPhotoCloudError("unavailable");
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new PersonalPhotoCloudError("invalid_response");
}

const decoder = new TextDecoder();

export type CreateNativeSharingTransportOptions = Readonly<{
  identity: PersonalPhotoCloudIdentity;
  invoke: NativePhotoInvoke;
  now?: () => number;
}>;

/** 共有の client を native の session で動かす transport。作ったときの本人と session でだけ送る。 */
export function createNativeSharingTransport(options: CreateNativeSharingTransportOptions): SharingTransport {
  const now = options.now ?? Date.now;
  const actor = currentActor(options.identity, now);
  let disposed = false;
  const capture = (): NativeScope => {
    if (disposed) throw new PersonalPhotoCloudError("disposed");
    const current = currentActor(options.identity, now);
    if (!sameActor(actor, current)) throw new PersonalPhotoCloudError("scope_changed");
    return nativeScope(current);
  };
  const assertCurrent = () => {
    const current = options.identity.getSnapshot();
    if (disposed || current === null || !sameActor(actor, current)) throw new PersonalPhotoCloudError("scope_changed");
  };
  return {
    scope: Object.freeze({ actorId: actor.userId, sessionEpoch: actor.sessionEpoch }),
    async exchange(encoded, limit, signal) {
      if (signal.aborted) throw signal.reason ?? new PersonalPhotoCloudError("disposed");
      const scope = capture();
      const body = encoded.body === null ? undefined : JSON.parse(decoder.decode(encoded.body)) as unknown;
      let answer: unknown;
      try {
        answer = await options.invoke("camera_sharing_request", {
          input: {
            scope, method: encoded.method, path: encoded.path,
            ...(body === undefined ? {} : { body }),
            ...(encoded.idempotencyKey === null ? {} : { idempotencyKey: encoded.idempotencyKey }),
          },
        });
      } catch (error) {
        throw nativeFailure(error);
      }
      assertCurrent();
      if (!isRecord(answer) || typeof answer.status !== "number" || !Number.isInteger(answer.status) || !("body" in answer)) {
        throw new PersonalPhotoCloudError("invalid_response");
      }
      if (JSON.stringify(answer.body).length > limit) throw new PersonalPhotoCloudError("too_large");
      return { status: answer.status, value: answer.body };
    },
    async stream(encoded, range, signal) {
      // native は全体を読んで照合する（Range は送らない）
      if (range !== undefined || encoded.method !== "GET") throw new PersonalPhotoCloudError("unsupported");
      if (signal.aborted) throw signal.reason ?? new PersonalPhotoCloudError("disposed");
      const scope = capture();
      let opened: unknown;
      try {
        opened = await options.invoke("camera_sharing_content_open", { input: { scope, path: encoded.path } });
      } catch (error) {
        throw nativeFailure(error);
      }
      if (!isRecord(opened) || typeof opened.handle !== "string" || typeof opened.contentType !== "string"
        || typeof opened.sha256 !== "string" || typeof opened.totalBytes !== "number" || opened.totalBytes <= 0) {
        throw new PersonalPhotoCloudError("invalid_response");
      }
      const handle = opened.handle;
      const totalBytes = opened.totalBytes;
      let closed = false;
      // 読み終わり・失敗・中止・取り消しのどれでも native の handle を一度だけ閉じる
      const close = () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", close);
        void options.invoke("camera_sharing_content_close", { input: { handle } }).catch(() => undefined);
      };
      if (signal.aborted) {
        close();
        throw signal.reason ?? new PersonalPhotoCloudError("disposed");
      }
      signal.addEventListener("abort", close, { once: true });
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (signal.aborted) throw signal.reason ?? new PersonalPhotoCloudError("disposed");
            assertCurrent();
            const chunk = toBytes(await options.invoke("camera_sharing_content_read", { input: { scope, handle, offset } }));
            if (chunk.byteLength === 0) {
              close();
              if (offset !== totalBytes) throw new PersonalPhotoCloudError("invalid_response");
              controller.close();
              return;
            }
            offset += chunk.byteLength;
            if (offset > totalBytes) throw new PersonalPhotoCloudError("invalid_response");
            controller.enqueue(chunk);
          } catch (error) {
            close();
            controller.error(signal.aborted ? signal.reason ?? new PersonalPhotoCloudError("disposed") : nativeFailure(error));
          }
        },
        cancel: close,
      });
      return { body, contentType: opened.contentType, sha256: opened.sha256, totalBytes, range: { start: 0, endInclusive: totalBytes - 1 } };
    },
    dispose() {
      disposed = true;
    },
  };
}

export type CreateNativeSharingUploaderOptions = Readonly<{
  identity: PersonalPhotoCloudIdentity;
  invokeBinary: NativePhotoBinaryInvoke;
  now?: () => number;
}>;

/** 完成写真の bytes を native へ渡し、native に留めた ticket の先へ送ってもらう（ticket の url は native の代わり）。 */
export function createNativeSharingUploader(options: CreateNativeSharingUploaderOptions): RenderOutputUploader {
  const now = options.now ?? Date.now;
  return {
    async upload(ticket, bytes, contentType, signal) {
      if (signal.aborted) throw signal.reason ?? new PersonalPhotoCloudError("disposed");
      if (!ticket.url.startsWith("https://upload.native.invalid/")) throw new PersonalPhotoCloudError("invalid_response");
      const scope = nativeScope(currentActor(options.identity, now));
      try {
        await options.invokeBinary("camera_sharing_upload", bytes, {
          [SHARING_UPLOAD_HEADER]: JSON.stringify({ scope, ticketUrl: ticket.url, contentType }),
        });
      } catch (error) {
        throw nativeFailure(error);
      }
    },
  };
}

export type CreateMacSharedAlbumsOptions = Readonly<{
  identity: PersonalPhotoCloudIdentity;
  invoke: NativePhotoInvoke;
  invokeBinary: NativePhotoBinaryInvoke;
  /** 完成写真を保存ダイアログで選んだ場所へ書く（`camera_save_file`）。 */
  saveFile: (bytes: Uint8Array, fileName: string) => Promise<unknown>;
  /** Created only after native sharing is configured; owned and disposed by the returned screen port. */
  createRenderJobs?: () => NativePhotoRenderJobs;
  now?: () => number;
}>;

/**
 * Mac の「共有アルバム」の画面の port。native が共有の通信を開いていなければ（公開の build）null で、画面は出さない。
 */
export async function createMacSharedAlbums(options: CreateMacSharedAlbumsOptions): Promise<PhotoSharedAlbumPort | null> {
  let status: unknown;
  try {
    status = await options.invoke("camera_sharing_status", { input: null });
  } catch {
    return null;
  }
  if (!isRecord(status) || status.configured !== true) return null;
  const transport = createNativeSharingTransport({ identity: options.identity, invoke: options.invoke, ...(options.now ? { now: options.now } : {}) });
  const albumClient = createSharedAlbumClientOnTransport(transport);
  const membershipClient = createSharedAlbumMembershipClientOnTransport(transport);
  let renderJobs: NativePhotoRenderJobs | null = null;
  try { renderJobs = options.createRenderJobs?.() ?? null; } catch { /* Keep album browsing available if local rendering is unavailable. */ }
  const port = createSharedAlbumScreensPort({
    items: createSharedAlbumItems({
      client: albumClient,
      uploader: createNativeSharingUploader({ identity: options.identity, invokeBinary: options.invokeBinary, ...(options.now ? { now: options.now } : {}) }),
    }),
    membership: createSharedAlbumMembership({ client: membershipClient }),
    download: (request, signal) => albumClient.download(request, signal),
    inviteUrl: (secret) => `${PHOTO_WEB_ORIGIN}/#invite=${encodeURIComponent(secret)}`,
    saveFile: async (name, file) => {
      await options.saveFile(new Uint8Array(await file.arrayBuffer()), name);
    },
    prepareFile: prepareBrowserAlbumFile,
    ...(renderJobs === null ? {} : { renderJobs }),
  });
  renderJobs?.wake();
  return {
    ...port,
    dispose() {
      port.dispose();
      renderJobs?.dispose();
      albumClient.dispose();
      membershipClient.dispose();
    },
  };
}
