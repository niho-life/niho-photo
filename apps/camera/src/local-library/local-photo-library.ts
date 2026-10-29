/**
 * この Mac の `PhotoLibrary`（接続口の型は packages/photo-editing/src/library/photo-library.ts。spec
 * 公開移植前の内部構成については docs/migration/mac-client.md を参照。
 * 形にする。編集面はこれを越して写真を読み書きし、Tauri を import しない（決まりごと 6）。
 *
 * - 写真の ID は一覧の `entryId`（不透明な ID）。開いた写真だけ、native の `photoId` と中身の SHA-256・保存した補正を「開いた写真の
 *   handle」として持つ（一覧の条件・選んだフォルダは持たない。編集面が `list` の query で渡す）
 * - 一覧は `folderId` のフォルダとその下の写真を native から読み、種類・補正済みで絞って更新日時の新しい順に並べ、ページに切る
 *   （撮影日時は読まないので、並びはどちらも更新日時）。お気に入り・アルバム・記事の画像は無い（絞ると空）
 * - 一覧のタイルと開いた直後の仮の画は、native の URI scheme（`niho-thumb://`。src-tauri の thumbnail_scheme.rs）のサムネイル
 * - オリジナル（JPEG・小さな PNG）は native の現像の入力（`raster` の token）から読む。RAW・HEIC / HEIF・TIFF・大きな PNG と
 *   作業コピーで直す JPEG は、native の sidecar が作る作業コピー（`ensureWorkingCopy` → `loadWorkingCopy`）
 * - 「オリジナル」の書き出しは native がファイルを写す（バイト列を画面へ運ばない。{@link takeNativeSaveResult}）
 * - 写真の情報（`info`。右パネルの「情報」）は、native が開いた写真のファイルの EXIF などを ImageIO で都度読む（覚えない）
 * - 補正の版（`developVersions`・`saveDevelopVersions`。右パネルの「版」）は、native が補正と同じフォルダの別のファイル
 *   （`<SHA-256>.versions.json`）に配列まるごと読み書きする。鍵は開いたときの中身の SHA-256 で、写真が置き換わっていたら読み書きしない
 * - 消さない（`delete` は何もしない。編集面は置き場が local のとき消す道具を出さない）
 * - 選別のフラグ（採用 / 却下。`flags`・一覧の `flag`・`list` の `flag` の絞り込み。niho-photo#47）は、native が一覧の写真に添え
 *   （名前・大きさ・更新日時で見分ける。開かない）、`entryId` で付け外しする（src-tauri の flags.rs）。一覧・付け外しで分かった
 *   フラグは開いた写真の行にも添える
 */
import { BrowserPhotoSourceError } from "niho-photo-editing/browser-photo-source";
import { browserCloudPhotoKind } from "niho-photo-editing/browser-photo-cloud-source";
import { developEngineManifestPath } from "niho-photo-editing/develop-engine/develop-engine-manifest";
import {
  isNeutralDevelopSettings,
  readDevelopSettings,
  type DevelopSettings,
} from "niho-photo-editing/develop-engine/develop-settings";
import { readPhotoLibraryDevelopVersions } from "niho-photo-editing/editor/browser-photo-editing-versions-model";
import { readPhotoLibraryNativeRenderer } from "niho-photo-editing/photo-editing-native-export";
import { readJpegPixelSize, readPngPixelSize } from "niho-photo-editing/image-bytes-metadata";
import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryDevelopSourceContext,
  PhotoLibraryFlag,
  PhotoLibraryFolder,
  PhotoLibraryItem,
  PhotoLibraryListPage,
  PhotoLibraryListQuery,
  PhotoLibraryPhoto,
  PhotoLibraryPhotoInfo,
  PhotoLibraryInteractivePreview,
  PhotoLibraryProvisionalDraft,
  PhotoLibraryWorkingCopy,
  PhotoLibraryWorkingCopyDownload,
  PhotoLibraryWorkingCopyResult,
} from "niho-photo-editing/library/photo-library";
import type { PhotoEditingSaveFileResult } from "niho-photo-editing/library/photo-library-context";

import {
  CameraCommandError,
  type CameraCommands,
  type DevelopSource,
  type DevelopStatus,
  type LibraryEntry,
  type LibraryFolder,
  type OpenedPhoto,
  type SavedDevelopSettings,
} from "./commands";

/** 一覧のタイル・開いた直後の仮の画のサムネイルの長辺（native の上限 256px）。 */
export const LOCAL_THUMBNAIL_SIZE = 256;
/** provisional 編集入力は一覧の 256px を拡大せず、native にこの長辺を別途作らせる。 */
export const LOCAL_INTERACTIVE_PREVIEW_SIZE = 1600;
/** サムネイルの URI scheme（src-tauri の thumbnail_scheme.rs と tauri.conf.json の CSP の img-src）。 */
export const LOCAL_THUMBNAIL_SCHEME = "niho-thumb";

/** 1 ページの件数（native はフォルダを読み直して切るので、少なく切りすぎない）。 */
export const LOCAL_LIST_PAGE_SIZE = 500;
/** プリセットの名前・XMP の上限（src-tauri の presets.rs と同じ）。 */
export const LOCAL_PRESET_NAME_MAX_CHARS = 100;
export const LOCAL_PRESET_XMP_MAX_BYTES = 512 * 1024;

/** 作業コピーの参照の期限（この Mac の token は期限で切れない。使い終えたら `loadWorkingCopy` が作り直す）。 */
const NEVER_EXPIRES = "9999-12-31T23:59:59.000Z";
/** 更新日時の分からない写真の日時（並びの最後）。 */
const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";
const NATIVE_FAILED_MESSAGE = "うまくいきませんでした。もう一度お試しください。";
const DELETE_UNSUPPORTED_MESSAGE = "この Mac の写真は消せません。";
const SPACE_FULL_MESSAGE = "この Mac の空き容量が足りません。";
/** 作業コピーの形が分からない（native が返したものが PNG でも JPEG でもない）。 */
const WORKING_COPY_UNREADABLE = "fetch_failed";

/** 現像の sidecar の確かめを待つ間隔と回数（起動時の確かめが終わるまで `camera_develop_status` は false を返しうる）。 */
const DEVELOP_STATUS_RETRY_MS = 400;
const DEVELOP_STATUS_ATTEMPTS = 3;
const INTERACTIVE_PREVIEW_CACHE_LIMIT = 3;
let provisionalDraftGeneration = 0;
const PROVISIONAL_DRAFT_PREFIX = "niho-photo:provisional-draft:v1:";

/** 何もできない値（読めるまで・読めなかったとき。fail closed）。 */
export const LOCAL_CLOSED_CAPABILITIES: PhotoLibraryCapabilities = Object.freeze({
  place: "local",
  rawWorkingCopy: false,
  nativeExport: false,
  nativeExportUpdateRequired: false,
  exportFolder: false,
  nativeExportRaster: false,
  nativeExportMasks: false,
  maskSurfaces: false,
  maskDetection: Object.freeze({ subject: false, sky: false }),
  cutout: false,
  favorites: false,
  albums: false,
  articleImages: false,
  multiSelect: false,
  mobile: false,
  editedPreview: false,
  addFiles: false,
  addFromDevice: false,
  addFromDeviceFolder: false,
  info: false,
  versions: false,
  flags: false,
});

/** 現像（同梱の sidecar）が使えるかでの、この Mac のできること。 */
export function localCapabilities(
  status: Pick<DevelopStatus, "available" | "fullSizeRaster" | "masks" | "renderer">,
  cutoutAvailable = false,
): PhotoLibraryCapabilities {
  // 原寸へ渡せる設定は、同梱の niho-develop-render が答えた描ける設定で決める（答えない古い renderer は省略 = 今の遮断のまま。#131）
  const renderer = status.available ? readPhotoLibraryNativeRenderer(status.renderer) : undefined;
  return {
    ...LOCAL_CLOSED_CAPABILITIES,
    rawWorkingCopy: status.available,
    nativeExport: status.available,
    // HEIC / HEIF・TIFF の原寸は、同梱の apple-raw-linear が原寸の raster を持つときだけ
    nativeExportRaster: status.available && status.fullSizeRaster === true,
    // 部分補正（`masks`）のある設定は、同梱の niho-develop-render が描ける版のときだけ原寸で書き出す（古い native は返さない = 描けない）
    nativeExportMasks: status.available && status.masks === true,
    ...(renderer ? { nativeExportRenderer: renderer } : {}),
    exportFolder: status.available,
    // マスクの面の置き場はアプリ自身のコマンド（同梱の sidecar に依らない）
    maskSurfaces: true,
    // 被写体のマスクの面は同梱の niho-camera-cutout（lock の版で `surface` を持つ。macOS 13 では起動しない）で作る。空はまだ作れない
    maskDetection: { subject: cutoutAvailable, sky: false },
    cutout: cutoutAvailable,
    multiSelect: true,
    // 写真の情報は native が ImageIO で読む（同梱の sidecar に依らない）
    info: true,
    // 補正の版は native が補正の隣のファイルに残す（同梱の sidecar に依らない）
    versions: true,
    // 選別のフラグは native が 1 つのファイルに残す（同梱の sidecar に依らない。niho-photo#47）
    flags: true,
  };
}

/** 一覧の写真のサムネイルの URL（`<img src>` に入れるだけ。パスは含めない）。 */
export function localThumbnailUrl(entryId: string, size = LOCAL_THUMBNAIL_SIZE): string {
  return `${LOCAL_THUMBNAIL_SCHEME}://localhost/${encodeURIComponent(entryId)}?size=${size}`;
}

// ---------------------------------------------------------------------------
// 「オリジナル」の書き出し（native がファイルを写す）

/**
 * native が保存ダイアログで済ませた保存の結果。編集面は `downloadOriginal` の Blob を `host.saveFile` に渡すので、この Mac の
 * library はファイルを native で写したうえで中身の無い Blob を返し、その Blob に結果を結び付けておく（host がダイアログを出し直さない）。
 */
const nativeSaveResults = new WeakMap<Blob, PhotoEditingSaveFileResult>();

function nativelySaved(result: PhotoEditingSaveFileResult): Blob {
  const blob = new Blob([]);
  nativeSaveResults.set(blob, result);
  return blob;
}

/** `downloadOriginal` が native で保存を済ませた Blob なら、その結果（一度だけ）。ほかは null。 */
export function takeNativeSaveResult(blob: Blob): PhotoEditingSaveFileResult | null {
  const result = nativeSaveResults.get(blob) ?? null;
  nativeSaveResults.delete(blob);
  return result;
}

// ---------------------------------------------------------------------------
// 行

/** 開いた写真の handle（native の `photoId` と、開いた時点の中身・保存した補正）。 */
type OpenHandle = {
  nativeId: string;
  fileName: string;
  sizeBytes: number;
  contentSha256: string;
  modifiedAt: string | null;
  saved: SavedDevelopSettings | null;
};

function fileExtensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/** 作業コピーを作らずオリジナルのまま描ける形式（JPEG・PNG）。編集面が作業コピーを求めたら作業コピーを作らせる。 */
function isDirectRasterExtension(extension: string): boolean {
  return extension === "jpg" || extension === "jpeg" || extension === "png";
}

function flattenEntries(folder: LibraryFolder, into: LibraryEntry[] = []): LibraryEntry[] {
  into.push(...folder.photos);
  for (const child of folder.children) flattenEntries(child, into);
  return into;
}

function folderTree(folder: LibraryFolder): PhotoLibraryFolder {
  return {
    folderId: folder.folderId,
    name: folder.name,
    children: folder.children.map(folderTree),
    truncated: folder.truncated,
  };
}

function savedPart(saved: SavedDevelopSettings | null) {
  return {
    hasDevelopSettings: saved !== null,
    developSettings: (saved?.developSettings ?? null) as DevelopSettings | null,
    developSettingsUpdatedAt: saved ? new Date(saved.updatedAtMs).toISOString() : null,
    developRevision: saved?.revision ?? 0,
    hasEdits: saved !== null && !isNeutralDevelopSettings(saved.developSettings),
  };
}

/** native が一覧の写真に添えた選別のフラグ（付いていなければ null）。 */
function entryFlag(entry: Pick<LibraryEntry, "flag">): PhotoLibraryFlag | null {
  return entry.flag === "pick" || entry.flag === "reject" ? entry.flag : null;
}

/** 開いた写真の行（`contentSha256`・補正・版が入る。フラグは library が添える）。 */
function openedRowOf(entryId: string, handle: OpenHandle): PhotoLibraryItem & { contentSha256: string } {
  return {
    id: entryId,
    fileName: handle.fileName,
    fileExtension: fileExtensionOf(handle.fileName),
    sizeBytes: handle.sizeBytes,
    contentSha256: handle.contentSha256,
    createdAt: handle.modifiedAt ?? UNKNOWN_TIME,
    capturedAt: null,
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    webRenderedRevision: null,
    favorite: false,
    previewUrl: localThumbnailUrl(entryId),
    ...savedPart(handle.saved),
  };
}

/** 一覧の行。開いた写真は開いたときの中身・補正で埋める（ほかは一覧では読まない）。 */
function listedRow(entry: LibraryEntry, handle: OpenHandle | undefined): PhotoLibraryItem {
  const base: PhotoLibraryItem = {
    id: entry.entryId,
    fileName: entry.fileName,
    fileExtension: fileExtensionOf(entry.fileName),
    sizeBytes: entry.sizeBytes,
    contentSha256: null,
    createdAt: entry.modifiedAt || UNKNOWN_TIME,
    capturedAt: null,
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: entry.hasEdits,
    hasEdits: entry.hasEdits,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    favorite: false,
    flag: entryFlag(entry),
    previewUrl: localThumbnailUrl(entry.entryId),
  };
  return handle ? { ...base, contentSha256: handle.contentSha256, ...savedPart(handle.saved) } : base;
}

function matchesQuery(entry: LibraryEntry, query: PhotoLibraryListQuery): boolean {
  if (query.kind !== undefined && browserCloudPhotoKind({ fileExtension: fileExtensionOf(entry.fileName) }) !== query.kind) {
    return false;
  }
  if (query.flag === "pick" && entryFlag(entry) !== "pick") return false;
  if (query.flag === "notRejected" && entryFlag(entry) === "reject") return false;
  return query.edited === undefined || entry.hasEdits === query.edited;
}

function byModifiedDesc(a: LibraryEntry, b: LibraryEntry): number {
  if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
  if (a.fileName !== b.fileName) return a.fileName < b.fileName ? -1 : 1;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

function emptyPage(): PhotoLibraryListPage {
  return { items: [], next: null, usage: null, counts: null };
}

function readOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function isCode(error: unknown, ...codes: string[]): error is CameraCommandError {
  return error instanceof CameraCommandError && codes.includes(error.code);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

let maskDetectionSequence = 0;
/** native の取り消しの口（`camera_cutout_cancel`）に渡す操作の ID（英数字と `-` だけ）。 */
function maskDetectionOperationId(): string {
  maskDetectionSequence += 1;
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now()}-${maskDetectionSequence}`;
  return `mask-${random}`;
}

/** 作業コピーの大きさ（RAW は sidecar の `outputSize`、ラスタの作業コピーは中身の寸法）。 */
function readOutputSize(meta: Record<string, unknown>): { width: number; height: number } | null {
  const source = meta._source;
  if (typeof source !== "object" || source === null) return null;
  const size = (source as { outputSize?: unknown }).outputSize;
  if (typeof size !== "object" || size === null) return null;
  const { width, height } = size as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? { width, height } : null;
}

function pixelSizeOf(bytes: Uint8Array): { width: number; height: number } | null {
  return readPngPixelSize(bytes) ?? readJpegPixelSize(bytes);
}

function provisionalDraftKey(contentSha256: string): string {
  return `${PROVISIONAL_DRAFT_PREFIX}${contentSha256}`;
}

function validContentSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function readProvisionalDraft(contentSha256: string): PhotoLibraryProvisionalDraft | null {
  if (typeof window === "undefined" || !validContentSha256(contentSha256)) return null;
  let parsed: unknown;
  try {
    const stored = window.localStorage.getItem(provisionalDraftKey(contentSha256));
    if (!stored) return null;
    parsed = JSON.parse(stored) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const settings = readDevelopSettings(record.settings);
  if (
    record.schemaVersion !== 1 ||
    record.contentSha256 !== contentSha256 ||
    !settings ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 1 ||
    typeof record.updatedAt !== "string"
  ) {
    return null;
  }
  return { contentSha256, settings, generation: record.generation, updatedAt: record.updatedAt };
}

function writeProvisionalDraft(contentSha256: string, settings: DevelopSettings, now: Date): PhotoLibraryProvisionalDraft {
  if (typeof window === "undefined" || !validContentSha256(contentSha256)) {
    throw new CameraCommandError("invalidRequest", "未保存の補正をこの端末に退避できません。");
  }
  const previous = readProvisionalDraft(contentSha256);
  const draft = {
    contentSha256,
    settings,
    generation: Math.max(previous?.generation ?? 0, provisionalDraftGeneration) + 1,
    updatedAt: now.toISOString(),
  } satisfies PhotoLibraryProvisionalDraft;
  provisionalDraftGeneration = draft.generation;
  try {
    window.localStorage.setItem(provisionalDraftKey(contentSha256), JSON.stringify({ schemaVersion: 1, ...draft }));
  } catch {
    throw new CameraCommandError("internal", "未保存の補正をこの端末に退避できません。");
  }
  return draft;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** native の写真の情報（`camera_photo_info`）を接続口の形にする（形の違う値は読めなかった項目として null）。 */
function toPhotoInfo(value: unknown): PhotoLibraryPhotoInfo {
  const info = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const camera = (typeof info.camera === "object" && info.camera !== null ? info.camera : {}) as Record<string, unknown>;
  const gps = (typeof info.gps === "object" && info.gps !== null ? info.gps : {}) as Record<string, unknown>;
  const make = textOrNull(camera.make);
  const model = textOrNull(camera.model);
  const latitude = finiteOrNull(gps.latitude);
  const longitude = finiteOrNull(gps.longitude);
  return {
    camera: make || model ? { make, model } : null,
    lens: textOrNull(info.lens),
    iso: finiteOrNull(info.iso),
    exposureTimeSeconds: finiteOrNull(info.exposureTimeSeconds),
    fNumber: finiteOrNull(info.fNumber),
    focalLengthMm: finiteOrNull(info.focalLengthMm),
    capturedAt: textOrNull(info.capturedAt),
    width: finiteOrNull(info.width),
    height: finiteOrNull(info.height),
    gps: latitude !== null && longitude !== null ? { latitude, longitude } : null,
  };
}

/** 作業コピーの中身（RAW は 16bit PNG、ラスタは ICC 付きの 8bit JPEG）。先頭のバイトで見分ける。 */
function workingCopyEncoding(bytes: Uint8Array, meta: Record<string, unknown>): PhotoLibraryWorkingCopy["encoding"] {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png16";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg8";
  if (meta.encoding === "jpeg8") return "jpeg8";
  throw new BrowserPhotoSourceError(WORKING_COPY_UNREADABLE);
}

function ownArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export type LocalPhotoLibraryOptions = {
  /** 今の時刻（テスト用） */
  now?: () => Date;
  /** 待つ（テスト用。現像の確かめの待ち） */
  sleep?: (ms: number) => Promise<void>;
};

export type LocalPhotoLibrary = PhotoLibrary & {
  place: "local";
  folders: NonNullable<PhotoLibrary["folders"]>;
  selectedPhotos: NonNullable<PhotoLibrary["selectedPhotos"]>;
  exportNative: NonNullable<PhotoLibrary["exportNative"]>;
  chooseExportFolder: NonNullable<PhotoLibrary["chooseExportFolder"]>;
  /** 背景除去 adapter だけが使う: entryId を、同じ中身の開いた photoId へ解決する。 */
  withStablePhoto: <T>(photoKey: string, run: (photoId: string) => Promise<T>) => Promise<T>;
};

export function createLocalPhotoLibrary(commands: CameraCommands, options: LocalPhotoLibraryOptions = {}): LocalPhotoLibrary {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** 開いた写真（entryId → handle） */
  const handles = new Map<string, OpenHandle>();
  /** 開いている途中の写真（同じ写真を同時に 2 回開かない） */
  const opening = new Map<string, Promise<OpenHandle>>();
  /**
   * 寸法を読むために先に読んだラスタの作業コピー（token → バイト列）。`loadWorkingCopy` が受け取る（token は 1 回限りなので、
   * 読み直さない）。数 MB の JPEG だけで、古いものから 2 つまで。
   */
  const prefetched = new Map<string, Uint8Array>();
  /** content hash + 長辺ごとのimmutable bytes。entryId/revisionをcacheせず、返すrowは毎回現在のhandleから作る。 */
  type CachedInteractivePreview = { bytes: Uint8Array; width: number; height: number; type: string };
  type InteractivePreviewJob = {
    requestId: string;
    priority: "selected" | "prefetch";
    consumers: Set<symbol>;
    promise: Promise<CachedInteractivePreview>;
  };
  const interactivePreviews = new Map<string, CachedInteractivePreview>();
  const interactivePreviewJobs = new Map<string, InteractivePreviewJob>();
  let interactivePreviewSequence = 0;
  /** 一覧・付け外しで分かった選別のフラグ（entryId → フラグ。開いた写真の行に添える。分からない写真には添えない） */
  const knownFlags = new Map<string, PhotoLibraryFlag | null>();
  const rememberFlags = (entries: readonly LibraryEntry[]) => {
    for (const entry of entries) knownFlags.set(entry.entryId, entryFlag(entry));
  };
  /** 開いた写真の行（分かっていればフラグも。分からなければ `flag` を省き、一覧の行の値を上書きしない） */
  const openedRow = (entryId: string, handle: OpenHandle): PhotoLibraryItem & { contentSha256: string } => {
    const row = openedRowOf(entryId, handle);
    return knownFlags.has(entryId) ? { ...row, flag: knownFlags.get(entryId) ?? null } : row;
  };

  const toHandle = (opened: OpenedPhoto): OpenHandle => ({
    nativeId: opened.photoId,
    fileName: opened.fileName,
    sizeBytes: opened.sizeBytes,
    contentSha256: opened.contentSha256,
    modifiedAt: opened.modifiedAt ?? null,
    saved: opened.saved,
  });

  /** 写真を開き直す（中身の SHA-256 と保存した補正を読み直す）。開けなければ native の失敗を投げる。 */
  const openHandle = (entryId: string): Promise<OpenHandle> => {
    const pending = opening.get(entryId);
    if (pending) return pending;
    const promise = (async () => {
      const result = await commands.openPhotos([entryId]);
      const opened = result.photos.find((photo) => photo.entryId === entryId);
      if (!opened) {
        const failure = result.failed.find((failed) => failed.entryId === entryId);
        throw new CameraCommandError(failure?.code ?? "notFound", failure?.message ?? "写真が見つかりません。");
      }
      return toHandle(opened);
    })().finally(() => opening.delete(entryId));
    opening.set(entryId, promise);
    return promise;
  };

  /** 通常の再オープンは新しい handle を採用する。安定性が必要な操作は digest を照合してから採用する。 */
  const reopen = async (entryId: string): Promise<OpenHandle> => {
    const handle = await openHandle(entryId);
    handles.set(entryId, handle);
    return handle;
  };

  /** 開いた写真の handle（まだなら開く）。 */
  const handleOf = (entryId: string): Promise<OpenHandle> => {
    const handle = handles.get(entryId);
    return handle ? Promise.resolve(handle) : reopen(entryId);
  };

  /**
   * 開いた写真で native を呼ぶ。native が写真を手放していた（開いた写真の上限で古いものから閉じた）ら、開き直して 1 回だけやり直す。
   */
  const withHandle = async <T>(entryId: string, run: (handle: OpenHandle) => Promise<T>): Promise<T> => {
    const handle = await handleOf(entryId);
    try {
      return await run(handle);
    } catch (error) {
      if (!isCode(error, "notFound")) throw error;
      return run(await reopen(entryId));
    }
  };

  /** native が開いた写真を手放していたら、同じ中身のときだけ開き直す。写真が置き換わっていたら古い操作をやり直さない。 */
  const withStableHandle = async <T>(entryId: string, run: (handle: OpenHandle) => Promise<T>): Promise<T> => {
    const handle = await handleOf(entryId);
    try {
      return await run(handle);
    } catch (error) {
      if (!isCode(error, "notFound")) throw error;
      const reopened = await openHandle(entryId);
      if (reopened.contentSha256 !== handle.contentSha256) throw error;
      if (handles.get(entryId) === handle) handles.set(entryId, reopened);
      return run(reopened);
    }
  };

  const sourceContextFor = (
    saved: SavedDevelopSettings | null,
    requested?: PhotoLibraryDevelopSourceContext,
  ): PhotoLibraryDevelopSourceContext => {
    if (!saved) {
      return requested ?? { hasSavedDevelopSettings: false, hasDevelopEdits: false, baseVersion: null };
    }
    const base = saved.developSettings.base;
    return {
      hasSavedDevelopSettings: true,
      hasDevelopEdits: !isNeutralDevelopSettings(saved.developSettings),
      baseVersion: typeof base === "string" ? base : null,
    };
  };

  const developSourceOf = (handle: OpenHandle, requested?: PhotoLibraryDevelopSourceContext) =>
    commands.developSource(handle.nativeId, {
      forceWorkingCopy: isDirectRasterExtension(fileExtensionOf(handle.fileName)),
      sourceContext: sourceContextFor(handle.saved, requested),
    });

  const remember = (token: string, bytes: Uint8Array) => {
    prefetched.set(token, bytes);
    while (prefetched.size > 2) {
      const oldest = prefetched.keys().next().value;
      if (oldest === undefined) break;
      prefetched.delete(oldest);
    }
  };

  const rememberInteractivePreview = (key: string, preview: CachedInteractivePreview) => {
    interactivePreviews.delete(key);
    interactivePreviews.set(key, preview);
    while (interactivePreviews.size > INTERACTIVE_PREVIEW_CACHE_LIMIT) {
      const oldest = interactivePreviews.keys().next().value;
      if (oldest === undefined) break;
      interactivePreviews.delete(oldest);
    }
  };

  const loadInteractivePreviewWithPriority = async (
    photoId: string,
    request: { signal: AbortSignal; maxDimension: number },
    priority: "selected" | "prefetch",
  ): Promise<PhotoLibraryInteractivePreview> => {
    throwIfAborted(request.signal);
    if (request.maxDimension < 1280 || request.maxDimension > 2048) {
      throw new CameraCommandError("invalidRequest", "写真を読み込み直してください。");
    }
    const handle = await handleOf(photoId);
    throwIfAborted(request.signal);
    const key = `${handle.contentSha256}:${request.maxDimension}`;
    const cached = interactivePreviews.get(key);
    if (cached) {
      interactivePreviews.delete(key);
      interactivePreviews.set(key, cached);
      return {
        photo: openedRow(photoId, handle),
        file: new File([cached.bytes.slice()], "interactive-preview", { type: cached.type }),
        width: cached.width,
        height: cached.height,
      };
    }
    let pending = interactivePreviewJobs.get(key);
    if (pending?.priority === "prefetch" && priority === "selected") {
      void commands.cancelInteractivePreview(pending.requestId).catch(() => undefined);
      interactivePreviewJobs.delete(key);
      pending = undefined;
    }
    if (!pending) {
      const requestId = `preview-${++interactivePreviewSequence}`;
      const job: InteractivePreviewJob = {
        requestId,
        priority,
        consumers: new Set(),
        promise: Promise.resolve({ bytes: new Uint8Array(), width: 0, height: 0, type: "" }),
      };
      job.promise = commands.interactivePreview(photoId, request.maxDimension, requestId, priority).then((bytes) => {
        const size = pixelSizeOf(bytes);
        if (!size || Math.max(size.width, size.height) < 1280 || Math.max(size.width, size.height) > 2048) {
          throw new CameraCommandError("decodeFailed", "高画質表示を準備できませんでした。");
        }
        const type = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
        const preview = { bytes: bytes.slice(), width: size.width, height: size.height, type };
        rememberInteractivePreview(key, preview);
        return preview;
      }).finally(() => {
        if (interactivePreviewJobs.get(key) === job) interactivePreviewJobs.delete(key);
      });
      pending = job;
      interactivePreviewJobs.set(key, job);
    }
    const activeJob = pending;
    const consumer = Symbol();
    activeJob.consumers.add(consumer);
    const onAbort = () => {
      activeJob.consumers.delete(consumer);
      if (activeJob.consumers.size === 0) {
        if (interactivePreviewJobs.get(key) === activeJob) interactivePreviewJobs.delete(key);
        void commands.cancelInteractivePreview(activeJob.requestId).catch(() => undefined);
      }
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const preview = await activeJob.promise;
      throwIfAborted(request.signal);
      return {
        photo: openedRow(photoId, handle),
        file: new File([preview.bytes.slice()], "interactive-preview", { type: preview.type }),
        width: preview.width,
        height: preview.height,
      };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      activeJob.consumers.delete(consumer);
    }
  };

  const loadInteractivePreview = (
    photoId: string,
    request: { signal: AbortSignal; maxDimension: number },
  ) => loadInteractivePreviewWithPriority(photoId, request, "selected");

  const workingCopyDownload = async (
    handle: OpenHandle,
    source: Extract<DevelopSource, { kind: "workingCopy" }>,
  ): Promise<PhotoLibraryWorkingCopyDownload> => {
    let size = readOutputSize(source.meta);
    if (!size) {
      // ラスタの作業コピー（JPEG）は meta に寸法が無いので、中身を先に読んで寸法を読む（読んだ中身は loadWorkingCopy が使う）
      const bytes = await commands.developSourceBytes(handle.nativeId, source.token);
      remember(source.token, bytes);
      size = pixelSizeOf(bytes);
    }
    return {
      ref: source.token,
      expiresAt: NEVER_EXPIRES,
      work: {
        baseVersion: source.baseVersion,
        sizeBytes: source.byteLength,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        meta: source.meta,
        renderedAt: now().toISOString(),
      },
    };
  };

  const describe = (error: unknown, fallback: string) => (error instanceof CameraCommandError ? error.message : fallback);

  const selectedEntries = async (): Promise<LibraryEntry[]> => commands.selectedPhotos();

  const pageFromEntries = (
    entries: readonly LibraryEntry[],
    query: PhotoLibraryListQuery,
  ): PhotoLibraryListPage => {
    rememberFlags(entries);
    const all = entries.filter((entry) => matchesQuery(entry, query));
    // 「選んだ写真」は前のクラウド表示で覚えた並びに左右されず、選択グループの新しい順・picker の順を保つ。
    const matching = all;
    const offset = readOffset(query.cursor);
    const limit = Math.max(1, Math.min(query.limit ?? LOCAL_LIST_PAGE_SIZE, LOCAL_LIST_PAGE_SIZE));
    const page = matching.slice(offset, offset + limit);
    const end = offset + page.length;
    return {
      items: page.map((entry) => listedRow(entry, handles.get(entry.entryId))),
      next: end < matching.length ? String(end) : null,
      usage: null,
      counts: offset === 0 ? { photos: entries.length, articleImages: 0, favorites: 0, matching: matching.length } : null,
    };
  };

  const library: LocalPhotoLibrary = {
    place: "local",
    initialCapabilities: LOCAL_CLOSED_CAPABILITIES,
    async capabilities() {
      const cutoutAvailable = await commands.cutoutStatus().then((status) => status.available, () => false);
      try {
        for (let attempt = 1; ; attempt += 1) {
          const status = await commands.developStatus();
          if (status.available || attempt >= DEVELOP_STATUS_ATTEMPTS) return localCapabilities(status, cutoutAvailable);
          await sleep(DEVELOP_STATUS_RETRY_MS);
        }
      } catch {
        return localCapabilities({ available: false }, cutoutAvailable);
      }
    },
    rollout: async () => ({ crop: true, mobileEditing: false }),
    engineAssets: {
      preferNative: true,
      // 段 2 の wasm は画面に同梱（scripts/stage-develop-engine.mjs）。niho.life から取らない（決まりごと 4）
      manifestUrl: () => {
        if (typeof window === "undefined") return null;
        try {
          return new URL(developEngineManifestPath(), window.location.origin).href;
        } catch {
          return null;
        }
      },
    },
    limits: {
      listPageSize: LOCAL_LIST_PAGE_SIZE,
      lookupMaxCount: 100,
      referencesMaxCount: 0,
      photosPerRequest: 50,
    },
    errors: {
      describe,
      describeStorageError: (error, fallback) => (error instanceof CameraCommandError ? describe(error, fallback) : null),
      describeDeleteFailure: () => DELETE_UNSUPPORTED_MESSAGE,
      isNativeError: (error) => error instanceof CameraCommandError,
      describeNative: (error) => describe(error, NATIVE_FAILED_MESSAGE),
      isPermanentSaveFailure: (error) => isCode(error, "notFound", "invalidRequest"),
      isNotFound: (error) => isCode(error, "notFound"),
      readQuotaExceeded: () => null,
      describeQuotaExceeded: () => SPACE_FULL_MESSAGE,
      // 版の競合は saveDevelopSettings が `stale` で返す
      readDevelopRevisionStale: () => null,
      isExportFolderNotFound: (error) => isCode(error, "folderNotFound"),
    },

    async list(query, requestOptions) {
      if (query.folderId && query.localSource) {
        throw new CameraCommandError("invalidRequest", "写真の場所を選び直してください。");
      }
      if (query.localSource !== undefined && query.localSource !== "selected") {
        throw new CameraCommandError("invalidRequest", "写真の場所を選び直してください。");
      }
      if (!query.folderId && query.localSource !== "selected") return emptyPage();
      // お気に入り・アルバム・記事の画像（オリジナルの無い写真）はこの Mac に無い
      if (query.hasOriginal === false || query.favorite === true || query.albumId) {
        return { ...emptyPage(), counts: query.cursor ? null : { photos: 0, articleImages: 0, favorites: 0, matching: 0 } };
      }
      if (query.localSource === "selected") {
        const entries = await selectedEntries();
        throwIfAborted(requestOptions?.signal);
        return pageFromEntries(entries, query);
      }
      const folderId = query.folderId;
      if (!folderId) return emptyPage();
      const folder = await commands.listFolder(folderId);
      throwIfAborted(requestOptions?.signal);
      const all = flattenEntries(folder);
      rememberFlags(all);
      const matching = all.filter((entry) => matchesQuery(entry, query)).sort(byModifiedDesc);
      const offset = readOffset(query.cursor);
      const limit = Math.max(1, Math.min(query.limit ?? LOCAL_LIST_PAGE_SIZE, LOCAL_LIST_PAGE_SIZE));
      const page = matching.slice(offset, offset + limit);
      const end = offset + page.length;
      return {
        items: page.map((entry) => listedRow(entry, handles.get(entry.entryId))),
        next: end < matching.length ? String(end) : null,
        usage: null,
        counts: offset === 0 ? { photos: all.length, articleImages: 0, favorites: 0, matching: matching.length } : null,
      };
    },

    async get(photoId) {
      try {
        return openedRow(photoId, await reopen(photoId));
      } catch (error) {
        if (isCode(error, "notFound", "invalidRequest")) return null;
        throw error;
      }
    },

    async info(photoId, requestOptions) {
      // 開いている写真のファイルを native が都度読む（覚えない）。native が写真を手放していたら開き直して 1 回だけやり直す
      try {
        const info = await withHandle(photoId, (handle) => commands.photoInfo(handle.nativeId));
        throwIfAborted(requestOptions?.signal);
        return toPhotoInfo(info);
      } catch (error) {
        if (isCode(error, "notFound", "invalidRequest")) return null;
        throw error;
      }
    },

    async lookup(contentSha256s) {
      const wanted = new Set(contentSha256s);
      const matches: Array<{ contentSha256: string; photo: PhotoLibraryPhoto }> = [];
      for (const [entryId, handle] of handles) {
        if (wanted.has(handle.contentSha256)) {
          matches.push({ contentSha256: handle.contentSha256, photo: openedRow(entryId, handle) });
        }
      }
      return matches;
    },

    async openOriginal(photoId) {
      // 開くたびに読み直す（ほかのアプリでファイルが変わったら、中身の SHA-256 と補正も変わる）
      const handle = await reopen(photoId);
      return { source: { ref: handle.nativeId, expiresAt: null }, photo: openedRow(photoId, handle) };
    },

    async loadOriginal(photoId, _source, loadOptions) {
      const { signal, fileName, maxBytes } = loadOptions;
      throwIfAborted(signal);
      let bytes: Uint8Array;
      try {
        bytes = await withHandle(photoId, async (handle) => {
          const source = await commands.developSource(handle.nativeId);
          // native が作業コピーにした（オリジナルのまま渡せない大きさの JPEG）なら、編集面は作業コピーで開き直す
          if (source.kind !== "raster") {
            throw new BrowserPhotoSourceError(fileExtensionOf(handle.fileName) === "png" ? "fetch_failed" : "too_large");
          }
          if (source.byteLength > maxBytes) throw new BrowserPhotoSourceError("too_large");
          return commands.developSourceBytes(handle.nativeId, source.token);
        });
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof BrowserPhotoSourceError) throw error;
        throw new BrowserPhotoSourceError("fetch_failed");
      }
      throwIfAborted(signal);
      if (bytes.byteLength > maxBytes) throw new BrowserPhotoSourceError("too_large");
      const handle = handles.get(photoId);
      const extension = fileExtensionOf(handle?.fileName ?? fileName);
      const type = extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "";
      return new File([ownArrayBuffer(bytes)], fileName, type ? { type } : {});
    },

    async ensureWorkingCopy(photoId, requestOptions): Promise<PhotoLibraryWorkingCopyResult> {
      throwIfAborted(requestOptions?.signal);
      try {
        return await withHandle(photoId, async (handle) => {
          const source = await developSourceOf(handle, requestOptions?.sourceContext);
          if (source.kind !== "workingCopy") return { kind: "notApplicable" };
          return { kind: "ready", download: await workingCopyDownload(handle, source) };
        });
      } catch (error) {
        if (!(error instanceof CameraCommandError) || error.code === "notFound") throw error;
        // 同梱の sidecar が使えない（入れ直すまで直らない）
        if (error.code === "engineUnavailable") return { kind: "baseUnavailable", message: error.message };
        // この写真では作れない（macOS の RAW 現像が対応していない機種・壊れた写真など）
        if (
          [
            "unsupportedCamera",
            "decodeFailed",
            "unsupportedSource",
            "restorationUnavailable",
            "formatMismatch",
            "downloadRequired",
            "unsupportedFormat",
          ].includes(error.code)
        ) {
          return { kind: "incompatible", message: error.message };
        }
        // 時間切れ・一時的な失敗は「再試行」で作り直す（retryWorkingCopy は待ちに戻さず、編集面が ensureWorkingCopy を呼び直す）
        return { kind: "notReady", workStatus: "failed", workQueuedAt: null, lastErrorCode: error.code };
      }
    },

    async loadWorkingCopy(photoId, download, loadOptions) {
      throwIfAborted(loadOptions.signal);
      let bytes = prefetched.get(download.ref) ?? null;
      prefetched.delete(download.ref);
      let baseVersion = download.work.baseVersion;
      let meta = download.work.meta;
      if (!bytes) {
        try {
          const handle = await handleOf(photoId);
          bytes = await commands.developSourceBytes(handle.nativeId, download.ref);
        } catch (error) {
          if (!isCode(error, "notFound")) throw error;
          // 使い終えた token・閉じた写真は、現像の入力を求め直す（作業コピーはキャッシュにあれば作り直さない）
          const handle = await reopen(photoId);
          const source = await developSourceOf(handle, {
            hasSavedDevelopSettings: handle.saved !== null,
            hasDevelopEdits: true,
            baseVersion,
          });
          if (source.kind !== "workingCopy") throw new BrowserPhotoSourceError("fetch_failed");
          bytes = await commands.developSourceBytes(handle.nativeId, source.token);
          baseVersion = source.baseVersion;
          meta = source.meta;
        }
      }
      throwIfAborted(loadOptions.signal);
      return {
        photoId,
        baseVersion,
        bytes: ownArrayBuffer(bytes),
        encoding: workingCopyEncoding(bytes, meta),
        metaJson: JSON.stringify(meta),
      };
    },

    loadInteractivePreview,

    async prefetchInteractivePreview(photoId, requestOptions) {
      // Neighbor rows are not necessarily open yet. Opening them here hashes the entire RAW
      // before the user selects them, and cannot be canceled through the preview AbortSignal.
      if (!handles.has(photoId)) return;
      await loadInteractivePreviewWithPriority(photoId, requestOptions, "prefetch");
    },

    async loadProvisionalDraft(photoId, contentSha256) {
      const handle = await handleOf(photoId);
      if (handle.contentSha256 !== contentSha256) return null;
      return readProvisionalDraft(contentSha256);
    },

    async saveProvisionalDraft(photoId, contentSha256, settings) {
      const handle = await handleOf(photoId);
      if (handle.contentSha256 !== contentSha256) {
        throw new CameraCommandError("revisionConflict", "写真が更新されたため、補正を退避できませんでした。");
      }
      return writeProvisionalDraft(contentSha256, settings, now());
    },

    async removeProvisionalDraft(photoId, contentSha256, generation) {
      const handle = await handleOf(photoId);
      if (handle.contentSha256 !== contentSha256 || typeof window === "undefined") return false;
      const draft = readProvisionalDraft(contentSha256);
      if (!draft || draft.generation !== generation) return false;
      try {
        window.localStorage.removeItem(provisionalDraftKey(contentSha256));
        return true;
      } catch {
        return false;
      }
    },

    // この Mac は作り直しを ensureWorkingCopy でする（待ちの列が無い）
    retryWorkingCopy: async () => ({ kind: "notApplicable" }),

    async saveDevelopSettings(photoId, settings, saveOptions) {
      const handle = await handleOf(photoId);
      const expectedRevision = saveOptions?.expectedRevision ?? handle.saved?.revision ?? 0;
      let saved: { handle: OpenHandle; revision: number };
      try {
        saved = await withHandle(photoId, async (current) => ({
          handle: current,
          revision: await commands.saveSettings(current.nativeId, settings as Record<string, unknown>, expectedRevision),
        }));
      } catch (error) {
        if (!isCode(error, "revisionConflict")) throw error;
        // 別の操作が先に保存していた。今の補正と版で開き直す
        return { kind: "stale", photo: openedRow(photoId, await reopen(photoId)) };
      }
      saved.handle.saved = {
        developSettings: settings as Record<string, unknown>,
        revision: saved.revision,
        updatedAtMs: now().getTime(),
      };
      return { kind: "saved", photo: openedRow(photoId, saved.handle) };
    },

    async developVersions(photoId, requestOptions) {
      // 開いたときの中身の版を読む（native が写真を手放していたら、同じ中身のときだけ開き直す）
      const loaded = await withStableHandle(photoId, (handle) => commands.photoVersions(handle.nativeId));
      throwIfAborted(requestOptions?.signal);
      return readPhotoLibraryDevelopVersions(loaded);
    },

    async saveDevelopVersions(photoId, versions, saveOptions) {
      try {
        const revision = await withStableHandle(photoId, (handle) =>
          commands.savePhotoVersions(handle.nativeId, versions, saveOptions.expectedRevision),
        );
        return { kind: "saved", versions: [...versions], revision };
      } catch (error) {
        if (!isCode(error, "revisionConflict")) throw error;
        // 別の操作が先に保存していた。今の版の配列を読み直して返す
        const current = await withStableHandle(photoId, (handle) => commands.photoVersions(handle.nativeId));
        return { kind: "stale", ...readPhotoLibraryDevelopVersions(current) };
      }
    },

    // 部分補正のマスクの面（ブラシ・被写体・空。docs/local-adjustments.md「面の受け渡し」）。native は写真の中身の SHA-256 ごとに
    // 置くので、補正を保存する前でも保存できる。中身が置き換わった写真へ古い操作をやり直さない（withStableHandle）
    async saveMaskSurface(photoId, png) {
      return withStableHandle(photoId, (handle) => commands.saveMaskSurface(handle.nativeId, png));
    },

    // 被写体のマスクの面（niho-photo#135）。native が作業画像に同梱の niho-camera-cutout を当て、上と同じ面の置き場へ保存する。
    // 止めたらすぐ reject し、native の sidecar もプロセスグループごと止める（背景除去と同じ取り消しの口）
    detectMaskSurface(photoId, kind, detectOptions) {
      const { signal, developSettings } = detectOptions;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const operationId = maskDetectionOperationId();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (run: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          run();
        };
        const onAbort = () => {
          void commands.cutoutCancel(operationId).catch(() => undefined);
          finish(() => reject(abortReason(signal!)));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        void withStableHandle(photoId, (handle) => {
          if (signal?.aborted) throw abortReason(signal);
          return commands.detectMaskSurface(handle.nativeId, kind, operationId, developSettings);
        }).then(
          (surface) => finish(() => resolve({ kind: "detected", id: surface.id, width: surface.width, height: surface.height })),
          (error: unknown) =>
            finish(() => (isCode(error, "no_subjects") ? resolve({ kind: "notFound" }) : reject(error))),
        );
      });
    },

    async loadMaskSurface(photoId, surfaceId) {
      try {
        return await withStableHandle(photoId, (handle) => commands.loadMaskSurface(handle.nativeId, surfaceId));
      } catch (error) {
        // 置き場に無い・壊れていた面は「無い」（呼び出し側が面を読めないと伝える）
        if (isCode(error, "maskSurfaceMissing")) return null;
        throw error;
      }
    },

    async downloadOriginal(photo) {
      const result = await withHandle(photo.id, (handle) => commands.exportOriginal(handle.nativeId, photo.fileName));
      return result.saved
        ? { blob: nativelySaved("saved"), fileName: result.fileName }
        : { blob: nativelySaved("cancelled"), fileName: photo.fileName };
    },

    async exportNative(request) {
      const settings = request.developSettings as Record<string, unknown>;
      const context = {
        hasSavedDevelopSettings: request.hasSavedDevelopSettings,
        hasDevelopEdits: request.hasDevelopEdits,
      };
      if (request.folderId !== undefined) {
        const folderId = request.folderId;
        const fileName = await withHandle(request.photoId, (handle) =>
          commands.exportToFolder(folderId, handle.nativeId, settings, context, request.suggestedFileName),
        );
        return { saved: true, fileName };
      }
      const result = await withHandle(request.photoId, (handle) =>
        commands.exportPhoto(handle.nativeId, settings, context, request.suggestedFileName),
      );
      return result.saved ? { saved: true, fileName: result.fileName } : { saved: false, fileName: null };
    },

    chooseExportFolder: async () => (await commands.chooseExportFolder())?.exportFolderId ?? null,

    withStablePhoto: (photoKey, run) => withStableHandle(photoKey, (handle) => run(handle.nativeId)),

    // この Mac の写真は消さない（編集面は置き場が local のとき消す道具を出さない）
    delete: async () => ({ deleted: [], errors: [] }),

    folders: {
      tree: async () => (await commands.remembered()).folders.map(folderTree),
      add: async () => {
        const added = await commands.addFolder();
        return added ? folderTree(added) : null;
      },
      forget: (folderId) => commands.forgetFolder(folderId),
    },

    selectedPhotos: {
      async count(requestOptions) {
        const entries = await selectedEntries();
        throwIfAborted(requestOptions?.signal);
        return entries.length;
      },
      async add() {
        const entries = await commands.addPhotos();
        rememberFlags(entries);
        return entries.map((entry) => listedRow(entry, handles.get(entry.entryId)));
      },
      forget: () => commands.forgetPhotos(),
    },

    // 選別のフラグ（niho-photo#47）。native が一覧の写真の名前・大きさ・更新日時で覚える。無い写真は `notFound`
    flags: {
      async set(photoIds, flag) {
        const entryIds = [...new Set(photoIds)];
        if (entryIds.length === 0) return { updated: 0, skipped: { notFound: 0, noOriginal: 0 } };
        const result = await commands.setFlags(entryIds, flag);
        const updated = Array.isArray(result.updated) ? result.updated : [];
        const notFound = Array.isArray(result.notFound) ? result.notFound : [];
        for (const entryId of updated) knownFlags.set(entryId, flag);
        return { updated: updated.length, skipped: { notFound: notFound.length, noOriginal: 0 } };
      },
    },

    presets: {
      list: () => commands.listPresets(),
      create: ({ name, xmp, source }) => commands.createPreset(name, xmp, source ?? "xmp"),
      rename: (presetId, name) => commands.renamePreset(presetId, name),
      delete: (presetId) => commands.deletePreset(presetId),
      nameMaxChars: LOCAL_PRESET_NAME_MAX_CHARS,
      xmpMaxBytes: LOCAL_PRESET_XMP_MAX_BYTES,
      describeError: describe,
      isNameTaken: (error) => isCode(error, "presetNameTaken"),
    },
  };
  return library;
}
