import {
  DEVELOP_ENGINE_NEWER_LOCKED_MESSAGE,
  DEVELOP_ENGINE_BASE_MISMATCH_LOCKED_MESSAGE,
  DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE,
  browserCanvasLockedReason,
  findBrowserCloudViewUrl,
  type BrowserCloudPhotoSource,
} from "../browser-photo-cloud-source";
import {
  browserCloudOriginalMaxBytes,
  decodeBrowserPhoto,
  inspectBrowserPhotoFile,
} from "../browser-photo-source";
import type { DevelopEngine, DevelopFrame } from "../develop-engine/develop-engine-client";
import { resolveDevelopOpenSettings } from "../develop-engine/develop-open-settings";
import {
  browserEditingDevelopSettings,
  hasDevelopGeometry,
  neutralDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import type { DevelopSettingsSaver } from "../develop-engine/develop-settings-autosave";
import {
  copyDevelopWorkingCopyInput,
  developWorkingCopyInputOf,
  openDevelopWorkingCopy,
} from "../develop-engine/develop-render-input";
import type {
  PhotoLibrary,
  PhotoLibraryPhoto,
  PhotoLibraryWorkingCopy,
  PhotoLibraryWorkingCopyDownload,
  PhotoLibraryWorkingCopyResult,
} from "../library/photo-library";
import { workWaitOf } from "../develop-engine/develop-work-wait";
import { readDevelopSize } from "../photo-editing-crop";

import {
  DEVELOP_GEOMETRY_WORKING_CAP,
  DEVELOP_PREVIEW_MAX_DIMENSION,
  developBaseVersion,
  type BrowserItem,
  type DevelopOriginalWorking,
  type DevelopSession,
  type DevelopSourceInput,
  type OpenResult,
  type OpenSettings,
  type WorkOutcome,
} from "./browser-photo-editing-model";

/**
 * 1 枚を開く流れのうち、入力を読んで段 2 の wasm（か S1 の canvas・閲覧だけ）で開くところ（移行元設計 / 移行元設計。移行元設計 で面から
 * 分けた）。画面の状態には触らず結果（{@link OpenResult}）を返す。呼ぶ側は、呼んだ時点の最新の拠点・権限を `context` で渡す。
 */
export type BrowserPhotoOpenFlowContext = {
  spotId: string;
  /** 写真の出どころ（作業コピーと、開いた写真の今の行を読む） */
  library: Pick<PhotoLibrary, "openOriginal" | "loadWorkingCopy" | "readArticleImage">;
  /** 開き終えた時点の権限（保存係を作るか） */
  canEdit: () => boolean;
  /** 保存係（`developRevision` は直し始めた版＝開いた写真の今の行の版。保存のたびに照合する。移行元設計） */
  createSaver: (
    spotId: string,
    photoId: string,
    developRevision: number,
    contentSha256?: string,
    provisionalGeneration?: number,
  ) => DevelopSettingsSaver | null;
  /** wasm で開いた 1 枚目の丁寧な画を覚え、「補正前」の画を捨てる */
  rememberOpenedFrame: (key: string, settings: DevelopSettings, frame: DevelopFrame | null) => void;
};

/** 開けたが閲覧だけにする写真（記事用の画像、無ければプレビューを見せて理由を 1 行）。 */
async function lockedDevelopView(
  context: BrowserPhotoOpenFlowContext,
  item: BrowserItem,
  cloudPhoto: Pick<PhotoLibraryPhoto, "hasWebImage">,
  lockedReason: string,
  loadedForEditing: boolean,
  signal: AbortSignal,
): Promise<OpenResult> {
  const viewUrl = await findBrowserCloudViewUrl(
    context.library,
    { ...item.photo, ...cloudPhoto, previewUrl: item.photo.previewUrl },
    signal,
  );
  return {
    opened: {
      key: item.key,
      fileName: item.photo.fileName,
      decoded: null,
      viewUrl,
      lockedReason,
      loadedForEditing,
      mode: null,
      input: null,
      work: null,
      photo: null,
    },
    session: null,
    settings: neutralDevelopSettings(),
  };
}

/**
 * 開くときに使う補正。補正は写真に 1 つで、置き場は `developSettings` の 1 つ（K1c 移行元設計。旧エンジン（Photo Bench）の `settings`
 * は読まない）: 保存してあればそれ（新しい版の NIHO で保存した写真は閉じる）、保存したことが無ければ補正なし。作業コピーの上で
 * 直す写真（`baseVersion`。移行元設計）は、保存済み `base` と同じ版だけを開く（未保存ならその版で初期化し、開いただけでは保存しない）。
 */
function resolveOpenSettings(cloudPhoto: PhotoLibraryPhoto, baseVersion: string | null, workMeta?: unknown): OpenSettings {
  const resolved = resolveDevelopOpenSettings({ cloudPhoto, baseVersion, workMeta });
  if (resolved.kind === "newer") return { kind: "locked", lockedReason: DEVELOP_ENGINE_NEWER_LOCKED_MESSAGE };
  if (resolved.kind === "baseMismatch") {
    return { kind: "locked", lockedReason: DEVELOP_ENGINE_BASE_MISMATCH_LOCKED_MESSAGE };
  }
  return resolved;
}

/**
 * 開いている写真を、今の写真（別の端末が保存した補正と版。移行元設計 上書き防止）で開き直すときの補正。開くときと同じ
 * {@link resolveOpenSettings} で決め（作業コピーの上で直す写真は、今の入力の `baseVersion` を渡すのも同じ）、入力と wasm の写真は
 * 今のものを使う。補正は今の写真の `developSettings` だけで決まる（K1c 移行元設計。読み足すものは無い）。閲覧だけになる（新しい版の
 * NIHO で保存された）なら `locked`（呼ぶ側が開き直しの経路に任せる）。
 */
export function resolveReloadSettings(
  cloudPhoto: PhotoLibraryPhoto,
  input: DevelopSourceInput,
): { kind: "settings"; settings: DevelopSettings; settingsSource: DevelopSession["settingsSource"] } | { kind: "locked" } {
  let workMeta: unknown;
  if (input.kind === "workingCopy") {
    try {
      workMeta = JSON.parse(input.metaJson) as unknown;
    } catch {
      return { kind: "locked" };
    }
  }
  const resolved = resolveOpenSettings(cloudPhoto, developBaseVersion(input), workMeta);
  if (resolved.kind === "locked") return { kind: "locked" };
  return {
    kind: "settings",
    settings: browserEditingDevelopSettings(resolved.baseSettings),
    settingsSource: resolved.settingsSource,
  };
}

/**
 * オリジナル（JPEG / 小さな PNG）を wasm に開く作業サイズ（F3 移行元設計）。恒等でない幾何（切り抜き・回転）があり、幾何の口が wasm に
 * 揃っていれば（`supportsGeometry`。crate 0.5.0 から）、切り抜いてもプレビューが {@link DEVELOP_PREVIEW_MAX_DIMENSION} に届く長辺
 * （`imageSize` → `rasterDecodeSize`。上限 {@link DEVELOP_GEOMETRY_WORKING_CAP}）。幾何が無い・wasm が古いときは今までどおり
 * {@link DEVELOP_PREVIEW_MAX_DIMENSION}（新しい口は呼ばない。古い wasm は幾何のある設定を描かずに拒む）。`bytes` は手放さない。
 */
async function resolveOriginalWorking(
  engine: Pick<DevelopEngine, "supportsGeometry" | "imageSize" | "rasterDecodeSize">,
  bytes: ArrayBuffer,
  settings: DevelopSettings,
): Promise<DevelopOriginalWorking> {
  if (!hasDevelopGeometry(settings) || !(await engine.supportsGeometry())) {
    return { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, originalSize: null };
  }
  const originalSize = await engine.imageSize(bytes);
  const maxDimension = await engine.rasterDecodeSize(
    settings,
    originalSize,
    DEVELOP_PREVIEW_MAX_DIMENSION,
    DEVELOP_GEOMETRY_WORKING_CAP,
  );
  return { maxDimension, originalSize };
}

/**
 * 開いている写真の wasm の作業サイズが、この編集内容の切り抜きに足りなければ、同じオリジナルを要る大きさで開き直す（F3 移行元設計。
 * 別の端末の補正を読み直したとき・切り抜きを確定したときに呼ぶ）。
 *
 * - `kept`: 今のままで足りる（幾何が無い・作業コピー〔原寸のまま持つ〕・wasm が古い・要る大きさが今以下）
 * - `reopened`: 開き直した（`session.working` を書き換えた。覚えている画は呼ぶ側が捨てて描き直す）
 * - `stale`: 途中で別の写真に替わった（開き直していない）
 * - `failed`: 寸法を読めない・開き直せなかった（wasm が写真を手放しているかもしれないので、呼ぶ側が今の開き直しの経路で開き直す）
 */
export async function ensureOriginalWorkingSize(
  engine: Pick<DevelopEngine, "supportsGeometry" | "imageSize" | "rasterDecodeSize" | "open">,
  session: Pick<DevelopSession, "input" | "working">,
  settings: DevelopSettings,
  isStale: () => boolean,
): Promise<"kept" | "reopened" | "stale" | "failed"> {
  const input = session.input;
  const working = session.working;
  // 幾何が無ければプレビューの大きさで足りる（開いた作業サイズはそれ以上）
  if (input.kind !== "original" || !working || !hasDevelopGeometry(settings)) return "kept";
  try {
    const supported = await engine.supportsGeometry();
    if (isStale()) return "stale";
    if (!supported) return "kept";
    let bytes: ArrayBuffer | null = null;
    let originalSize = working.originalSize;
    if (!originalSize) {
      bytes = await input.file.arrayBuffer();
      originalSize = await engine.imageSize(bytes);
      if (isStale()) return "stale";
      working.originalSize = originalSize;
    }
    const needed = await engine.rasterDecodeSize(
      settings,
      originalSize,
      DEVELOP_PREVIEW_MAX_DIMENSION,
      DEVELOP_GEOMETRY_WORKING_CAP,
    );
    if (isStale()) return "stale";
    if (needed <= working.maxDimension) return "kept";
    if (!bytes) {
      bytes = await input.file.arrayBuffer();
      if (isStale()) return "stale";
    }
    await engine.open(bytes, needed);
    working.maxDimension = needed;
    return "reopened";
  } catch {
    return isStale() ? "stale" : "failed";
  }
}

/** wasm で開いた写真（最初の Final 描画は画面側で行う。閲覧のみの operator は保存係を作らない）。 */
function developedOpenResult(
  context: BrowserPhotoOpenFlowContext,
  params: {
    item: BrowserItem;
    input: DevelopSourceInput;
    /** オリジナルを開いた作業サイズ（作業コピーは null） */
    working: DevelopOriginalWorking | null;
    /** 作業コピーを開いた大きさ（オリジナル・読めなかったときは null） */
    workSize: { width: number; height: number } | null;
    cloudPhoto: PhotoLibraryPhoto;
    resolved: Extract<OpenSettings, { kind: "settings" }>;
    /** 開いたときの編集内容（最初の Final 描画に使う設定。スライダーはここから始める） */
    settings: DevelopSettings;
    viewUrl: string | null;
  },
): OpenResult {
  const { item, input, cloudPhoto, resolved, settings } = params;
  // downloadPhoto は署名 URL を返さない。一覧の URL は、読み直した行と版が一致するときだけ再利用する。
  const listedPreview = item.photo.editedPreview;
  const currentPreviewUrl = listedPreview?.url &&
    listedPreview.revision === cloudPhoto.developRevision &&
    item.photo.developRevision === cloudPhoto.developRevision &&
    cloudPhoto.editedPreview?.revision === cloudPhoto.developRevision
    ? listedPreview.url
    : null;
  context.rememberOpenedFrame(item.key, settings, null);
  const spotId = context.spotId;
  return {
    opened: {
      key: item.key,
      fileName: item.photo.fileName,
      decoded: null,
      viewUrl: currentPreviewUrl ?? params.viewUrl,
      previewPending: true,
      previewCurrent: currentPreviewUrl !== null,
      lockedReason: null,
      loadedForEditing: true,
      mode: "wasm",
      input,
      work: null,
      photo: cloudPhoto,
    },
    session: {
      key: item.key,
      photoId: item.photo.id,
      spotId,
      input,
      working: params.working,
      workSize: params.workSize,
      photo: cloudPhoto,
      settingsSource: resolved.settingsSource,
      saver: context.canEdit()
        ? context.createSaver(spotId, item.photo.id, cloudPhoto.developRevision, cloudPhoto.contentSha256)
        : null,
    },
    settings,
  };
}

/**
 * 補正の入力（オリジナル）を段 2 の wasm で開く（移行元設計）。補正は {@link resolveOpenSettings} で決め、
 * Final 1280 は画面の paint effect で非同期に描く。切り抜きのある写真は、切り抜いてもプレビューの大きさに届く作業サイズで開く（{@link resolveOriginalWorking}）。
 * wasm で開けなければ null（呼び出し側が S1 の canvas か閲覧のみにする）。古くなった（別の写真を開いた）ら `stale`。
 * 開いただけでは保存しない。上限を超えるオリジナルは `too_large` を投げる（JPEG なら呼び出し側が作業コピーで開き直す。K5-a 移行元設計）。
 */
async function openDevelopSource(
  context: BrowserPhotoOpenFlowContext,
  item: BrowserItem,
  file: File,
  viewUrl: string | null,
  cloudPhoto: PhotoLibraryPhoto,
  engine: DevelopEngine,
  signal: AbortSignal,
  isStale: () => boolean,
): Promise<OpenResult | "stale" | null> {
  // 上限（JPEG は 64MiB・PNG は 10MiB、4,000 万画素）はヘッダで確かめる（デコードは wasm がする）
  await inspectBrowserPhotoFile(file, { maxBytes: browserCloudOriginalMaxBytes(item.photo.fileExtension) });
  if (isStale()) return "stale";
  const resolved = resolveOpenSettings(cloudPhoto, null);
  if (resolved.kind === "locked") {
    const locked = await lockedDevelopView(context, item, cloudPhoto, resolved.lockedReason, true, signal);
    return isStale() ? "stale" : locked;
  }
  const settings = browserEditingDevelopSettings(resolved.baseSettings);
  let working: DevelopOriginalWorking;
  try {
    const bytes = await file.arrayBuffer();
    working = await resolveOriginalWorking(engine, bytes, settings);
    if (isStale()) return "stale";
    await engine.open(bytes, working.maxDimension);
    if (isStale()) return "stale";
  } catch {
    return null;
  }
  if (isStale()) return "stale";
  return developedOpenResult(context, {
    item,
    input: { kind: "original", file },
    working,
    workSize: null,
    cloudPhoto,
    resolved,
    settings,
    viewUrl: cloudPhoto.editedPreview?.url ?? viewUrl,
  });
}

/**
 * 作業コピー（移行元設計）を段 2 の wasm で開く。最新の写真の行と、作業コピー（Cache Storage にあればそれ、無ければ
 * GCS）を読み、{@link resolveOpenSettings} の補正で開く。最初の Final 1280 は画面の paint effect に任せる。16bit PNG は `openWorkingCopy`、ICC 付きの
 * 8bit JPEG（K5 移行元設計）は JPEG のオリジナルと同じ入口で原寸のまま開く（{@link openDevelopWorkingCopy}。どちらも補正の `base` は
 * 作業コピーの版）。新しい版の NIHO で保存した補正は閉じる。wasm で開けなければ null。古くなったら `stale`。開いただけでは保存しない。
 */
async function openWorkingCopySource(
  context: BrowserPhotoOpenFlowContext,
  item: BrowserItem,
  download: PhotoLibraryWorkingCopyDownload,
  engine: DevelopEngine,
  signal: AbortSignal,
  isStale: () => boolean,
  prefetchedCopy?: Promise<PhotoLibraryWorkingCopy>,
): Promise<OpenResult | "stale" | null> {
  const baseVersion = download.work.baseVersion;
  const [latest, copy] = await Promise.all([
    context.library.openOriginal(item.photo.id, { signal }),
    prefetchedCopy ?? context.library.loadWorkingCopy(item.photo.id, download, { signal }),
  ]);
  if (isStale()) return "stale";
  const cloudPhoto = latest.photo;
  const resolved = resolveOpenSettings(cloudPhoto, baseVersion, download.work.meta);
  if (resolved.kind === "locked") {
    const locked = await lockedDevelopView(context, item, cloudPhoto, resolved.lockedReason, true, signal);
    return isStale() ? "stale" : locked;
  }
  const settings = browserEditingDevelopSettings(resolved.baseSettings);
  const input: DevelopSourceInput = developWorkingCopyInputOf(copy);
  let workSize: { width: number; height: number } | null;
  try {
    // 持っておく作業コピーは画面が持ち、Worker にはコピーを渡す
    workSize = readDevelopSize(await openDevelopWorkingCopy(engine, copyDevelopWorkingCopyInput(input)));
    if (isStale()) return "stale";
  } catch {
    return null;
  }
  if (isStale()) return "stale";
  return developedOpenResult(context, {
    item,
    input,
    working: null,
    workSize,
    cloudPhoto,
    resolved,
    settings,
    viewUrl: cloudPhoto.editedPreview?.url ?? item.photo.previewUrl ?? item.localPreviewUrl,
  });
}

/**
 * `work/download` の結果から次の状態を決める（移行元設計）。揃っていれば作業コピーを wasm で開いた結果、まだなら待つ状態、作業コピーを
 * 作らない写真・wasm で開けなかった写真は S1 と同じ閉じた結果（理由と次の一歩を 1 行）。
 */
export async function resolveWorkOutcome(
  context: BrowserPhotoOpenFlowContext,
  item: BrowserItem,
  result: PhotoLibraryWorkingCopyResult,
  engine: DevelopEngine,
  signal: AbortSignal,
  isStale: () => boolean,
  prefetchedCopy?: Promise<PhotoLibraryWorkingCopy>,
): Promise<WorkOutcome | "stale"> {
  if (result.kind === "notReady") return { kind: "wait", work: workWaitOf(result) };
  if (result.kind === "incompatible" || result.kind === "baseUnavailable") {
    const locked = await lockedDevelopView(context, item, item.photo, result.message, true, signal);
    return isStale() ? "stale" : { kind: "opened", result: locked };
  }
  if (result.kind === "ready") {
    const opened = await openWorkingCopySource(context, item, result.download, engine, signal, isStale, prefetchedCopy);
    if (opened === "stale" || isStale()) return "stale";
    if (opened) return { kind: "opened", result: opened };
  }
  // 作業コピーを作らない・wasm で開けなかった写真は閲覧だけ（準備ができなかった）
  const locked = await lockedDevelopView(context, item, item.photo, DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE, true, signal);
  return isStale() ? "stale" : { kind: "opened", result: locked };
}

/**
 * 補正の入力を、wasm（使えれば）か S1 の canvas で開く。wasm を使える（`engine`）のに開けなかったときは、canvas で描けるのは
 * 補正が neutral（か、保存したことが無い）写真だけ（ほかは補正を外して見せないよう閲覧だけ。wasm を使えないときは入力を読む前に閉じている）。
 */
export async function openEditableSource(
  context: BrowserPhotoOpenFlowContext,
  item: BrowserItem,
  source: BrowserCloudPhotoSource,
  allowEditing: boolean,
  engine: DevelopEngine | null,
  signal: AbortSignal,
  isStale: () => boolean,
): Promise<OpenResult | null> {
  const file = source.file;
  const cloudPhoto = source.photo ?? null;
  if (file && cloudPhoto && engine) {
    const developed = await openDevelopSource(context, item, file, source.viewUrl, cloudPhoto, engine, signal, isStale);
    if (developed === "stale") return null;
    if (developed) return developed;
    const lockedReason = browserCanvasLockedReason(cloudPhoto);
    if (lockedReason) {
      const locked = await lockedDevelopView(context, item, cloudPhoto, lockedReason, allowEditing, signal);
      return isStale() ? null : locked;
    }
  }
  const decoded = file
    ? await decodeBrowserPhoto(file, { maxBytes: browserCloudOriginalMaxBytes(item.photo.fileExtension) })
    : null;
  if (isStale()) {
    decoded?.cleanup();
    return null;
  }
  return {
    opened: {
      key: item.key,
      fileName: item.photo.fileName,
      decoded,
      viewUrl: source.viewUrl,
      lockedReason: source.lockedReason,
      loadedForEditing: allowEditing,
      mode: decoded ? "canvas" : null,
      input: null,
      work: null,
      photo: null,
    },
    session: null,
    settings: neutralDevelopSettings(),
  };
}
