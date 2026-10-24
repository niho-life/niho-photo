"use client";

import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { fetchBrowserCloudWebImageJpeg, isBrowserCloudRawPhoto } from "../browser-photo-cloud-source";
import {
  BROWSER_PHOTO_CUTOUT_RENDER_JPEG_QUALITY,
  BrowserPhotoCutoutExportError,
  composeBrowserPhotoCutoutRgba,
  decodeBrowserPhotoJpegRgba,
  encodeBrowserPhotoRgba,
  type BrowserPhotoCutoutExport,
  type BrowserPhotoCutoutExportFormat,
} from "../browser-photo-cutout-export";
import {
  browserPhotoExportJpegFileName,
  browserPhotoExportPngFileName,
  isDesktopFullSizeSource,
  type BrowserPhotoExportFormat,
  type BrowserPhotoExportJpegRoute,
  type BrowserPhotoExportSize,
  type BrowserPhotoExportSizeOption,
} from "../browser-photo-export";
import {
  BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES,
  browserPhotoBatchArchiveFileName,
  browserPhotoBatchArchiveNames,
  browserPhotoBatchFailureNames,
  resolveBrowserPhotoBatchExportLimit,
  type BrowserPhotoBatchExportTarget,
} from "../browser-photo-batch-export";
import { createBrowserPhotoExportZip, type BrowserPhotoZipEntry } from "../browser-photo-export-zip";
import {
  renderBrowserPhotoExportJpeg,
  withCaptureExifOrPlain,
  type BrowserPhotoExportRendered,
} from "../browser-photo-export-render";
import { BrowserPhotoSourceError, exportBrowserPhotoJpeg } from "../browser-photo-source";
import { DEVELOP_WEB_IMAGE_JPEG_QUALITY, loadPhotoLibraryRenderInput } from "../develop-engine/develop-render-input";
import {
  DEVELOP_SETTINGS_ENGINE,
  NIHO10_DEVELOP_SETTINGS_ENGINE,
  NIHO12_DEVELOP_SETTINGS_ENGINE,
  NIHO13_DEVELOP_SETTINGS_ENGINE,
  NIHO2_DEVELOP_SETTINGS_ENGINE,
  developSettingsKey,
  developSettingsOnWorkingCopy,
  hasSavedDevelopSettings,
  isNeutralDevelopSettings,
  isEditableDevelopSettings,
  neutralDevelopSettings,
  readBrowserAdjustmentsFromDevelopSettings,
  readDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import { hasPhotoEditingColorGradingNativeExportUnsupportedLuminance } from "../photo-editing-color-grading";
import { workExportWaitingText } from "../develop-engine/develop-work-wait";
import { cutoutFailureCode } from "../photo-cutout";
import { isPhotoCloudSignedRecipeEligible } from "../photo-cloud-signed-eligibility";
import {
  PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_FAILED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_FAILED_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_UPDATE_TEXT,
  PHOTO_EDITING_EXPORT_NEWER_TEXT,
  PHOTO_EDITING_EXPORT_PNG_FAILED_TEXT,
  photoEditingExportFailedCountText,
  photoEditingExportNarrowNote,
  photoEditingFolderExportStoppedText,
  photoEditingSavedText,
} from "../photo-editing-copy";
import {
  describePhotoCloudDeleteSummary,
  describePhotoEditingBatchExportSummary,
} from "../photo-library-messages";
import {
  runPhotoEditingBatchExport,
  runPhotoEditingBatchSequence,
  type PhotoEditingBatchExportFailure,
} from "../photo-editing-batch-export";
import {
  photoSaveActionLabel,
  PHOTO_SAVE_MAX_FILES,
  photoSaveEnv,
  savePhotosToDevice,
  type PhotoSaveOutcome,
  type PhotoSaveRoute,
} from "../save-photos-to-device";
import { readPhotoCloudDeleteArticleUsage } from "../use-photo-cloud-photos";
import { appDialog } from "niho-ui/app-dialog";
import type { PhotoLibrary, PhotoLibraryCapabilities, PhotoLibraryErrors } from "../library/photo-library";
import {
  usePhotoEditingHost,
  usePhotoLibrary,
  type PhotoEditingSaveFileResult,
} from "../library/photo-library-context";

import {
  copyDevelopInput,
  describeDeleteConfirm,
  describeExportFailure,
  type BrowserItem,
  type BrowserPhotoAccess,
  type BrowserPhotoOperation,
  type BrowserPhotoOperationKind,
  type BrowserViewMode,
  type FooterStatus,
} from "./browser-photo-editing-model";
import type { BrowserPhotoDevelop } from "./use-browser-photo-develop";
import type { BrowserPhotoItems } from "./use-browser-photo-items";
import type { BrowserPhotoOpen } from "./use-browser-photo-open";

/**
 * 書き出しの結果。スマホのシート（F6c 移行元設計）が、閉じるか・同じボタンをもう一度押してもらうかを決めるのに使う（PC は見ない）。
 * `done` は保存した（状態欄に出した）、`cancelled` は保存先・共有シートで何も選ばなかった、`needs-tap` は描き終えたが共有シートを
 * 出せなかった（{@link useBrowserPhotoExportAndDelete} の `pendingShare`）、`failed` は失敗を状態欄に出した、`skipped` は何もしなかった。
 */
export type BrowserPhotoExportResult = "done" | "cancelled" | "needs-tap" | "failed" | "skipped";
export type BrowserPhotoBatchExportResult = BrowserPhotoExportResult | "stopped";

/** 描き終えて、共有シートを出すのを待っている写真（ユーザーの操作の中でしか出せない）。 */
type PendingPhotoShare = {
  /** 写真の key（複数は選択順に連結。写真を替えたら捨てる） */
  key: string;
  fileName: string;
  files: File[];
  route: PhotoSaveRoute;
  /** S1 の canvas で書き出した編集内容（保存できたら、離れる前の破棄の確認で数えない） */
  exportedSettingsKey: string | null;
  /** 幅 1080px に届かなかった写真の幅（保存した 1 行の後ろに足す。届いた・選んでいないなら null） */
  narrowWidth: number | null;
};

/** 状態欄の 1 行の後ろに足す、幅 1080px に届かなかった写真の幅（F7b 移行元設計）。 */
function narrowNote(narrowWidth: number | null): string {
  return narrowWidth === null ? "" : photoEditingExportNarrowNote(narrowWidth);
}

/**
 * フォルダへ書き出せなかった理由の 1 行（K2-3b 移行元設計）。native の道具の失敗（フォルダの選択など）は写真の出どころが決めた文
 * （クラウドは NIHO Desktop の文）、ほかは 1 枚の書き出しと同じ（原寸の書き出しの 1 行・新しい版の NIHO の補正・API の失敗）。
 */
function describeFolderExportFailure(error: unknown, errors: PhotoLibraryErrors): string {
  if (errors.isNativeError(error)) return errors.describeNative(error);
  return describeExportFailure(error, "jpeg", errors);
}

/** フォルダへ書き出せなかった写真の知らせの本文（1 枚 1 行で「<名前>: <理由>」。旧い Desktop の面の失敗の行と同じ形）。 */
function folderExportFailureLines(failures: readonly PhotoEditingBatchExportFailure[], errors: PhotoLibraryErrors): ReactNode {
  return createElement(
    Fragment,
    null,
    ...failures.map((failure) =>
      createElement("span", { className: "block break-all" }, `${failure.fileName}: ${describeFolderExportFailure(failure.error, errors)}`),
    ),
  );
}

/**
 * 書き出す（JPEG / オリジナル。移行元設計）とクラウドから消す（移行元設計）。どちらも選んでいる 1 枚が対象で、している間は
 * `operation` でほかの操作を止める。
 */
export function useBrowserPhotoExportAndDelete(params: {
  spotId: string;
  canEdit: boolean;
  mountedRef: MutableRefObject<boolean>;
  latestAccessRef: MutableRefObject<BrowserPhotoAccess>;
  selectedItem: BrowserItem | null;
  /** 一覧で選んでいる複数枚（選択した順）。1 枚書き出しは `selectedItem` を使う。 */
  selectedItems?: readonly BrowserItem[];
  /** 受け付けた非同期プリセット操作は、書き出しによる編集ロックの前に確定する。 */
  pendingEdits?: { hasPending: () => boolean; waitForPending: () => Promise<void> };
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  setOperation: (operation: BrowserPhotoOperation | null) => void;
  saveGenerationRef: MutableRefObject<number>;
  viewModeRef: MutableRefObject<BrowserViewMode>;
  setViewMode: (viewMode: BrowserViewMode) => void;
  setExportSheetOpen: (open: boolean) => void;
  setStatus: (status: FooterStatus | null) => void;
  removeCloudPhotos: (photoIds: readonly string[]) => void;
  develop: Pick<BrowserPhotoDevelop, "engineRef" | "developSessionRef" | "releaseDevelopSession" | "readyDevelopEngine">;
  open: Pick<
    BrowserPhotoOpen,
    | "openedRef"
    | "openingKeyRef"
    | "settingsRef"
    | "setSavedSettingsKey"
    | "setSourceError"
    | "abortOpening"
    | "clearOpened"
  >;
  items: Pick<BrowserPhotoItems, "deepLinkedPhoto" | "setDeepLinkedPhoto" | "setSelectedKey" | "removeAddedPhoto">;
  /**
   * 写真の出どころのできること（K2 移行元設計）。原寸の書き出し（経路 `native`。K2-3a。`nativeExport`・更新が要る版は
   * `nativeExportUpdateRequired`）と、複数枚のフォルダへの書き出し（フォルダの選択も。K2-3b。`exportFolder`）に使う
   */
  capabilities: PhotoLibraryCapabilities;
}) {
  const {
    spotId,
    canEdit,
    mountedRef,
    latestAccessRef,
    selectedItem,
    operationRef,
    setOperation,
    saveGenerationRef,
    viewModeRef,
    setViewMode,
    setExportSheetOpen,
    setStatus,
  } = params;
  const { engineRef, developSessionRef, releaseDevelopSession, readyDevelopEngine } = params.develop;
  const { openedRef, openingKeyRef, settingsRef, setSavedSettingsKey } = params.open;
  // 写真の出どころ（接続口 PhotoLibrary）とアプリの都合（端末への保存。移行元設計）
  const library = usePhotoLibrary();
  const host = usePhotoEditingHost();
  const exportAbortRef = useRef<AbortController | null>(null);
  const batchStopRef = useRef<AbortController | null>(null);
  const [batchStopping, setBatchStopping] = useState(false);
  const [batchFinalizing, setBatchFinalizing] = useState(false);
  const deleteConfirmingRef = useRef(false);
  // スマホの「書き出す」（F6c 移行元設計）: 描き終えたが共有シートを出せなかった写真。同じボタンをもう一度押したときに出す
  const [pendingShare, setPendingShareState] = useState<PendingPhotoShare | null>(null);
  const pendingShareRef = useRef<PendingPhotoShare | null>(null);
  const setPendingShare = useCallback((next: PendingPhotoShare | null) => {
    pendingShareRef.current = next;
    setPendingShareState(next);
  }, []);
  const clearPendingShare = useCallback(() => {
    if (pendingShareRef.current) setPendingShare(null);
  }, [setPendingShare]);

  // 写真・複数選択の順を替えたら、待っていた写真は捨てる
  const selectedKey = (params.selectedItems ?? (selectedItem ? [selectedItem] : [])).map((item) => item.key).join("\u001f") || null;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const settleAcceptedEdits = async (): Promise<boolean> => {
    const key = selectedKeyRef.current;
    await params.pendingEdits?.waitForPending();
    return mountedRef.current && latestAccessRef.current.spotId === spotId && selectedKeyRef.current === key && !operationRef.current;
  };
  useEffect(() => {
    if (pendingShareRef.current && pendingShareRef.current.key !== selectedKey) setPendingShare(null);
  }, [selectedKey, setPendingShare]);

  useEffect(
    () => () => {
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
      batchStopRef.current?.abort();
      batchStopRef.current = null;
    },
    [],
  );

  /** 共有シート・端末の保存の結果を画面に出す（保存したら状態欄に 1 行。やめたときは何も出さない）。 */
  const finishPhotoSave = (outcome: PhotoSaveOutcome, share: PendingPhotoShare): BrowserPhotoExportResult => {
    if (outcome.kind === "needs-tap") {
      setPendingShare(share);
      return "needs-tap";
    }
    if (outcome.kind === "cancelled") return "cancelled";
    setPendingShare(null);
    if (share.exportedSettingsKey !== null) setSavedSettingsKey(share.exportedSettingsKey);
    const savedCount = outcome.kind === "saved" ? outcome.saved : share.files.length;
    const savedCountText =
      share.files.length > 1
        ? savedCount < share.files.length
          ? `${share.files.length}枚中${savedCount}枚を`
          : `${share.files.length}枚を`
        : "";
    setStatus({
      kind: "notice",
      text: `${savedCountText}${photoEditingSavedText(photoSaveActionLabel(share.route))}${narrowNote(share.narrowWidth)}`,
    });
    return "done";
  };

  /** provisional は書き出しへ渡さず、同じ写真の atomic canonical handoff を待つ。 */
  const waitForCanonical = async (target: BrowserItem, signal: AbortSignal): Promise<void> => {
    let announced = false;
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const current = openedRef.current;
      if (current?.key !== target.key || current.input?.kind !== "provisional") {
        if (announced) setStatus(null);
        return;
      }
      if (!current.canonicalPending) {
        throw new Error("高画質表示を準備できませんでした。もう一度読み込んでください。");
      }
      if (!announced) {
        announced = true;
        setStatus({ kind: "notice", text: "高画質表示を準備中です。補正を保ったまま書き出しを待っています。" });
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        const timer = window.setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 50);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  };

  /**
   * JPEG を段 2 の wasm で入力から描く（F7b 移行元設計。経路 `engine`）。1 枚で wasm で開いている写真は、持っている入力のコピーと今の
   * 補正で描く。一覧で選んだだけの写真は、最新の行を読み直して保存してある補正（無ければ補正なし）で、入力（オリジナルか作業コピー。
   * {@link loadPhotoLibraryRenderInput}）から描く（記事制作の「描いてから使う」と同じ流れ）。どちらも
   * 開いている写真（wasm が持っている写真）は変えない。撮影日時は最新の行（無ければ一覧の行）の `capturedAt`。
   */
  const renderEngineJpeg = async (
    target: BrowserItem,
    size: BrowserPhotoExportSize,
    signal: AbortSignal,
  ): Promise<BrowserPhotoExportRendered | null> => {
    await waitForCanonical(target, signal);
    const current = openedRef.current;
    const loupeEngine = engineRef.current;
    if (viewModeRef.current === "loupe" && current?.key === target.key && current.mode === "wasm" && current.input && loupeEngine) {
      return renderBrowserPhotoExportJpeg({
        engine: loupeEngine,
        input: await copyDevelopInput(current.input),
        settings: settingsRef.current,
        size,
        capturedAt: current.photo?.capturedAt ?? target.photo.capturedAt ?? null,
      });
    }
    const engine = await readyDevelopEngine();
    // 段 2 の wasm を用意できなかった（試すまで分からない）。呼び出し側が記事用の画像に切り替える
    if (!engine) return null;
    const original = await library.openOriginal(target.photo.id, { signal });
    const latest = original.photo;
    // 新しい版の NIHO で補正された写真は、古い数式で描かない
    if (!isEditableDevelopSettings(latest.developSettings)) throw new Error(PHOTO_EDITING_EXPORT_NEWER_TEXT);
    const hasSaved = hasSavedDevelopSettings(latest);
    const saved = readDevelopSettings(latest.developSettings);
    const input = await loadPhotoLibraryRenderInput(library, {
      photo: latest,
      original: original.source,
      fileName: latest.fileName || target.photo.fileName,
      signal,
    });
    if (input.kind === "notReady") throw new Error(workExportWaitingText(isBrowserCloudRawPhoto(latest)));
    if (input.kind === "unavailable") throw new Error(input.message);
    let workMeta: unknown;
    if (input.kind === "workingCopy") {
      try {
        workMeta = JSON.parse(input.metaJson) as unknown;
      } catch {
        throw new Error(PHOTO_EDITING_EXPORT_NEWER_TEXT);
      }
    }
    return renderBrowserPhotoExportJpeg({
      engine,
      input,
      // 作業コピーから描く写真は、保存済み base と同じ版だけを使う（開くときと同じ）
      settings:
        input.kind === "workingCopy"
          ? developSettingsOnWorkingCopy(hasSaved ? saved : null, input.baseVersion, workMeta)
          : (saved ?? neutralDevelopSettings()),
      size,
      capturedAt: latest.capturedAt ?? target.photo.capturedAt ?? null,
      // 面のマスク（M4 #68）の面は、開いている写真ではなく書き出す写真の置き場から読む
      maskSurfaces: (surfaceId) => library.loadMaskSurface?.(latest.id, surfaceId) ?? Promise.resolve(null),
    });
  };

  /**
   * 原寸の JPEG（K2-3a 移行元設計。経路 `native`）。最新の行とオリジナルの署名 URL を読み、NIHO Desktop がクラウドのオリジナルを開いて
   * native の段 2 で原寸を描き、ネイティブの保存ダイアログでこの Mac に保存する（端末への保存 `host.saveFile` は通らない）。
   * 補正は、1 枚で wasm で開いている写真なら今の補正、一覧で選んだだけの写真なら保存してある補正（無ければ補正なし。新しい版の NIHO で
   * 補正された写真は描かない）。名前は `<元の名前の拡張子なし>.jpg`（ダイアログで変えられる。実際に保存した名前を返す）。
   *
   * `folderId`（複数枚のフォルダへの書き出し。K2-3b）を渡すと、ダイアログを出さずにそのフォルダへ書き、補正は 1 枚で開いていても
   * 保存してある補正（一覧で選んだ写真と同じ。開いていた写真の保存は一覧へ戻るときに送り終えている）。
   */
  const exportFullSizeOnMac = async (
    target: BrowserItem,
    exportNative: NonNullable<PhotoLibrary["exportNative"]>,
    signal: AbortSignal,
    folderId?: string,
  ): Promise<{ saved: boolean; fileName: string }> => {
    // 原寸を出しているが、アプリの更新が要る（押すと更新の 1 行。オリジナルを開く前に止める）
    if (!params.capabilities.nativeExport) throw new Error(PHOTO_EDITING_EXPORT_FULL_SIZE_UPDATE_TEXT);
    await waitForCanonical(target, signal);
    const liveSession = developSessionRef.current;
    if (folderId !== undefined && liveSession?.key === target.key && liveSession.saver) {
      const flushed = await liveSession.saver.flush();
      if (!flushed.ok) throw new Error("補正を保存できなかったため、書き出しを始められませんでした。");
    }
    const original = await library.openOriginal(target.photo.id, { signal });
    const latest = original.photo;
    const current = openedRef.current;
    const hasSaved = hasSavedDevelopSettings(latest);
    const signedRecipeEligible = isPhotoCloudSignedRecipeEligible(latest);
    let developSettings: DevelopSettings;
    if (folderId === undefined && viewModeRef.current === "loupe" && current?.key === target.key && current.mode === "wasm") {
      developSettings = settingsRef.current;
      // 開いただけの写真（保存したことが無く何も当てていない）は、下の未編集の写真と同じく niho-2 の neutral で渡す。raster の
      // neutral は cube を通らず相対 WB も H/S の解析も無いので niho-10 / niho-12〜niho-14 と同じ画。unsigned RAW は niho-12〜niho-14 の
      // float の look+ACR3 と 8bit の丸め分だけ違うが、niho-12〜niho-14 を知らない古い native でも描ける既存の書き出しの画を保つ
      if (
        !hasSaved &&
        (developSettings.engine === DEVELOP_SETTINGS_ENGINE ||
          developSettings.engine === NIHO13_DEVELOP_SETTINGS_ENGINE ||
          developSettings.engine === NIHO12_DEVELOP_SETTINGS_ENGINE ||
          developSettings.engine === NIHO10_DEVELOP_SETTINGS_ENGINE) &&
        isNeutralDevelopSettings(developSettings)
      ) {
        developSettings = { ...developSettings, engine: NIHO2_DEVELOP_SETTINGS_ENGINE };
      }
    } else {
      if (!isEditableDevelopSettings(latest.developSettings)) throw new Error(PHOTO_EDITING_EXPORT_NEWER_TEXT);
      // 未編集の写真は、JPEG / PNG も RAW も niho-2 の neutral で渡す（移行元設計）。native は signed の経路でしか engine を書き換え
      // ないので、niho-6 のままだと RAW は描けず（exit 3）、niho-6 を知らない古い NIHO Desktop（native < 0.15）は更新の案内で
      // 止まる。niho-2 の neutral は niho-6 の neutral と同じ画で、出したどの native も描ける
      developSettings = readDevelopSettings(latest.developSettings) ?? {
        ...neutralDevelopSettings(),
        engine: NIHO2_DEVELOP_SETTINGS_ENGINE,
      };
      // 本当に未編集の RAW だけは READY の作業コピーの base/meta を初期値にする。旧 `base: null` 保存は
      // `hasSaved === true` なのでここへ入らない。未準備なら従来どおり native の生成 flag に任せる。
      if (signedRecipeEligible && !hasSaved && developSettings.base === null && isBrowserCloudRawPhoto(latest)) {
        const work = await library.ensureWorkingCopy(latest.id, {
          signal,
          sourceContext: {
            hasSavedDevelopSettings: hasSaved,
            hasDevelopEdits: !isNeutralDevelopSettings(developSettings),
            baseVersion: typeof developSettings.base === "string" ? developSettings.base : null,
          },
        });
        if (work.kind === "ready") {
          developSettings = developSettingsOnWorkingCopy(null, work.download.work.baseVersion, work.download.work.meta);
        }
      }
    }
    const sourceFileName = latest.fileName || target.photo.fileName;
    const suggestedFileName = browserPhotoExportJpegFileName(sourceFileName);
    const exported = await exportNative({
      photoId: latest.id,
      // 開いたオリジナルの参照を渡し返す（クラウドは NIHO Desktop がその署名付き URL から落として開く）
      source: {
        ref: original.source.ref,
        contentSha256: latest.contentSha256,
        fileName: sourceFileName,
        fileExtension: latest.fileExtension,
        sizeBytes: latest.sizeBytes,
      },
      developSettings,
      hasSavedDevelopSettings: hasSaved,
      // native の signed 新規生成は API と同じ「一度も保存していない」が明示できたときだけ許可する。
      hasDevelopEdits: !signedRecipeEligible || !isNeutralDevelopSettings(developSettings),
      suggestedFileName,
      ...(folderId !== undefined ? { folderId } : {}),
    });
    return { saved: exported.saved, fileName: exported.fileName ?? suggestedFileName };
  };

  /** 背景除去を当てる写真が、今 1 枚で wasm で開いている写真か（背景除去は今の入力・今の補正で描く。C4 移行元設計）。 */
  const loupeCutoutPhoto = (target: BrowserItem, cutout: BrowserPhotoCutoutExport) => {
    const current = openedRef.current;
    if (viewModeRef.current !== "loupe" || !current || current.mode !== "wasm") return null;
    return current.key === target.key && current.key === cutout.photoKey ? current : null;
  };

  /**
   * 背景除去を当てた PNG / JPEG（NIHO camera。C4 移行元設計。大きさは長辺 2048px / 幅 1080px）。1 枚で wasm で開いている写真を、経路
   * `engine` と同じ入力のコピー・今の補正・大きさで描き（背景除去を当てる前なので最高の画質・EXIF 無し）、RGBA に読み、原寸のマスクを
   * 描いた大きさに縮めてブラシと背景を当てる（{@link composeBrowserPhotoCutoutRgba}）。PNG は EXIF 無し、JPEG は今の JPEG と同じ画質で、
   * 撮影日時の分かる写真には今と同じ撮影日時の EXIF を付ける。止めたら（`signal`）途中で捨てる。
   */
  const renderCutoutExport = async (
    target: BrowserItem,
    cutout: BrowserPhotoCutoutExport,
    format: BrowserPhotoCutoutExportFormat,
    size: BrowserPhotoExportSize,
    signal: AbortSignal,
  ): Promise<{ blob: Blob; rendered: BrowserPhotoExportRendered }> => {
    await waitForCanonical(target, signal);
    const current = loupeCutoutPhoto(target, cutout);
    const engine = engineRef.current;
    if (!current?.input || !engine) throw new BrowserPhotoSourceError("encode_failed");
    const stopIfAborted = () => {
      if (signal.aborted) throw new Error("export aborted");
    };
    const capturedAt = current.photo?.capturedAt ?? target.photo.capturedAt ?? null;
    const rendered = await renderBrowserPhotoExportJpeg({
      engine,
      input: await copyDevelopInput(current.input),
      settings: settingsRef.current,
      size,
      capturedAt: null,
      quality: BROWSER_PHOTO_CUTOUT_RENDER_JPEG_QUALITY,
    });
    stopIfAborted();
    let maskPng: Uint8Array;
    try {
      maskPng = await cutout.readMask();
    } catch {
      throw new BrowserPhotoCutoutExportError("corrupt_mask");
    }
    stopIfAborted();
    const decoded = await decodeBrowserPhotoJpegRgba(rendered.bytes);
    const rgba = await composeBrowserPhotoCutoutRgba({ ...decoded, maskPng, recipe: cutout.recipe, format });
    stopIfAborted();
    if (format === "png") {
      return { blob: await encodeBrowserPhotoRgba(rgba, decoded.width, decoded.height, { type: "image/png" }), rendered };
    }
    const jpeg = await encodeBrowserPhotoRgba(rgba, decoded.width, decoded.height, {
      type: "image/jpeg",
      quality: DEVELOP_WEB_IMAGE_JPEG_QUALITY,
    });
    if (!capturedAt) return { blob: jpeg, rendered };
    const withExif = await withCaptureExifOrPlain(engine, new Uint8Array(await jpeg.arrayBuffer()), capturedAt);
    return { blob: new Blob([withExif], { type: "image/jpeg" }), rendered };
  };

  /**
   * 背景除去を当てた原寸（NIHO camera の口 `exportFullSize`。C4 移行元設計）: camera の native が段 2 で原寸を描き、sidecar の compose で
   * 背景除去を当てて保存ダイアログで保存する。補正は 1 枚で開いている写真の今の補正。口の失敗は `code`（sidecar の error）ごとの
   * 1 行、`code` の無い失敗は「書き出せませんでした」。
   */
  const exportCutoutFullSize = async (
    target: BrowserItem,
    cutout: BrowserPhotoCutoutExport,
    exportFullSize: NonNullable<BrowserPhotoCutoutExport["exportFullSize"]>,
    format: BrowserPhotoCutoutExportFormat,
    signal: AbortSignal,
  ): Promise<{ saved: boolean; fileName: string }> => {
    await waitForCanonical(target, signal);
    if (!loupeCutoutPhoto(target, cutout)) throw new BrowserPhotoSourceError("encode_failed");
    try {
      return await exportFullSize({ recipe: cutout.recipe, settings: settingsRef.current, format });
    } catch (error) {
      const code = cutoutFailureCode(error);
      if (code !== "internal_error" && code !== "aborted") throw new BrowserPhotoCutoutExportError(code);
      throw new Error(format === "png" ? PHOTO_EDITING_EXPORT_PNG_FAILED_TEXT : PHOTO_EDITING_EXPORT_FULL_SIZE_FAILED_TEXT);
    }
  };

  /**
   * 書き出す（移行元設計・F7b 移行元設計）。JPEG（`<元の名前の拡張子なし>.jpg`）は `jpegRoute`（シートに出した経路。
   * `resolveBrowserPhotoExportChoices` の `jpeg.route`）に従う: `engine` は段 2 の wasm で入力から選んだ大きさ（`size`）で描いて撮影日時の
   * EXIF を付け（{@link renderEngineJpeg}）、幅 1080px に届かなかった写真は状態欄の 1 行に幅を足す。`canvas` は 1 枚で開いた S1 の
   * canvas で今の補正を描き、`webImage` は記事用の画像をそのまま落とす（どちらも長辺 2048px だけ）。経路が無ければ何もしない。
   * オリジナルは署名 URL から申告サイズと 200MiB を上限に読み、元の名前で保存する。
   *
   * `saveRoute`（スマホのシートから。F6c 移行元設計）が `share` / `device-file` の JPEG は、描いた写真を共有シート・端末の保存へ渡す
   * （`savePhotosToDevice`）。描くのに時間がかかって共有シートを出せなかったら `needs-tap` を返し、写真は `pendingShare` に持つ
   * （{@link sharePending} で出す）。`saveRoute` が無い（PC）・`download`・オリジナルは今までの経路。
   *
   * 大きさの原寸（`size: "full"`。NIHO Desktop の口があるときだけ。K2-3a 移行元設計）は経路 `native` だけで描く（{@link exportFullSizeOnMac}）。
   * 保存ダイアログを閉じたら `cancelled`（失敗にせず何も出さない）、保存したら「<名前> を保存しました」。原寸と `native` の
   * どちらか一方だけ・口の無いときは何もしない。
   *
   * `cutout`（NIHO camera で背景除去を重ねている写真。PC のシートだけ。C4 移行元設計）があれば、JPEG と PNG（`<元の名前の拡張子なし>.png`）
   * に背景除去を当てる: 長辺 2048px / 幅 1080px は経路 `engine` で描いて当て（{@link renderCutoutExport}）、原寸（経路 `native`）は
   * camera の口で描く（{@link exportCutoutFullSize}。NIHO Desktop の口は使わない）。PNG は `cutout` があるときだけ書き出す。
   */
  const runExport = async (
    format: BrowserPhotoExportFormat,
    options: {
      size: BrowserPhotoExportSizeOption;
      jpegRoute: BrowserPhotoExportJpegRoute | null;
      saveRoute?: PhotoSaveRoute;
      cutout?: BrowserPhotoCutoutExport | null;
    },
  ): Promise<BrowserPhotoExportResult> => {
    const target = selectedItem;
    if (!target || target.adding || operationRef.current) return "skipped";
    const jpegRoute = options.jpegRoute;
    // 背景除去を当てる書き出し（JPEG / PNG。オリジナルはそのまま）
    const cutout = format !== "original" ? (options.cutout ?? null) : null;
    const cutoutFormat: BrowserPhotoCutoutExportFormat | null = cutout ? (format === "png" ? "png" : "jpeg") : null;
    if (format === "png" && !cutout) return "skipped";
    const rendersImage = format !== "original";
    if (rendersImage && jpegRoute === null) return "skipped";
    if (rendersImage && params.pendingEdits?.hasPending() && (!(await settleAcceptedEdits()) || operationRef.current)) return "skipped";
    // 原寸の書き出しを出しているときだけ（できる・更新が要る版）。背景除去の原寸は camera の口
    const exportNative =
      params.capabilities.nativeExport || params.capabilities.nativeExportUpdateRequired ? library.exportNative : undefined;
    const cutoutFullSize = cutout?.exportFullSize;
    if (rendersImage && (jpegRoute === "native") !== (options.size === "full")) return "skipped";
    if (rendersImage && jpegRoute === "native" && hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(settingsRef.current)) {
      setStatus({ kind: "error", text: PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT });
      return "failed";
    }
    if (rendersImage && jpegRoute === "native" && !(cutout ? cutoutFullSize : exportNative)) return "skipped";
    // 背景除去は 1 枚で wasm で開いた写真の今の補正で描く（長辺 2048px / 幅 1080px は engine、原寸は camera の口）
    if (cutout && jpegRoute !== "engine" && jpegRoute !== "native") return "skipped";
    // 原寸は wasm の大きさではない（オリジナル・原寸の経路では大きさを使わない）
    const renderSize: BrowserPhotoExportSize = options.size === "full" ? "long2048" : options.size;
    const photoRoute =
      format === "jpeg" && (options.saveRoute === "share" || options.saveRoute === "device-file") ? options.saveRoute : null;
    clearPendingShare();
    setExportSheetOpen(false);
    const operationSpotId = spotId;
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    saveGenerationRef.current += 1;
    operationRef.current = "export";
    setOperation({ kind: "export", fileName: target.photo.fileName, deleting: false });
    setStatus(null);
    try {
      if (rendersImage && jpegRoute === "native") {
        // 背景除去は camera の口、ほかは写真の出どころの原寸の書き出し（どちらがあるかは上で確かめてある）
        const exported =
          cutout && cutoutFormat && cutoutFullSize
            ? await exportCutoutFullSize(target, cutout, cutoutFullSize, cutoutFormat, controller.signal)
            : !cutout && exportNative
              ? await exportFullSizeOnMac(target, exportNative, controller.signal)
              : null;
        if (!exported || !mountedRef.current || controller.signal.aborted || latestAccessRef.current.spotId !== operationSpotId) {
          return "skipped";
        }
        // 保存ダイアログを閉じた（失敗にしない。状態欄にも出さない）
        if (!exported.saved) return "cancelled";
        setStatus({ kind: "notice", text: `${exported.fileName} を保存しました` });
        return "done";
      }
      let blob: Blob;
      let fileName: string;
      let exportedSettingsKey: string | null = null;
      let narrowWidth: number | null = null;
      if (format === "original") {
        const downloaded = await library.downloadOriginal(target.photo, { signal: controller.signal });
        blob = downloaded.blob;
        fileName = downloaded.fileName;
      } else if (cutout && cutoutFormat) {
        const exported = await renderCutoutExport(target, cutout, cutoutFormat, renderSize, controller.signal);
        blob = exported.blob;
        fileName =
          cutoutFormat === "png"
            ? browserPhotoExportPngFileName(target.photo.fileName)
            : browserPhotoExportJpegFileName(target.photo.fileName);
        if (!exported.rendered.reachedWidth) narrowWidth = exported.rendered.width;
      } else {
        fileName = browserPhotoExportJpegFileName(target.photo.fileName);
        if (jpegRoute === "engine") {
          const rendered = await renderEngineJpeg(target, renderSize, controller.signal);
          if (rendered) {
            blob = new Blob([rendered.bytes], { type: "image/jpeg" });
            if (!rendered.reachedWidth) narrowWidth = rendered.width;
          } else if (renderSize === "width1080") {
            // 記事用の画像は長辺 2048px のままなので、選択した幅 1080px を満たせない経路へ黙って切り替えない。
            throw new Error(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT);
          } else if (!target.photo.hasOriginal && target.photo.hasWebImage !== false) {
            // 元の写真の無い行（「記事の画像」）は、記事用の画像がその画像そのものなので落とす（長辺 2048px・EXIF 無し）。写真は
            // 記事用の画像を書き出さない（K4 移行元設計）
            blob = await fetchBrowserCloudWebImageJpeg(library, target.photo, controller.signal);
          } else {
            throw new Error(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT);
          }
        } else if (jpegRoute === "canvas") {
          // S1 の canvas は、編集内容のうち 5 つの値で描く（書き出した値は、離れる前の破棄の確認で数えない）
          const current = openedRef.current;
          const decoded = viewModeRef.current === "loupe" && current?.key === target.key ? current.decoded : null;
          if (!decoded) throw new BrowserPhotoSourceError("encode_failed");
          const settings = settingsRef.current;
          exportedSettingsKey = developSettingsKey(settings);
          blob = await exportBrowserPhotoJpeg(decoded, readBrowserAdjustmentsFromDevelopSettings(settings));
        } else {
          blob = await fetchBrowserCloudWebImageJpeg(library, target.photo, controller.signal);
        }
      }
      if (!mountedRef.current || controller.signal.aborted || latestAccessRef.current.spotId !== operationSpotId) return "skipped";
      if (photoRoute) {
        const share: PendingPhotoShare = {
          key: target.key,
          fileName,
          files: [new File([blob], fileName, { type: "image/jpeg" })],
          route: photoRoute,
          exportedSettingsKey,
          narrowWidth,
        };
        const outcome = await savePhotosToDevice(share.files, photoRoute, photoSaveEnv(host));
        return mountedRef.current ? finishPhotoSave(outcome, share) : "skipped";
      }
      const result = await host.saveFile({ blob, fileName });
      if (!mountedRef.current) return "skipped";
      if (result === "cancelled") return "cancelled";
      if (exportedSettingsKey !== null) setSavedSettingsKey(exportedSettingsKey);
      const note = narrowNote(narrowWidth);
      setStatus({
        kind: "notice",
        text: result === "saved" ? `${fileName} を保存しました${note}` : `${fileName} をダウンロードしました${note}`,
      });
      return "done";
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) {
        setStatus({ kind: "error", text: describeExportFailure(error, format, library.errors) });
        return "failed";
      }
      return "skipped";
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  };

  /**
   * 一覧で選んだ複数枚を、Desktop と共有する直列 runner で 1 枚ずつ描き、PC へ 1 つの ZIP として保存する（F7b 移行元設計）。
   * JPEG は必ず最新の行・保存済み補正・オリジナル／作業コピーから engine で描き、記事用の画像へは切り替えない。個別失敗は
   * 名前を記録して残りを続ける。「止める」は処理中の 1 枚が終わってから効く。
   */
  /**
   * スマホの複数書き出し（F6c 移行元設計）。選択順の 2〜10 枚を 1 枚ずつ同じ engine で描き、ZIP にせず、その順の File 配列を
   * Web Share / native save へ渡す。共有の user activation が描画中に切れた場合は全 File を持ち、次の 1 tap では描き直さない。
   */
  const runMobileBatchExport = async (options: {
    size: BrowserPhotoExportSize;
    saveRoute: PhotoSaveRoute;
    jpegRoutes: ReadonlyMap<string, BrowserPhotoExportJpegRoute>;
  }): Promise<BrowserPhotoExportResult> => {
    const targets = params.selectedItems ?? [];
    if (
      targets.length < 2 ||
      targets.length > PHOTO_SAVE_MAX_FILES ||
      targets.some((target) => target.adding) ||
      operationRef.current
    ) {
      return "skipped";
    }
    const key = targets.map((target) => target.key).join("\u001f");
    if (params.pendingEdits?.hasPending() && (!(await settleAcceptedEdits()) || operationRef.current)) return "skipped";
    clearPendingShare();
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    saveGenerationRef.current += 1;
    operationRef.current = "export";
    setOperation({ kind: "export", fileName: `${targets.length} 枚`, deleting: false });
    setStatus(null);
    try {
      const files: File[] = [];
      for (const target of targets) {
        const route = options.jpegRoutes.get(target.key);
        // canvas（1 枚で開いた写真だけ）と原寸（NIHO Desktop の PC のシートだけ）は複数枚では描かない
        if (!route || route === "canvas" || route === "native") throw new Error(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT);
        const fileName = browserPhotoExportJpegFileName(target.photo.fileName);
        let blob: Blob;
        if (route === "engine") {
          const rendered = await renderEngineJpeg(target, options.size, controller.signal);
          if (rendered) blob = new Blob([rendered.bytes], { type: "image/jpeg" });
          else if (options.size === "long2048" && !target.photo.hasOriginal && target.photo.hasWebImage !== false) {
            blob = await fetchBrowserCloudWebImageJpeg(library, target.photo, controller.signal);
          } else {
            throw new Error(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT);
          }
        } else {
          if (options.size !== "long2048") throw new Error(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT);
          blob = await fetchBrowserCloudWebImageJpeg(library, target.photo, controller.signal);
        }
        files.push(new File([blob], fileName, { type: "image/jpeg" }));
      }
      if (!mountedRef.current || controller.signal.aborted || latestAccessRef.current.spotId !== spotId) return "skipped";
      const share: PendingPhotoShare = {
        key,
        fileName: `${files.length} 枚`,
        files,
        route: options.saveRoute,
        exportedSettingsKey: null,
        narrowWidth: null,
      };
      const outcome = await savePhotosToDevice(files, options.saveRoute, photoSaveEnv(host));
      return mountedRef.current ? finishPhotoSave(outcome, share) : "skipped";
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) {
        setStatus({ kind: "error", text: describeExportFailure(error, "jpeg", library.errors) });
        return "failed";
      }
      return "skipped";
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  };


  const runBatchExport = async (
    format: BrowserPhotoExportFormat,
    size: BrowserPhotoExportSize,
  ): Promise<BrowserPhotoBatchExportResult> => {
    const selected = (params.selectedItems ?? []).filter((item) => !item.adding);
    // 複数枚に背景除去は当てない（PNG は 1 枚の書き出しだけ。C4 移行元設計）
    if (format === "png" || selected.length < 2 || operationRef.current) return "skipped";
    if (format !== "original" && params.pendingEdits?.hasPending() && (!(await settleAcceptedEdits()) || operationRef.current)) return "skipped";
    const targets: BrowserPhotoBatchExportTarget[] = selected.map((item) => ({
      photoId: item.photo.id,
      fileName: item.photo.fileName,
      sizeBytes: item.photo.sizeBytes,
    }));
    const limit = resolveBrowserPhotoBatchExportLimit(targets);
    if (!limit.allowed) {
      setStatus({ kind: "error", text: limit.message });
      return "skipped";
    }

    const archiveNames = browserPhotoBatchArchiveNames(targets, format);
    const itemsById = new Map(selected.map((item) => [item.photo.id, item]));
    const archiveNamesById = new Map(targets.map((target, index) => [target.photoId, archiveNames[index]!]));
    const entries: BrowserPhotoZipEntry[] = [];
    const narrowPhotoCount = { current: 0 };
    const controller = new AbortController();
    const stopController = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    batchStopRef.current = stopController;
    setBatchStopping(false);
    setBatchFinalizing(false);
    clearPendingShare();
    setExportSheetOpen(false);
    saveGenerationRef.current += 1;
    operationRef.current = "export";
    setOperation({ kind: "export", fileName: `${targets.length} 枚`, deleting: false });
    setStatus(null);

    try {
      const result = await runPhotoEditingBatchSequence({
        targets,
        signal: stopController.signal,
        onProgress: ({ index, total, target }) => {
          if (mountedRef.current) {
            setOperation({ kind: "export", fileName: target.fileName, deleting: false, progressText: `${index} / ${total} 枚を書き出し中…` });
          }
        },
        exportPhoto: async (target) => {
          const item = itemsById.get(target.photoId);
          if (!item) throw new Error("選んだ写真を読み込めませんでした。");
          let blob: Blob;
          if (format === "original") {
            blob = (await library.downloadOriginal(item.photo, { signal: controller.signal })).blob;
          } else {
            const rendered = await renderEngineJpeg(item, size, controller.signal);
            if (!rendered) throw new Error(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT);
            if (size === "width1080" && !rendered.reachedWidth) narrowPhotoCount.current += 1;
            blob = new Blob([rendered.bytes], { type: "image/jpeg" });
          }
          entries.push({ name: archiveNamesById.get(target.photoId) ?? target.fileName, blob });
          return true;
        },
      });
      if (!mountedRef.current || controller.signal.aborted || latestAccessRef.current.spotId !== spotId) return "skipped";
      if (batchStopRef.current === stopController) batchStopRef.current = null;

      let saveResult: PhotoEditingSaveFileResult | null = null;
      if (entries.length > 0) {
        const payloadBytes = entries.reduce((total, entry) => total + entry.blob.size, 0);
        if (payloadBytes > BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES) {
          setStatus({
            kind: "error",
            text: "書き出した写真の合計が 500MB を超えました。選択を分けて書き出してください。",
          });
          if (result.failures.length > 0) {
            void appDialog
              .alert({ title: `${result.failures.length} 枚を書き出せませんでした`, description: browserPhotoBatchFailureNames(result.failures) })
              .catch(() => undefined);
          }
          return "failed";
        }
        setBatchFinalizing(true);
        setOperation({ kind: "export", fileName: `${entries.length} 枚`, deleting: false, progressText: "ZIP にまとめています…" });
        const zip = await createBrowserPhotoExportZip(entries, { signal: controller.signal });
        saveResult = await host.saveFile({ blob: zip, fileName: browserPhotoBatchArchiveFileName() });
      }
      if (!mountedRef.current) return "skipped";

      const narrowNotice =
        saveResult !== "cancelled" && narrowPhotoCount.current > 0
          ? `幅 1080px に届かない写真が ${narrowPhotoCount.current} 枚あります。小さい写真は拡大せず書き出しました。`
          : "";
      const withNarrowNotice = (message: string) => (narrowNotice ? `${message} ${narrowNotice}` : message);

      if (result.failures.length > 0) {
        const count = result.failures.length;
        setStatus({
          kind: "error",
          text: withNarrowNotice(`${count} 枚を書き出せませんでした。写真の名前を確認してください。`),
        });
        void appDialog
          .alert({ title: `${count} 枚を書き出せませんでした`, description: browserPhotoBatchFailureNames(result.failures) })
          .catch(() => undefined);
      } else if (result.status === "stopped") {
        setStatus({
          kind: "notice",
          text: withNarrowNotice(entries.length > 0 ? `${entries.length} 枚を ZIP にまとめて停止しました` : "書き出しを停止しました"),
        });
      } else if (saveResult !== "cancelled") {
        setStatus({ kind: "notice", text: withNarrowNotice(`${entries.length} 枚を ZIP にまとめました`) });
      }

      if (saveResult === "cancelled") return "cancelled";
      if (result.status === "stopped") return "stopped";
      return entries.length > 0 ? "done" : "failed";
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) {
        setStatus({ kind: "error", text: error instanceof Error && error.message ? error.message : "ZIP を作成できませんでした。" });
        return "failed";
      }
      return "skipped";
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      if (batchStopRef.current === stopController) batchStopRef.current = null;
      operationRef.current = null;
      if (mountedRef.current) {
        setBatchStopping(false);
        setBatchFinalizing(false);
        setOperation(null);
      }
    }
  };

  /**
   * 一覧で選んだ複数枚を、NIHO Desktop で選んだフォルダへ原寸の JPEG で書き出す（K2-3b 移行元設計。PC の選択バーの［書き出す］の
   * シートの「フォルダに書き出す」）。旧い Desktop の面の「フォルダへ書き出し」（`exportTargetsToFolder`）と同じく、まずネイティブの
   * フォルダの選択（`chooseExportFolder`）を 1 回出し、閉じたら何もしない（`cancelled`。状態欄にも出さない）。選んだら選択順に 1 枚
   * ずつ、前の 1 枚が終わってから（native の重い処理は同時に 1 本）、最新の行・保存してある補正で、クラウドのオリジナルを Desktop に
   * 開いて原寸で `folderId` つきに書く（{@link exportFullSizeOnMac}。名前は `<元の名前の拡張子なし>.jpg`、同名は Desktop が `-2` …）。
   *
   * - 進み具合は ZIP と同じ「i / N 枚を書き出し中…」。「止める」は書き出し中の 1 枚が終わってから効き、書けた分は残る
   * - 書けなかった写真（HEIC / TIFF・この Desktop で描けない補正・新しい版の NIHO の補正・開けない）は記録して次へ進み、終わりに
   *   状態欄へ「N 枚中 M 枚を書き出しました。K 枚を書き出せませんでした」、知らせに 1 枚 1 行で「<名前>: <理由>」。HEIC / TIFF は
   *   Desktop が断る形式なので、オリジナルを Desktop へ落とす前に同じ理由（`unsupportedSource` の文）で失敗にする
   * - 書き出し先のフォルダが無くなった（`folderNotFound`）ら残りを止め、状態欄にその理由
   * - 全部書けたら「N 枚を書き出しました」（`describePhotoEditingBatchExportSummary`。旧い Desktop の面と同じ）
   * - ZIP の 50 枚・500MB の上限は当てない（Desktop が 1 枚ずつ直接書く。旧い Desktop の面と同じ）
   */
  const runBatchFolderExport = async (): Promise<BrowserPhotoBatchExportResult> => {
    // 原寸の書き出しと書き出し先のフォルダの選択の両方を出しているときだけ（できる・更新が要る版）
    const folderExport = params.capabilities.exportFolder || params.capabilities.nativeExportUpdateRequired;
    const exportNative = folderExport ? library.exportNative : undefined;
    const chooseExportFolder = folderExport ? library.chooseExportFolder : undefined;
    const selected = (params.selectedItems ?? []).filter((item) => !item.adding);
    if (!exportNative || !chooseExportFolder || selected.length < 2 || operationRef.current) return "skipped";
    if (params.pendingEdits?.hasPending() && (!(await settleAcceptedEdits()) || operationRef.current)) return "skipped";
    const itemsById = new Map(selected.map((item) => [item.photo.id, item]));
    const targets = selected.map((item) => ({ photoId: item.photo.id, fileName: item.photo.fileName }));
    const controller = new AbortController();
    const stopController = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    batchStopRef.current = stopController;
    setBatchStopping(false);
    setBatchFinalizing(false);
    clearPendingShare();
    setExportSheetOpen(false);
    saveGenerationRef.current += 1;
    operationRef.current = "export";
    setOperation({ kind: "export", fileName: `${targets.length} 枚`, deleting: false });
    setStatus(null);

    try {
      const result = await runPhotoEditingBatchExport({
        targets,
        chooseFolder: chooseExportFolder,
        isFolderNotFound: (error) => library.errors.isExportFolderNotFound(error),
        signal: stopController.signal,
        onProgress: ({ index, total, target }) => {
          if (mountedRef.current) {
            setOperation({ kind: "export", fileName: target.fileName, deleting: false, progressText: `${index} / ${total} 枚を書き出し中…` });
          }
        },
        exportPhoto: async (target, folderId) => {
          // 面を離れた・拠点を替えたら、残りは書かない
          if (controller.signal.aborted || latestAccessRef.current.spotId !== spotId) {
            stopController.abort();
            return false;
          }
          const item = itemsById.get(target.photoId);
          if (!item) throw new Error("選んだ写真を読み込めませんでした。");
          const savedSettings = item.photo.developSettings;
          if (savedSettings && hasPhotoEditingColorGradingNativeExportUnsupportedLuminance(savedSettings)) {
            throw new Error(PHOTO_EDITING_EXPORT_FULL_SIZE_COLOR_GRADING_UNSUPPORTED_FAILED_TEXT);
          }
          // HEIC / TIFF は Desktop が断る（`unsupportedSource`）ので、オリジナルを Desktop へ落とす前に同じ 1 行にする（描ける口は除く）
          if (!isDesktopFullSizeSource(item.photo, { raster: params.capabilities.nativeExportRaster === true })) {
            throw new Error(PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_FAILED_TEXT);
          }
          return (await exportFullSizeOnMac(item, exportNative, controller.signal, folderId)).saved;
        },
      });
      if (!mountedRef.current || controller.signal.aborted || latestAccessRef.current.spotId !== spotId) return "skipped";
      if (batchStopRef.current === stopController) batchStopRef.current = null;
      // フォルダの選択を閉じた（失敗にしない。状態欄にも出さない）
      if (result.status === "cancelled") return "cancelled";

      const summary = describePhotoEditingBatchExportSummary(result);
      const failedCount = result.failures.length;
      if (result.status === "folderNotFound") {
        const reason = library.errors.describeNative(result.folderError);
        setStatus({ kind: "error", text: result.savedCount > 0 ? `${summary}。${reason}` : reason });
      } else if (failedCount > 0) {
        const failedText = photoEditingExportFailedCountText(failedCount);
        setStatus({ kind: "error", text: result.savedCount > 0 ? `${summary}。${failedText}` : failedText });
      } else if (result.status === "stopped") {
        setStatus({ kind: "notice", text: photoEditingFolderExportStoppedText(result.savedCount) });
      } else {
        setStatus({ kind: "notice", text: summary });
      }
      if (failedCount > 0) {
        void appDialog
          .alert({
            title: photoEditingExportFailedCountText(failedCount),
            description: folderExportFailureLines(result.failures, library.errors),
          })
          .catch(() => undefined);
      }

      if (result.status === "stopped") return "stopped";
      return result.status === "completed" && result.savedCount > 0 ? "done" : "failed";
    } catch (error) {
      // フォルダの選択そのものが失敗した（Desktop の文は英語のことがあるので決めた文にする）など
      if (mountedRef.current && !controller.signal.aborted) {
        setStatus({ kind: "error", text: describeFolderExportFailure(error, library.errors) });
        return "failed";
      }
      return "skipped";
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      if (batchStopRef.current === stopController) batchStopRef.current = null;
      operationRef.current = null;
      if (mountedRef.current) {
        setBatchStopping(false);
        setOperation(null);
      }
    }
  };

  const stopBatchExport = () => {
    if (!batchStopRef.current || batchStopRef.current.signal.aborted) return;
    batchStopRef.current.abort();
    setBatchStopping(true);
  };

  /**
   * 描き終えて待っている写真を共有シートへ渡す（スマホのシートの同じボタンの 2 回目）。**ユーザーの操作の中で呼ぶ**: 共有シートは
   * 押してから約 5 秒しか出せないので、ここでは描き直しも fetch もせず、`await` の前に `navigator.share` まで届かせる。
   */
  const sharePending = async (): Promise<BrowserPhotoExportResult> => {
    const share = pendingShareRef.current;
    if (!share || operationRef.current) return Promise.resolve("skipped");
    operationRef.current = "export";
    setOperation({ kind: "export", fileName: share.fileName, deleting: false });
    try {
      const outcome = await savePhotosToDevice(share.files, share.route, photoSaveEnv(host));
      return mountedRef.current ? finishPhotoSave(outcome, share) : "skipped";
    } catch (error) {
      if (!mountedRef.current) return "skipped";
      setPendingShare(null);
      setStatus({ kind: "error", text: describeExportFailure(error, "jpeg", library.errors) });
      return "failed";
    } finally {
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  };

  /**
   * クラウドから消す（移行元設計。Desktop と同じ参照確認・API）。ブラウザは選んでいる 1 枚だけを対象にする（複数選択は見送り）。
   * 消したら一覧・使用量を読み直し、選択・開いていた写真を外す。
   */
  const deleteSelectedCloudPhoto = async () => {
    const target = selectedItem;
    if (!canEdit || !target || target.adding || operationRef.current || deleteConfirmingRef.current) return;
    deleteConfirmingRef.current = true;
    saveGenerationRef.current += 1;
    operationRef.current = "delete";
    setOperation({ kind: "delete", fileName: target.photo.fileName, deleting: false });
    setStatus(null);
    setExportSheetOpen(false);
    try {
      let articleUsage: string | null = null;
      try {
        articleUsage = await readPhotoCloudDeleteArticleUsage(library, target.photo.id);
      } catch {
        // 件数確認に失敗しても、削除確認そのものは出す（既存Desktopと同じ fail-open）。
      }
      if (!mountedRef.current) return;
      const confirmed = await appDialog.confirm({
        title: "クラウドから消しますか？",
        description: describeDeleteConfirm(target.photo, articleUsage),
        confirmLabel: "消す",
        variant: "danger",
      });
      if (!confirmed || !mountedRef.current) return;
      const access = latestAccessRef.current;
      if (!access.canEdit || access.spotId !== spotId) return;
      setOperation({ kind: "delete", fileName: target.photo.fileName, deleting: true });

      // 読み込み中の対象を消す場合、APIの結果を待つ間に古い取得が表示されないよう先に中止する。
      if (openingKeyRef.current === target.key) {
        params.open.abortOpening();
        setViewMode("grid");
      }

      const { deleted, errors } = await library.delete([target.photo.id]);
      if (deleted.length > 0) {
        // 消した写真の保存は送らない（待っている保存を捨てて手放す）
        if (developSessionRef.current?.key === target.key) releaseDevelopSession();
        params.removeCloudPhotos(deleted);
        params.items.removeAddedPhoto(target.photo.id);
        if (params.items.deepLinkedPhoto?.id === target.photo.id) params.items.setDeepLinkedPhoto(null);
        params.items.setSelectedKey((current) => (current === target.key ? null : current));
        if (openedRef.current?.key === target.key) {
          params.open.clearOpened();
          setViewMode("grid");
        }
      }
      if (!mountedRef.current) return;
      params.open.setSourceError(null);
      if (errors.length > 0) setStatus({ kind: "error", text: library.errors.describeDeleteFailure(errors) });
      else if (deleted.length > 0) setStatus({ kind: "notice", text: describePhotoCloudDeleteSummary(deleted.length) });
    } catch (error) {
      if (!mountedRef.current) return;
      params.open.setSourceError(null);
      setStatus({ kind: "error", text: library.errors.describeDeleteFailure([error]) });
    } finally {
      deleteConfirmingRef.current = false;
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  };

  return {
    runExport,
    runMobileBatchExport,
    runBatchExport,
    runBatchFolderExport,
    stopBatchExport,
    batchStopping,
    batchFinalizing,
    deleteSelectedCloudPhoto,
    /** 共有シートを出すのを待っている写真（無ければ null） */
    pendingShare: pendingShare ? { key: pendingShare.key, fileName: pendingShare.fileName } : null,
    sharePending,
    clearPendingShare,
  };
}
