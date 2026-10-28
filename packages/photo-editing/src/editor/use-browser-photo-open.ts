"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import {
  browserCloudLockedReason,
  browserCloudPhotoPlace,
  DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE,
  isBrowserCloudRawPhoto,
  loadBrowserCloudPhotoSource,
  readBrowserCloudPhotoRow,
  type BrowserCloudPlace,
} from "../browser-photo-cloud-source";
import { describeBrowserPhotoSourceError, renderBrowserPhotoPreview } from "../browser-photo-source";
import {
  createDevelopEngine,
  DevelopMaskSurfaceError,
  photoDevelopDiagnosticsEnabled,
  type DevelopEngine,
  type DevelopFrame,
} from "../develop-engine/develop-engine-client";
import { paintDevelopFrame } from "../develop-engine/develop-frame";
import type {
  PhotoLibraryDevelopSourceContext,
  PhotoLibraryPhoto,
  PhotoLibraryProvisionalDraft,
  PhotoLibraryWorkingCopy,
  PhotoLibraryWorkingCopyResult,
} from "../library/photo-library";
import { usePhotoLibrary } from "../library/photo-library-context";
import {
  developSettingsKey,
  hasSavedDevelopSettings,
  isNeutralDevelopSettings,
  neutralDevelopSettings,
  readDevelopSettings,
  readBrowserAdjustmentsFromDevelopSettings,
  sameDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import { canRestoreDevelopSettingsDraft } from "../develop-engine/develop-settings-draft";
import {
  canOpenDevelopWorkInstead,
  isDevelopWorkTarget,
  rememberDevelopOriginalTooLarge,
} from "../develop-engine/develop-work-target";
import {
  workFailedText,
  isWorkSlow,
  type WorkWait,
} from "../develop-engine/develop-work-wait";
import { useDevelopWorkPoll } from "../develop-engine/use-develop-work-poll";
import { cropFrameDevelopSettings } from "../photo-editing-crop";
import { compareBeforeDevelopSettings, healFrameDevelopSettings } from "../photo-editing-heal";
import { appDialog } from "niho-ui/app-dialog";

import {
  DEVELOP_PREVIEW_MAX_DIMENSION,
  DISCARD_DESCRIPTION,
  cloudKey,
  developBaseVersion,
  developInteractiveMaxDimension,
  rebindDevelopSettings,
  workPreviewOpened,
  type BrowserItem,
  type BrowserPhotoAccess,
  type BrowserPhotoOperationKind,
  type BrowserViewMode,
  type FooterStatus,
  type OpenResult,
  type OpenedSource,
  type WorkOutcome,
} from "./browser-photo-editing-model";
import {
  openEditableSource,
  resolveWorkOutcome,
  type BrowserPhotoOpenFlowContext,
} from "./browser-photo-editing-open-flow";
import { renderDevelopWithoutUnreadableMasks } from "./browser-photo-mask-surface-render";
import { readCropSource, useBrowserPhotoCrop } from "./use-browser-photo-crop";
import type { PhotoEditingMaskSurfaceIssue } from "./use-browser-photo-masks";
import type { BrowserPhotoDevelop } from "./use-browser-photo-develop";
import { useBrowserPhotoDevelopReload } from "./use-browser-photo-develop-reload";
import { useBrowserPhotoEditSettings } from "./use-browser-photo-edit-settings";
import { useBrowserPhotoHeal } from "./use-browser-photo-heal";
import type { BrowserPhotoItems } from "./use-browser-photo-items";
import { BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS, useBrowserPhotoPresets } from "./use-browser-photo-presets";
import { useBrowserPhotoSettingsClipboard } from "./use-browser-photo-settings-clipboard";
import { useBrowserPhotoWorkingSize } from "./use-browser-photo-working-size";

/** provisional rasterへ投影するのは構造項目だけ。利用者の数値・幾何・未知項目はcanonical handoffまでそのまま持つ。 */
export function provisionalDevelopSettings(settings: DevelopSettings): DevelopSettings {
  const raster = neutralDevelopSettings();
  return {
    ...settings,
    engine: raster.engine,
    look: raster.look,
    base: null,
  };
}

/**
 * 描いた順（古い描画の結果で新しい画を上書きしない）。`requested` は描画の要求の通し番号、`painted` は最後に描いた要求の番号、
 * `valid` は描いてよい要求の下限（元に戻した・覚えている画を描いた・写真の入力を差し替えた・流れが変わったときに上げ、進行中の
 * 古い描画を画面へ出さない）。`stream` は、直前の要求がつまみを動かしている間の描画だったときの流れ（写真・道具・作業サイズ。
 * それ以外は null）。`generation` は写真の入力（エンジン）の世代
 */
type PaintOrder = { generation: number; requested: number; painted: number; valid: number; stream: string | null };

/** 進行中の描画をすべて無効にする（以後に描いてよいのは、返した番号以降の要求だけ） */
function invalidatePaints(order: PaintOrder): number {
  order.valid = ++order.requested;
  order.stream = null;
  return order.valid;
}

/**
 * 描画を 1 つ要求する。つまみを動かしている間の同じ流れの続き（離したときの丁寧な 1 枚を含む）なら、進行中の途中の画を無効に
 * しない（描き終えた順に描き、操作が描画より速くても画面を止めない）。流れが変わる（写真・道具・補正前・プリセットの仮の表示が
 * 変わる、つまみを動かしていない間の変更）なら、それより前の描画を無効にする
 */
function requestPaint(order: PaintOrder, stream: string, operating: boolean): number {
  const sequence = ++order.requested;
  if (order.stream !== stream) order.valid = sequence;
  order.stream = operating ? stream : null;
  return sequence;
}

/** 描き終えた要求を描いてよいか（無効にされておらず、すでに描いた画より新しい。描いた順を戻さない） */
function paintable(order: PaintOrder, sequence: number): boolean {
  return sequence >= order.valid && sequence > order.painted;
}

/**
 * 1 枚を開く（読み込みの世代・中止・作業コピーを待つ間の確かめ直し・URL で開く）と、開いた写真の描画・場所の切り替え。
 * 補正の状態（`developSettings`）と取り消しの履歴は `useBrowserPhotoEditSettings`、wasm の session と自動保存・離れるときの
 * 処理は {@link BrowserPhotoDevelop} が持つ。別の端末で直した補正の読み直し（版の照合 移行元設計）は `useBrowserPhotoDevelopReload`、
 * プリセット（当てる・替える・外すと、行に載せている間の仮の表示。F2b 移行元設計）は `useBrowserPhotoPresets`、切り抜きに合わせた
 * wasm の作業サイズ（F3 移行元設計）は `useBrowserPhotoWorkingSize`、切り抜きの道具（F3b 移行元設計）は `useBrowserPhotoCrop`。
 */
export function useBrowserPhotoOpen(params: {
  spotId: string;
  canEdit: boolean;
  openCloudPhotoId: string | null;
  onOpenCloudPhotoHandled: () => void;
  mountedRef: MutableRefObject<boolean>;
  latestAccessRef: MutableRefObject<BrowserPhotoAccess>;
  develop: BrowserPhotoDevelop;
  items: Pick<
    BrowserPhotoItems,
    "allItemsRef" | "place" | "setPlace" | "setSelectedKey" | "setDeepLinkedPhoto" | "clearFilter"
  >;
  refetchCloudPhotos: () => void;
  /** 一覧の行を今の写真に替える（別の端末で直した補正を読み直したとき） */
  replaceCloudPhoto: (photo: PhotoLibraryPhoto) => void;
  viewMode: BrowserViewMode;
  setViewMode: (viewMode: BrowserViewMode) => void;
  /** 切り抜きの道具を出す拠点か（受入まで拠点を絞るフラグ。`usePhotoEditingRollout(spotId).crop`） */
  cropRollout: boolean;
  /** 修復の道具（niho-photo#44）を出せる面か（PC の面だけ。スマホの層は false。省略は false） */
  healAllowed?: boolean;
  /** 1 枚で開くと補正の入力を読む（1024px 以上か、スマホで直せる拠点。F6c 移行元設計） */
  editingAllowed: boolean;
  /** 1 枚の canvas を置いている場所（PC の面かスマホの層）。替わったら canvas が付け替わるので、今の画を描き直す */
  canvasSurface: "page" | "layer";
  setExportSheetOpen: (open: boolean) => void;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  /** 書き出し・消している途中（その間はプリセットを当てない・仮に見せない） */
  busy: boolean;
  saveGenerationRef: MutableRefObject<number>;
  setStatus: (status: FooterStatus | null) => void;
  /**
   * wasm で描いた画を canvas に出した直後に、その canvas へ重ねる係（NIHO camera の背景除去。C4 移行元設計）。「補正前」と切り抜きの
   * 道具の枠全体の画には重ねない。`current` が null の間（web）は今までどおり描くだけ
   */
  framePostProcessRef?: MutableRefObject<((canvas: HTMLCanvasElement) => void) | null>;
  /**
   * wasm で描いた画を canvas に出した直後に、その画（写真の key と一緒）を渡す口（右パネルのヒストグラム。niho-photo#36）。
   * 「補正前」・切り抜きの道具の枠全体の画も、画面に出した画として渡す。`current` が null の間は今までどおり描くだけ。渡した画は
   * 読むだけで、書き換えない
   */
  onFramePaintedRef?: MutableRefObject<((key: string, frame: DevelopFrame) => void) | null>;
  /**
   * 補正前と補正後を見比べる間（niho-photo#41）の、補正前を描く 2 枚目の canvas（比較していない間は null）。描くのは「補正前」と
   * 同じ画（切り抜いた枠のまま色だけ補正前。`beforeFrameRef` に持つ）で、幾何・写真・入力が変わらない限り描き直さない（補正後の側を
   * 動かしても描き直さない）。重ねる係（`framePostProcessRef`）・ヒストグラムの口（`onFramePaintedRef`）には渡さない
   */
  compareCanvas?: HTMLCanvasElement | null;
}) {
  const {
    spotId,
    canEdit,
    openCloudPhotoId,
    onOpenCloudPhotoHandled,
    mountedRef,
    latestAccessRef,
    viewMode,
    setViewMode,
    editingAllowed,
    canvasSurface,
    setExportSheetOpen,
    canvasRef,
    operationRef,
    saveGenerationRef,
    setStatus,
    refetchCloudPhotos,
    replaceCloudPhoto,
  } = params;
  // 写真の出どころ（接続口 PhotoLibrary。作業コピーの準備・読み込み・再試行と、URL で開く写真。移行元設計）
  const library = usePhotoLibrary();
  const {
    engineRef,
    developUnavailable,
    developSessionRef,
    leavingRef,
    frameCacheRef,
    beforeFrameRef,
    readyDevelopEngine,
    startSession,
    rememberOpenedFrame,
    uploadOpenedEditedPreview,
    leaveEditing,
    createSaver,
    maskSurfaceSource,
    maskSurfacePhotoIdRef,
  } = params.develop;
  const { allItemsRef, place, setPlace, setSelectedKey, setDeepLinkedPhoto, clearFilter } = params.items;

  const [opened, setOpened] = useState<OpenedSource | null>(null);
  const openedRef = useRef<OpenedSource | null>(null);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const editResetHandlerRef = useRef<(() => void) | null>(null);
  const edit = useBrowserPhotoEditSettings({
    canEdit,
    openedRef,
    operationRef,
    leavingRef,
    developSessionRef,
    setCompareOriginal,
    editResetHandlerRef,
    setStatus,
  });

  const sourceContextFor = useCallback(
    (photo: Pick<PhotoLibraryPhoto, "id" | "developSettings">, transient?: DevelopSettings | null): PhotoLibraryDevelopSourceContext => {
      const saved = hasSavedDevelopSettings(photo);
      const draft = params.develop.draftRecovery.selectedDraft;
      const settings = transient ?? (draft?.photoId === photo.id ? draft.settings : readDevelopSettings(photo.developSettings));
      const base = settings && Object.hasOwn(settings, "base") ? settings.base : null;
      return {
        hasSavedDevelopSettings: saved,
        // draft が neutral でも「編集中」として旧 base:null を新規 signed へ読み替えない。
        hasDevelopEdits: draft?.photoId === photo.id || (settings !== null && !isNeutralDevelopSettings(settings)),
        baseVersion: typeof base === "string" ? base : null,
      };
    },
    [params.develop.draftRecovery.selectedDraft],
  );
  const {
    settings,
    settingsKey,
    savedSettingsKey,
    setSavedSettingsKey,
    dragging,
    setDragging,
    loadSettings,
    rebaseSettings,
    createProvisionalDraftWriter,
    startHistory,
    dropHistory,
  } = edit;
  // 切り抜きに合わせた wasm の作業サイズ（F3 移行元設計）。開き直せなかった写真は開き直しの経路に任せる（`openItem` は下で作る）
  const reopenRef = useRef<(key: string) => void>(() => undefined);
  const { ensureDevelopWorkingSize, workingEpoch } = useBrowserPhotoWorkingSize({
    mountedRef,
    develop: params.develop,
    reopenRef,
  });
  // プリセット（F2b 移行元設計）と切り抜きの道具（F3b 移行元設計）は、wasm で開いた写真を 1 枚で見ている間だけ使える
  const wasmPhotoKey = viewMode === "loupe" && opened?.mode === "wasm" ? opened.key : null;
  const presetsResetRef = useRef<(() => void) | null>(null);
  const cropResetRef = useRef<(() => void) | null>(null);
  // 「自動」（F4b 移行元設計）は面が `useBrowserPhotoAuto` で持ち、捨てる係だけここで分配する
  const autoResetRef = useRef<(() => void) | null>(null);
  const healResetRef = useRef<(() => void) | null>(null);
  const crop = useBrowserPhotoCrop({
    mountedRef,
    engineRef,
    developSessionRef,
    rollout: params.cropRollout,
    // F6c: mobileEditingAllowed の狭幅も PC と同じ切り抜き hook を使う。
    wide: editingAllowed,
    photoKey: wasmPhotoKey,
    settings,
    settingsKey,
    settingsRef: edit.settingsRef,
    commitEdit: edit.commitEdit,
    changeSettings: edit.changeSettings,
    setCompareOriginal,
    ensureDevelopWorkingSize,
    editResetHandlerRef: cropResetRef,
  });
  const cropActive = crop.active;
  const cropActiveRef = useRef(cropActive);
  cropActiveRef.current = cropActive;
  const cropSettling = crop.settling;
  // 修復の道具（niho-photo#44）。道具の間は、幾何を全部外した画を描く（ポインタの位置 = 印の座標）
  const heal = useBrowserPhotoHeal({
    mountedRef,
    engineRef,
    allowed: params.healAllowed === true && canEdit,
    photoKey: wasmPhotoKey,
    provisional: opened?.input?.kind === "provisional",
    settings,
    settingsRef: edit.settingsRef,
    commitEdit: edit.commitEdit,
    changeSettings: edit.changeSettings,
    setCompareOriginal,
    editResetHandlerRef: healResetRef,
  });
  const healActive = heal.active;
  const healActiveRef = useRef(healActive);
  healActiveRef.current = healActive;
  const healFramePainted = heal.framePainted;
  const presets = useBrowserPhotoPresets({
    mountedRef,
    engineRef,
    readyDevelopEngine,
    photoKey: wasmPhotoKey,
    // 切り抜きの間はプリセットを当てない・仮に見せない
    disabled: !canEdit || params.busy || params.develop.leaving || cropActive || cropSettling,
    settingsKey,
    settingsRef: edit.settingsRef,
    commitEdit: edit.commitEdit,
    dragging,
    compareOriginal,
    editResetHandlerRef: presetsResetRef,
    // マスクを持つプリセットは、切り抜きと同じ作業画像の大きさで写真の座標へ写す
    readSourceSize: async () => {
      const engine = engineRef.current;
      const session = developSessionRef.current;
      if (!engine || !session) return null;
      return (await readCropSource(engine, session))?.source ?? null;
    },
  });
  // 編集内容がまるごと入れ替わった・写真を離れたら、覚えているプリセット・「自動」を捨て、切り抜きの道具を閉じる
  editResetHandlerRef.current = () => {
    presetsResetRef.current?.();
    cropResetRef.current?.();
    autoResetRef.current?.();
    healResetRef.current?.();
  };
  const previewSettings = presets.previewSettings;
  const previewSettingsRef = useRef(previewSettings);
  previewSettingsRef.current = previewSettings;
  // 押して当てた結果の key（面の描画が 1 回だけ受け取り、先に粗い画を出す。#127）
  const coarseFirstKeyRef = presets.coarseFirstKeyRef;
  // 適用量を動かしている間の仮の表示は速い描き方（行に載せている間の仮の表示は丁寧に）
  const previewInteractive = presets.previewInteractive;
  // 補正のコピー / 貼り付け（F5a-2 移行元設計）も、wasm で開いた写真を 1 枚で見ている間だけ
  const clipboard = useBrowserPhotoSettingsClipboard({
    photoKey: viewMode === "loupe" && opened?.mode === "wasm" ? opened.key : null,
    disabled: !canEdit || params.busy || params.develop.leaving,
    settingsRef: edit.settingsRef,
    commitEdit: edit.commitEdit,
    setStatus,
  });
  const [opening, setOpening] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const openingKeyRef = useRef<string | null>(null);
  const timelineGenerationRef = useRef(0);
  const timelineRef = useRef<{
    key: string;
    generation: number;
    selectedAt: number;
    firstVisible: boolean;
    previewVisible: boolean;
    finalVisible: boolean;
    editingReady: boolean;
  } | null>(null);
  const startTimeline = useCallback((key: string, selectedAt: number) => {
    timelineRef.current = {
      key,
      generation: ++timelineGenerationRef.current,
      selectedAt,
      firstVisible: false,
      previewVisible: false,
      finalVisible: false,
      editingReady: false,
    };
  }, []);
  const recordAfterPaint = useCallback((
    key: string,
    generation: number | null,
    stage: "previewVisible" | "finalVisible",
    visibleElement?: HTMLElement,
  ) => {
    if (!photoDevelopDiagnosticsEnabled() || generation === null) return;
    if (timelineRef.current?.generation !== generation || timelineRef.current.key !== key) return;
    // onLoad / putImageData ではまだ画面に出たとは言えない。二度の rAF 後に可視状態を読む。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline || timeline.generation !== generation || timeline.key !== key ||
        (stage === "previewVisible" ? timeline.previewVisible : timeline.finalVisible)) return;
      if (visibleElement && (!visibleElement.isConnected || visibleElement.getClientRects().length === 0 ||
        getComputedStyle(visibleElement).visibility === "hidden")) return;
      timeline[stage] = true;
      const elapsedMs = Math.max(0, performance.now() - timeline.selectedAt);
      if (!timeline.firstVisible) {
        timeline.firstVisible = true;
        console.info("[photo-develop-ui-perf]", { stage: "firstVisible", elapsedMs });
      }
      console.info("[photo-develop-ui-perf]", { stage, elapsedMs });
      if (stage === "finalVisible") {
        console.info("[photo-develop-ui-perf]", { stage: "renderUpdated", elapsedMs });
        if (!timeline.editingReady) {
          timeline.editingReady = true;
          console.info("[photo-develop-ui-perf]", { stage: "editable", elapsedMs });
        }
      }
    }));
  }, []);
  const onPreviewLoaded = useCallback((key: string, generation: number | null, element: HTMLImageElement) => {
    recordAfterPaint(key, generation, "previewVisible", element);
  }, [recordAfterPaint]);
  const onPreviewFailed = useCallback((key: string, element: HTMLImageElement) => {
    const current = openedRef.current;
    if (current?.key !== key || !current.previewPending || !current.previewCurrent || current.viewUrl !== element.getAttribute("src")) return;
    const fallback = allItemsRef.current.find((item) => item.key === key)?.photo.previewUrl ?? null;
    const next = { ...current, previewCurrent: false, viewUrl: fallback === current.viewUrl ? null : fallback };
    openedRef.current = next;
    setOpened(next);
  }, [allItemsRef]);
  const recordProxyReady = useCallback((key: string) => {
    const timeline = timelineRef.current;
    if (timeline?.key !== key || !photoDevelopDiagnosticsEnabled()) return;
    console.info("[photo-develop-ui-perf]", {
      stage: "proxyReady",
      elapsedMs: Math.max(0, performance.now() - timeline.selectedAt),
    });
  }, []);
  // S1 の canvas だけが「書き出していない補正」を持つ（wasm は自動保存するので破棄の確認を出さない）
  const dirty = opened?.mode !== "wasm" && settingsKey !== savedSettingsKey;
  const compareOriginalRef = useRef(compareOriginal);
  compareOriginalRef.current = compareOriginal;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const editingAllowedRef = useRef(editingAllowed);
  editingAllowedRef.current = editingAllowed;
  /** 描いた順（{@link PaintOrder}） */
  const paintOrderRef = useRef<PaintOrder>({ generation: 0, requested: 0, painted: 0, valid: 0, stream: null });
  /** 開いた時点の Final 画と設定。古い補正後プレビューを直すアップロードはこの画から行う。 */
  const initialFrameRef = useRef<{ key: string; settingsJson: string; session: NonNullable<OpenResult["session"]> } | null>(null);
  /** 切り抜きの道具の間に描いた枠全体の画（同じ設定なら描き直さない。切り抜きを動かしても設定は変わらない） */
  const cropFrameCacheRef = useRef<{ key: string; settingsJson: string; epoch: number; frame: DevelopFrame } | null>(null);
  /** 修復の道具の間に描いた幾何なしの画（同じ設定なら描き直さない。niho-photo#44） */
  const healFrameCacheRef = useRef<{ key: string; settingsJson: string; epoch: number; frame: DevelopFrame } | null>(null);
  /**
   * 行に載せたプリセットの仮の表示の丁寧な画（押して当てた結果が同じ設定なら描き直さない。#127）。写真の入力の世代・作業サイズが
   * 変わったら使わない
   */
  const previewFrameCacheRef = useRef<
    { key: string; settingsJson: string; epoch: number; generation: number; frame: DevelopFrame } | null
  >(null);
  const framePostProcessRef = params.framePostProcessRef;
  const onFramePaintedRef = params.onFramePaintedRef;
  /**
   * 重ねる係（`framePostProcessRef`）がある間に最後に描いた画。背景除去の当て直し（背景・ブラシ）は wasm に描かせず、この画を
   * 描き直して重ね直す（{@link repaintLastFrame}）。`raw` は重ねない画（「補正前」・切り抜きの道具の枠全体）
   */
  const lastPaintRef = useRef<{ key: string; target: HTMLCanvasElement; frame: DevelopFrame; raw: boolean } | null>(null);
  /**
   * まだ wasm で描いていない（開いた直後のクラウドのプレビューを見せている）写真に、重ねるために 1 回描かせる写真の key
   * （{@link repaintLastFrame} が立てる）
   */
  const [forcedPaintKey, setForcedPaintKey] = useState<string | null>(null);
  /**
   * 描画が面を読めなかったマスク（M4 #68。マスクの面に理由を出す）と、読み直して描き直すための数。描けたら消す。描画は前の画のまま
   * （開いた直後だけ、読めないマスクを当てない 1 枚を描く。`browser-photo-mask-surface-render.ts`）
   */
  const [maskSurfaceIssue, setMaskSurfaceIssue] = useState<PhotoEditingMaskSurfaceIssue | null>(null);
  const [maskSurfaceRetry, setMaskSurfaceRetry] = useState(0);
  const reportMaskSurfaceIssue = useCallback(
    (photoKey: string, maskIds: readonly (string | null)[]) => {
      if (!mountedRef.current) return;
      const ids = maskIds.filter((id): id is string => id !== null);
      setMaskSurfaceIssue((current) => {
        const known = current?.photoKey === photoKey ? current.maskIds : [];
        const added = ids.filter((id) => !known.includes(id));
        if (current?.photoKey === photoKey && added.length === 0) return current;
        return { photoKey, maskIds: [...known, ...added] };
      });
    },
    [mountedRef],
  );
  const clearMaskSurfaceIssue = useCallback(
    (photoKey: string) => {
      if (mountedRef.current) setMaskSurfaceIssue((current) => (current?.photoKey === photoKey ? null : current));
    },
    [mountedRef],
  );
  const retryMaskSurfaces = useCallback(() => {
    engineRef.current?.retryMaskSurfaces?.();
    setMaskSurfaceIssue(null);
    setMaskSurfaceRetry((count) => count + 1);
  }, [engineRef]);

  const releaseOpened = useCallback(() => {
    openedRef.current?.decoded?.cleanup();
    openedRef.current = null;
    initialFrameRef.current = null;
    setOpened(null);
  }, []);

  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      openedRef.current?.decoded?.cleanup();
    },
    [],
  );

  // S1 の canvas は、編集内容のうち 5 つの値（露光量・コントラスト・彩度・相対の色温度 / 色かぶり補正）だけで描く
  useEffect(() => {
    if (!opened?.decoded || !canvasRef.current || viewMode !== "loupe") return;
    renderBrowserPhotoPreview(
      canvasRef.current,
      opened.decoded,
      readBrowserAdjustmentsFromDevelopSettings(settings),
      compareOriginal,
    );
    // `canvasSurface`: スマホの層 ⇄ PC の面で canvas が付け替わる（新しい canvas は空）ので、同じ写真・同じ補正でも描き直す
  }, [canvasRef, canvasSurface, compareOriginal, opened, settings, viewMode]);

  // 段 2 の wasm で描く（移行元設計）。古い描画の結果で新しい画を上書きしない（{@link PaintOrder}）。つまみを動かしている間は速い
  // 描き方で、描き終えた途中の画も順に描き（最新の要求だけを描くと、操作が描画より速い間は 1 枚も描けない）、離したら丁寧に 1 回
  // 描き直す（その丁寧な画が最後）。「補正前」は切り抜いた枠のまま色だけ補正前にした設定で描いて持つ（F3 移行元設計。幾何の無い
  // 写真は neutral そのもので、写真ごとに 1 回だけ描く）。プリセットを仮に見せている間（F2b 移行元設計）は、その編集内容を丁寧に
  // 描く（覚えている丁寧な画は今の編集内容のまま残し、離れたらすぐ戻せるようにする。適用量を動かしている間は速い描き方）。wasm の
  // 写真を開き直したら（`workingEpoch`）描き直す。切り抜きの道具の間（F3b 移行元設計）は、切り抜きと角度を外した枠全体を描く（枠と
  // 回転は画面が CSS で重ねるので、切り抜きを動かしても描き直さない）。「補正」に戻った直後は、作業サイズを合わせ終えてから
  // 切り抜いた画を描く
  useEffect(() => {
    const order = paintOrderRef.current;
    const activeOpened = openedRef.current;
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (viewMode !== "loupe" || !activeOpened || activeOpened.mode !== "wasm" || !canvas || !engine) {
      // 描かない間は流れを切る（戻った後の要求で、前の操作の途中の画を描かない）
      order.stream = null;
      return;
    }
    const key = activeOpened.key;
    const provisionalQuality = activeOpened.input?.kind === "provisional";
    const timelineGeneration = timelineRef.current?.generation ?? null;
    const paintGeneration = order.generation;
    /** 描画の流れ（同じ写真・同じ作業サイズの、同じ道具の画。つまみを動かしている間の続きの判定に使う） */
    const streamOf = (lane: "crop" | "heal" | "compare" | "settings" | "preview" | "applied") => `${lane}\n${workingEpoch}\n${key}`;
    const paint = (target: HTMLCanvasElement, frame: DevelopFrame, final: boolean, raw = false, keepSize = false) => {
      if (engineRef.current !== engine || order.generation !== paintGeneration) return;
      // 操作中の小さな画（色ポイント・マスクの 640px）は、今の canvas の大きさのまま描く（写真の大きさを跳ねさせない）
      paintDevelopFrame(target, frame, { keepSize });
      const postProcess = framePostProcessRef?.current ?? null;
      if (postProcess) {
        if (!raw) postProcess(target);
        lastPaintRef.current = { key, target, frame, raw };
      }
      onFramePaintedRef?.current?.(key, frame);
      const current = openedRef.current;
      if (current?.key === key && current.previewPending) {
        const next = { ...current, previewPending: false };
        openedRef.current = next;
        setOpened(next);
      }
      if (final) recordAfterPaint(key, timelineGeneration, "finalVisible", target);
    };
    const failInitial = (sequence: number) => {
      const current = openedRef.current;
      if (engineRef.current !== engine || order.generation !== paintGeneration ||
          sequence !== order.requested || current?.key !== key || !current.previewPending) return;
      const session = developSessionRef.current;
      initialFrameRef.current = null;
      const next: OpenedSource = { ...current, mode: null, lockedReason: DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE, previewPending: false };
      openedRef.current = next;
      setOpened(next);
      setSourceError("補正した写真を表示できませんでした。もう一度読み込んでください。");
      // 初回描画中に入力された補正は保存係へ渡し済み。保存を送り終えるまで session を捨てない。
      // 保存に失敗したら session を保持する。再読込ボタンは leaveEditing を再試行し、成功するまで開き直さない。
      void leaveEditing({ release: true }).then((left) => {
        if (!left || !mountedRef.current || openedRef.current?.key !== key) return;
        const saved = session?.saver?.getLastSaved();
        if (saved) setSavedSettingsKey(developSettingsKey(saved.settings));
      }).catch(() => undefined);
    };
    const uploadInitial = (settingsJson: string, frame: DevelopFrame) => {
      const initial = initialFrameRef.current;
      if (!initial || initial.key !== key || initial.settingsJson !== settingsJson || developSessionRef.current !== initial.session) return;
      initialFrameRef.current = null;
      uploadOpenedEditedPreview(initial.session, settings, frame);
    };
    if (cropActive) {
      const frameSettings = cropFrameDevelopSettings(settings);
      const frameJson = JSON.stringify(frameSettings);
      const cachedFrame = cropFrameCacheRef.current;
      if (cachedFrame?.key === key && cachedFrame.settingsJson === frameJson && cachedFrame.epoch === workingEpoch) {
        order.painted = invalidatePaints(order);
        paint(canvas, cachedFrame.frame, true, true);
        return;
      }
      const sequence = requestPaint(order, streamOf("crop"), dragging);
      // ジオメトリの節（遠近。niho-photo#46）のスライダーを動かしている間は速い描き方にし、その画は覚えない（離したら丁寧に描く）
      void engine
        .render(frameSettings, { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, interactive: provisionalQuality || dragging })
        .then((frame) => {
          if (!frame) return;
          if (engineRef.current !== engine || order.generation !== paintGeneration) return;
          if (openedRef.current?.key !== key || !cropActiveRef.current) return;
          if (!paintable(order, sequence) || !canvasRef.current) return;
          order.painted = sequence;
          if (!dragging) cropFrameCacheRef.current = { key, settingsJson: frameJson, epoch: workingEpoch, frame };
          paint(canvasRef.current, frame, !dragging, true);
        })
        .catch((error: unknown) => {
          // 面を読めないマスク: 前の画のまま、マスクの面に理由を出す
          if (error instanceof DevelopMaskSurfaceError) reportMaskSurfaceIssue(key, [error.maskId]);
          else failInitial(sequence);
        });
      return;
    }
    if (cropSettling) {
      order.stream = null;
      return;
    }
    if (healActive) {
      // 修復の道具の間（niho-photo#44）は幾何を全部外した画（色・修復の印は当てる）。重ねる係は当てない。描いた画に入っている印を
      // 道具に知らせる（まだ入っていない印は、写真の上で濃い赤のまま待つ）
      const frameSettings = healFrameDevelopSettings(settings);
      const frameJson = JSON.stringify(frameSettings);
      const cachedFrame = healFrameCacheRef.current;
      if (cachedFrame?.key === key && cachedFrame.settingsJson === frameJson && cachedFrame.epoch === workingEpoch) {
        order.painted = invalidatePaints(order);
        paint(canvas, cachedFrame.frame, true, true);
        healFramePainted(key, cachedFrame.frame, frameSettings);
        return;
      }
      const sequence = requestPaint(order, streamOf("heal"), dragging);
      // ブラシの大きさ・写し元を動かしている間は速い描き方にし、その画は覚えない（離したら丁寧に描く）
      void engine
        .render(frameSettings, { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, interactive: provisionalQuality || dragging })
        .then((frame) => {
          if (!frame) return;
          if (engineRef.current !== engine || order.generation !== paintGeneration) return;
          if (openedRef.current?.key !== key || !healActiveRef.current) return;
          if (!paintable(order, sequence) || !canvasRef.current) return;
          order.painted = sequence;
          if (!dragging) healFrameCacheRef.current = { key, settingsJson: frameJson, epoch: workingEpoch, frame };
          paint(canvasRef.current, frame, !dragging, true);
          healFramePainted(key, frame, frameSettings);
        })
        .catch(() => failInitial(sequence));
      return;
    }
    if (compareOriginal) {
      const beforeSettings = compareBeforeDevelopSettings(settings, developBaseVersion(activeOpened.input));
      const beforeJson = JSON.stringify(beforeSettings);
      const before = beforeFrameRef.current;
      if (before?.key === key && before.settingsJson === beforeJson) {
        order.painted = invalidatePaints(order);
        paint(canvas, before.frame, true, true);
        return;
      }
      // 押している間に動かすつまみは無い（続きの流れを作らない。押す前の途中の画は描かない）
      const sequence = requestPaint(order, streamOf("compare"), false);
      void engine
        .render(beforeSettings, { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, interactive: provisionalQuality })
        .then((frame) => {
          if (!frame) return;
          if (engineRef.current !== engine || order.generation !== paintGeneration) return;
          if (openedRef.current?.key !== key) return;
          beforeFrameRef.current = { key, settingsJson: beforeJson, frame };
          if (!compareOriginalRef.current || cropActiveRef.current) return;
          if (!paintable(order, sequence) || !canvasRef.current) return;
          order.painted = sequence;
          paint(canvasRef.current, frame, true, true);
        })
        .catch(() => failInitial(sequence));
      return;
    }
    const shownSettings = previewSettings ?? settings;
    const settingsJson = JSON.stringify(shownSettings);
    const previewing = previewSettings !== null;
    // 押して当てた結果か（1 回だけ受け取る。覚えている画を描くときも受け取って、後から戻したときに粗い画を出さない）
    const coarseKey = coarseFirstKeyRef.current;
    const appliedPreset = !previewing && coarseKey !== null && coarseKey === developSettingsKey(shownSettings);
    if (appliedPreset) coarseFirstKeyRef.current = null;
    const initial = initialFrameRef.current;
    // 保存済みの同じ版の画は Final 由来。開くだけで原寸 RAW を再計算せず、操作時に必要な画だけ描く。
    // 重ねる係が描かせた（`forcedPaintKey`）写真は、クラウドのプレビューのままにせず描く（背景除去を重ねる）
    if (activeOpened.previewPending && activeOpened.previewCurrent && !previewing &&
      initial?.key === key && initial.settingsJson === settingsJson && forcedPaintKey !== key) {
      invalidatePaints(order); // 変更を元に戻したとき、進行中の古い描画を画面へ出さない。
      return;
    }
    const cached = frameCacheRef.current;
    // 同じ設定の丁寧な画があれば描き直さない（つまみを押しただけ・離しただけのとき）
    if (cached?.key === key && cached.settingsJson === settingsJson) {
      order.painted = invalidatePaints(order);
      paint(canvas, cached.frame, true);
      return;
    }
    // 行に載せて描いた丁寧な画と同じ設定（載せてから押した）なら描き直さない（#127）
    const cachedPreview = previewFrameCacheRef.current;
    if (
      cachedPreview?.key === key &&
      cachedPreview.settingsJson === settingsJson &&
      cachedPreview.epoch === workingEpoch &&
      cachedPreview.generation === paintGeneration
    ) {
      order.painted = invalidatePaints(order);
      if (!previewing) frameCacheRef.current = { key, settingsJson, frame: cachedPreview.frame };
      paint(canvas, cachedPreview.frame, true);
      return;
    }
    const interactive = provisionalQuality || (previewing ? previewInteractive : dragging);
    // Point selections stay exact while dragging; only the temporary preview of an operation (a slider / handle drag,
    // an interactive preset preview) is smaller with active color points or masks, painted at the canvas' current size.
    // Final render, provisional-quality display, sampling, saved previews and export keep their size.
    const operating = previewing ? previewInteractive : dragging;
    /** 今の設定（仮の表示を含む）を描いて、まだ描いてよければ出す（丁寧な画は覚える）。 */
    const renderShown = (sequence: number) => {
      if (engineRef.current !== engine || order.generation !== paintGeneration) return;
      // 粗い画を待つ間に、載せていた仮の表示の丁寧な画が届いていれば（載せてから押した）描き直さない（#127）
      const preview = previewFrameCacheRef.current;
      if (!previewing && preview?.key === key && preview.settingsJson === settingsJson && preview.epoch === workingEpoch &&
        preview.generation === paintGeneration) {
        frameCacheRef.current = { key, settingsJson, frame: preview.frame };
        if (!paintable(order, sequence) || !canvasRef.current) return;
        order.painted = sequence;
        paint(canvasRef.current, preview.frame, true);
        return;
      }
      const maxDimension = operating ? developInteractiveMaxDimension(shownSettings) : DEVELOP_PREVIEW_MAX_DIMENSION;
      const renderRequestedAt = photoDevelopDiagnosticsEnabled() ? performance.now() : null;
      void engine
        .render(shownSettings, { maxDimension, interactive })
        .then((frame) => {
          if (!frame) return;
          if (engineRef.current !== engine || order.generation !== paintGeneration) return;
          clearMaskSurfaceIssue(key);
          if (!interactive && !previewing) uploadInitial(settingsJson, frame);
          // 載せた仮の表示の丁寧な画は、もう出さなくても覚える（押した結果が同じなら描き直さない。#127）
          if (!interactive && previewing) {
            previewFrameCacheRef.current = { key, settingsJson, epoch: workingEpoch, generation: paintGeneration, frame };
          }
          if (openedRef.current?.key !== key || compareOriginalRef.current || cropActiveRef.current || healActiveRef.current) return;
          if (!paintable(order, sequence) || !canvasRef.current) return;
          const paintedCanvas = canvasRef.current;
          order.painted = sequence;
          if (!interactive && !previewing) frameCacheRef.current = { key, settingsJson, frame };
          paint(paintedCanvas, frame, (provisionalQuality || !interactive) && !previewing, false, maxDimension < DEVELOP_PREVIEW_MAX_DIMENSION);
          if (renderRequestedAt !== null) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (engineRef.current !== engine || order.generation !== paintGeneration ||
                openedRef.current?.key !== key || order.requested !== sequence || viewModeRef.current !== "loupe" ||
                canvasRef.current !== paintedCanvas || !paintedCanvas.isConnected ||
                paintedCanvas.getClientRects().length === 0 || getComputedStyle(paintedCanvas).visibility === "hidden") return;
              console.info("[photo-develop-ui-perf]", {
                stage: previewing ? "presetRenderVisible" : interactive ? "interactiveRenderVisible" : "finalRenderVisible",
                durationMs: Math.max(0, performance.now() - renderRequestedAt),
              });
            }));
          }
        })
        .catch((error: unknown) => {
          if (!(error instanceof DevelopMaskSurfaceError)) {
            failInitial(sequence);
            return;
          }
          // 面を読めないマスク（M4 #68）: 黙って外して描かない。前の画のまま、マスクの面に理由を出す（読み直せる）
          reportMaskSurfaceIssue(key, [error.maskId]);
          const current = openedRef.current;
          if (current?.key !== key || !current.previewPending) return;
          // 開いた直後でまだ wasm の画が無い: 写真の編集を止めないよう、読めないマスクを当てない 1 枚を描く（覚えない・上げない）
          void renderDevelopWithoutUnreadableMasks(engine, shownSettings, { maxDimension, interactive }, error).then(
            ({ frame, maskIds }) => {
              reportMaskSurfaceIssue(key, maskIds);
              if (!frame) return;
              if (engineRef.current !== engine || order.generation !== paintGeneration) return;
              if (openedRef.current?.key !== key || compareOriginalRef.current || cropActiveRef.current) return;
              if (sequence !== order.requested || !canvasRef.current) return;
              order.painted = sequence;
              paint(canvasRef.current, frame, true);
            },
            () => failInitial(sequence),
          );
        });
    };
    // 押して当てた結果・行に載せた仮の表示は、先に粗い画（速い描き方）を出してから丁寧な画に差し替える（#127。丁寧な画は今と
    // 同じ）。押した結果は粗い画を描き終えてから丁寧な画を出す（Worker は 1 本で、同じ枠の「次」は 1 つなので、続けて出すと粗い画が
    // 捨てられる）。載せた仮の表示は止まって {@link BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS} たってから丁寧な画
    const coarseFirst = !interactive && (previewing || appliedPreset);
    const stream = streamOf(previewing ? "preview" : appliedPreset ? "applied" : "settings");
    let coarse: Promise<void> = Promise.resolve();
    if (coarseFirst) {
      const coarseMaxDimension = developInteractiveMaxDimension(shownSettings);
      // 押した結果の粗い画は丁寧な画と同じ流れ（丁寧な画の要求で消さない）。仮の表示は前の仮の表示の画を描かない
      const coarseSequence = requestPaint(order, stream, appliedPreset);
      coarse = engine.render(shownSettings, { maxDimension: coarseMaxDimension, interactive: true }).then(
        (frame) => {
          if (!frame) return;
          if (engineRef.current !== engine || order.generation !== paintGeneration) return;
          if (openedRef.current?.key !== key || compareOriginalRef.current || cropActiveRef.current || healActiveRef.current) return;
          if (!paintable(order, coarseSequence) || !canvasRef.current) return;
          order.painted = coarseSequence;
          paint(canvasRef.current, frame, false, false, coarseMaxDimension < DEVELOP_PREVIEW_MAX_DIMENSION);
        },
        () => undefined,
      );
    }
    if (previewing && coarseFirst) {
      let live = true;
      const timer = setTimeout(() => {
        void coarse.then(() => {
          if (live) renderShown(requestPaint(order, stream, false));
        });
      }, BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS);
      return () => {
        live = false;
        clearTimeout(timer);
      };
    }
    // 補正のつまみ・適用量を動かしている間（と離した直後の丁寧な 1 枚）は、描き終えた途中の画も描く。行に載せただけの仮の表示は
    // つまみの流れではない（前の仮の表示・補正の途中の画を描かない）
    const sequence = requestPaint(order, stream, operating);
    if (!coarseFirst) {
      renderShown(sequence);
      return;
    }
    void coarse.then(() => {
      // 粗い画を待つ間に新しい要求が来たら、この丁寧な画は出さない（新しい要求が描く）
      if (order.requested === sequence) renderShown(sequence);
    });
    // `canvasSurface`: canvas が付け替わったら描き直す（同じ設定の丁寧な画が残っていれば、それをそのまま描く）
  }, [
    beforeFrameRef,
    canvasRef,
    canvasSurface,
    coarseFirstKeyRef,
    compareOriginal,
    cropActive,
    cropSettling,
    dragging,
    engineRef,
    developSessionRef,
    mountedRef,
    forcedPaintKey,
    healActive,
    healFramePainted,
    framePostProcessRef,
    frameCacheRef,
    onFramePaintedRef,
    opened?.key,
    opened?.mode,
    opened?.input,
    opened?.previewCurrent,
    previewInteractive,
    recordAfterPaint,
    previewSettings,
    settings,
    setSavedSettingsKey,
    leaveEditing,
    uploadOpenedEditedPreview,
    viewMode,
    workingEpoch,
    // 面を読めなかったマスクを読み直す（`retryMaskSurfaces`）
    maskSurfaceRetry,
    reportMaskSurfaceIssue,
    clearMaskSurfaceIssue,
  ]);

  // 補正前と補正後を見比べる間（niho-photo#41）は、補正前の画を 2 枚目の canvas（`compareCanvas`）に描く。「補正前」（押している
  // 間）と同じ画・同じ置き場（`beforeFrameRef`）を使い、幾何・写真・入力（段階 open の canonical 差し替え・作業サイズの開き直し）が
  // 変わったときだけ描き直す（色の補正を動かしても描き直さない）。編集の描画の「次」を取り合わないよう、優先度は background
  // （編集の描画が空いてから 1 回）。補正後の canvas・重ねる係・ヒストグラムの口には触れない。S1 の canvas は補正を外して描く
  const compareCanvas = params.compareCanvas ?? null;
  const compareBeforeSettings = useMemo(
    () =>
      compareCanvas && opened?.mode === "wasm"
        ? compareBeforeDevelopSettings(settings, developBaseVersion(opened.input))
        : null,
    [compareCanvas, opened?.input, opened?.mode, settings],
  );
  const compareBeforeJson = compareBeforeSettings ? JSON.stringify(compareBeforeSettings) : null;
  const compareBeforeSettingsRef = useRef(compareBeforeSettings);
  compareBeforeSettingsRef.current = compareBeforeSettings;
  useEffect(() => {
    const target = compareCanvas;
    const activeOpened = openedRef.current;
    if (!target || viewMode !== "loupe" || !activeOpened || cropActive || cropSettling) return;
    if (activeOpened.decoded) {
      renderBrowserPhotoPreview(target, activeOpened.decoded, readBrowserAdjustmentsFromDevelopSettings(null), true);
      return;
    }
    const beforeSettings = compareBeforeSettingsRef.current;
    const engine = engineRef.current;
    if (activeOpened.mode !== "wasm" || !engine || !beforeSettings || compareBeforeJson === null) return;
    const key = activeOpened.key;
    const cached = beforeFrameRef.current;
    if (cached?.key === key && cached.settingsJson === compareBeforeJson) {
      paintDevelopFrame(target, cached.frame);
      return;
    }
    let current = true;
    void engine
      .render(beforeSettings, {
        maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION,
        interactive: activeOpened.input?.kind === "provisional",
        priority: "background",
      })
      .then((frame) => {
        if (!frame || !current || engineRef.current !== engine || openedRef.current?.key !== key) return;
        beforeFrameRef.current = { key, settingsJson: compareBeforeJson, frame };
        paintDevelopFrame(target, frame);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
    // `opened` の key・入力・S1 の画と `workingEpoch`: 写真・canonical 差し替え・作業サイズの開き直しで描き直す
  }, [
    beforeFrameRef,
    compareBeforeJson,
    compareCanvas,
    cropActive,
    cropSettling,
    engineRef,
    opened?.decoded,
    opened?.input,
    opened?.key,
    opened?.mode,
    viewMode,
    workingEpoch,
  ]);

  /**
   * 最後に描いた画を、wasm に描かせずに描き直して重ね直す（背景除去の背景・ブラシ・被写体を変えたとき。C4 移行元設計）。1 枚で見ている
   * wasm の写真の、今の canvas に描いた画だけ。まだ wasm で描いていない（クラウドのプレビューを見せている）なら 1 回描かせる。
   */
  const repaintLastFrame = useCallback(() => {
    const current = openedRef.current;
    if (viewModeRef.current !== "loupe" || !current || current.mode !== "wasm") return;
    const last = lastPaintRef.current;
    if (last && last.key === current.key && last.target === canvasRef.current) {
      paintDevelopFrame(last.target, last.frame);
      if (!last.raw) framePostProcessRef?.current?.(last.target);
      return;
    }
    if (current.previewPending) setForcedPaintKey(current.key);
  }, [canvasRef, framePostProcessRef]);

  const confirmSourceSwitch = useCallback(async (): Promise<boolean> => {
    if (operationRef.current) return false;
    if (!dirty) return true;
    const saveGeneration = saveGenerationRef.current;
    const confirmed = await appDialog.confirm({
      title: "補正を破棄して写真を切り替えますか？",
      description: DISCARD_DESCRIPTION,
      confirmLabel: "破棄して切り替え",
      variant: "danger",
    });
    return confirmed && operationRef.current === null && saveGeneration === saveGenerationRef.current;
  }, [dirty, operationRef, saveGenerationRef]);

  const abortOpening = useCallback(() => {
    if (openingKeyRef.current === null) return;
    loadGenerationRef.current += 1;
    timelineRef.current = null;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    openingKeyRef.current = null;
    setOpening(false);
  }, []);

  /** 開いた写真を手放し、補正の値を neutral に戻す（場所を変えた・消したとき。取り消しの履歴も捨てる）。 */
  const clearOpened = () => {
    releaseOpened();
    timelineRef.current = null;
    loadSettings(neutralDevelopSettings(), { history: false });
    setCompareOriginal(false);
  };

  /**
   * 開いた結果を画面に出す（wasm で直すなら、その編集も）。取り消しの履歴は開いたときの編集内容から始める。
   * 保存済みの補正後プレビューが無い・古い写真は、最初の Final 描画ができたときに上げ直す（K3 移行元設計）。
   */
  const commitOpenResult = useCallback(
    (result: OpenResult) => {
      const next = result.opened;
      openedRef.current = next;
      setOpened(next);
      if (result.session) {
        const timeline = timelineRef.current;
        if (timeline?.key === next.key && photoDevelopDiagnosticsEnabled()) {
          console.info("[photo-develop-ui-perf]", {
            stage: "inputAccepted",
            elapsedMs: Math.max(0, performance.now() - timeline.selectedAt),
          });
        }
        initialFrameRef.current = { key: next.key, settingsJson: JSON.stringify(result.settings), session: result.session };
        startSession(result.session);
      } else {
        initialFrameRef.current = null;
      }
      // 開いたときの値は保存しない（書き出していない補正として数えない）
      loadSettings(result.settings, { history: true });
    },
    [loadSettings, startSession],
  );

  /** provisional frameまで描けたときだけ編集可能にする。canonical save/upload/exportへ通す saver はまだ持たない。 */
  const commitProvisional = useCallback(
    (
      item: BrowserItem,
      preview: Awaited<ReturnType<NonNullable<typeof library.loadInteractivePreview>>>,
      provisionalSettings: DevelopSettings,
      frame: DevelopFrame,
      draft: Awaited<ReturnType<NonNullable<typeof library.loadProvisionalDraft>>> | null,
    ) => {
      const input = {
        kind: "provisional" as const,
        file: preview.file,
        contentSha256: preview.photo.contentSha256,
        width: preview.width,
        height: preview.height,
      };
      rememberOpenedFrame(item.key, provisionalSettings, frame);
      commitOpenResult({
        opened: {
          key: item.key,
          fileName: item.photo.fileName,
          decoded: null,
          viewUrl: item.photo.previewUrl ?? item.localPreviewUrl,
          previewPending: true,
          previewCurrent: false,
          lockedReason: null,
          loadedForEditing: true,
          mode: "wasm",
          input,
          canonicalPending: true,
          work: { phase: "opening" },
          photo: preview.photo,
        },
        session: {
          key: item.key,
          photoId: item.photo.id,
          spotId,
          input,
          working: null,
          workSize: { width: preview.width, height: preview.height },
          photo: preview.photo,
          settingsSource: preview.photo.hasDevelopSettings ? "develop" : "none",
          saver: null,
          provisionalDraft: createProvisionalDraftWriter(
            item.photo.id,
            preview.photo.contentSha256,
            draft,
          ),
        },
        settings: provisionalSettings,
      });
      setOpening(false);
    },
    [commitOpenResult, createProvisionalDraftWriter, rememberOpenedFrame, spotId],
  );

  /** 別engineでcanonicalの最新設定を描き終えてから、画・engine・sessionを一度に差し替える。 */
  const handoffCanonical = useCallback(async (
    item: BrowserItem,
    result: OpenResult,
    canonicalEngine: DevelopEngine,
    isStale: () => boolean,
  ): Promise<boolean> => {
    const provisional = openedRef.current;
    const candidateSession = result.session;
    const discardCandidate = () => {
      candidateSession?.saver?.dispose();
      canonicalEngine.dispose();
    };
    if (isStale() || provisional?.key !== item.key || provisional.input?.kind !== "provisional" || !result.session) {
      discardCandidate();
      return false;
    }
    const provisionalSession = developSessionRef.current;
    if (provisionalSession?.key !== item.key || provisionalSession.input.kind !== "provisional") {
      discardCandidate();
      return false;
    }
    const provisionalContentSha256 = provisional.input.contentSha256;
    const isCurrentProvisional = () => {
      const current = openedRef.current;
      return !isStale() && current?.key === item.key && current.input?.kind === "provisional" &&
        developSessionRef.current === provisionalSession;
    };
    type HandoffDisplay = {
      kind: "settings" | "preview" | "compare" | "crop";
      settings: DevelopSettings;
    };
    const currentDisplay = (source: DevelopSettings): HandoffDisplay => {
      if (cropActiveRef.current) {
        return {
          kind: "crop",
          settings: rebindDevelopSettings(cropFrameDevelopSettings(source), result.settings),
        };
      }
      if (compareOriginalRef.current) {
        const rebound = rebindDevelopSettings(source, result.settings);
        return {
          kind: "compare",
          settings: compareBeforeDevelopSettings(rebound, developBaseVersion(result.opened.input)),
        };
      }
      const preview = previewSettingsRef.current;
      return {
        kind: preview ? "preview" : "settings",
        settings: rebindDevelopSettings(preview ?? source, result.settings),
      };
    };
    let frame: DevelopFrame;
    let flushedDraft: PhotoLibraryProvisionalDraft | null;
    try {
      flushedDraft = await provisionalSession.provisionalDraft?.flush() ?? null;
    } catch {
      discardCandidate();
      return false;
    }
    if (!isCurrentProvisional()) {
      discardCandidate();
      return false;
    }
    let source = edit.settingsRef.current;
    let display = currentDisplay(source);
    /** 面を読めないマスクを当てずに描いた画（その設定の画として覚えない） */
    let surfaceFallback = false;
    // 描画中に操作が進んだら最新値で描き直す。swap前なのでprovisional frameはそのまま見える。
    for (;;) {
      surfaceFallback = false;
      // metadataを替える前に、既に受け付けたpreset/量/hoverの結果を旧sessionへ反映する。
      await presets.waitForPending();
      if (!isCurrentProvisional()) { discardCandidate(); return false; }
      source = edit.settingsRef.current;
      display = currentDisplay(source);
      const renderOptions = { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, interactive: false };
      const displayed = display.settings;
      const rendered = await canonicalEngine.render(displayed, renderOptions).catch(async (error: unknown) => {
        // 面を読めないマスク（M4 #68）: 高画質表示への切り替えは止めず、読めないマスクを当てない画にする（覚えない。理由を出す）
        if (!(error instanceof DevelopMaskSurfaceError)) return null;
        const fallback = await renderDevelopWithoutUnreadableMasks(canonicalEngine, displayed, renderOptions, error).catch(() => null);
        if (fallback) reportMaskSurfaceIssue(item.key, fallback.maskIds);
        surfaceFallback = fallback?.frame != null;
        return fallback?.frame ?? null;
      });
      if (!rendered || !isCurrentProvisional()) {
        discardCandidate();
        return false;
      }
      frame = rendered;
      let latestDraft: PhotoLibraryProvisionalDraft | null;
      try {
        latestDraft = await provisionalSession.provisionalDraft?.flush() ?? flushedDraft;
      } catch {
        discardCandidate();
        return false;
      }
      if (!isCurrentProvisional()) {
        discardCandidate();
        return false;
      }
      // flush中に新しい非同期preset入力が来たら、確定とdraft保存を待ってから描き直す。
      if (presets.hasPending()) continue;
      // flush 待機中にも入力・crop・比較・preset preview は変わり得る。最後の await の後で画面の値を取り直す。
      const latest = edit.settingsRef.current;
      const latestDisplay = currentDisplay(latest);
      if (sameDevelopSettings(latest, source) && latestDisplay.kind === display.kind &&
          sameDevelopSettings(latestDisplay.settings, display.settings)) {
        flushedDraft = latestDraft;
        break;
      }
      source = latest;
      display = latestDisplay;
      flushedDraft = latestDraft;
    }
    // ここから swap までは await を置かない。上の一致確認と別の画を組み合わせない。
    const oldEngine = engineRef.current;
    const paintOrder = paintOrderRef.current;
    paintOrder.generation += 1;
    paintOrder.painted = invalidatePaints(paintOrder);
    engineRef.current = canonicalEngine;
    const nextSettings = rebaseSettings((value) => rebindDevelopSettings(value, result.settings));
    presets.rebaseSettings((value) => rebindDevelopSettings(value, result.settings));
    frameCacheRef.current = null;
    beforeFrameRef.current = null;
    cropFrameCacheRef.current = null;
    lastPaintRef.current = null;
    if (surfaceFallback) {
      // 読めないマスクを当てずに描いた画は覚えない（面を読み直したら描き直す）
    } else if (display.kind === "settings") {
      frameCacheRef.current = { key: item.key, settingsJson: JSON.stringify(nextSettings), frame };
    } else if (display.kind === "compare") {
      beforeFrameRef.current = { key: item.key, settingsJson: JSON.stringify(display.settings), frame };
    } else if (display.kind === "crop") {
      cropFrameCacheRef.current = {
        key: item.key,
        settingsJson: JSON.stringify(display.settings),
        epoch: workingEpoch,
        frame,
      };
    }
    const target = canvasRef.current;
    if (target) {
      paintDevelopFrame(target, frame);
      const raw = display.kind === "crop" || display.kind === "compare";
      const postProcess = framePostProcessRef?.current ?? null;
      if (postProcess) {
        if (!raw) postProcess(target);
        lastPaintRef.current = { key: item.key, target, frame, raw };
      }
      onFramePaintedRef?.current?.(item.key, frame);
    }
    const nextOpened: OpenedSource = {
      ...result.opened,
      previewPending: false,
      canonicalPending: false,
      work: null,
    };
    openedRef.current = nextOpened;
    setOpened(nextOpened);
    initialFrameRef.current = null;
    result.session.saver?.dispose();
    result.session.saver = latestAccessRef.current.canEdit
      ? createSaver(
          result.session.spotId,
          result.session.photoId,
          result.session.photo.developRevision,
          provisionalContentSha256,
          flushedDraft?.generation,
        )
      : null;
    startSession(result.session);
    if (!sameDevelopSettings(nextSettings, result.settings)) {
      result.session.saver?.schedule(nextSettings);
    } else if (flushedDraft && library.removeProvisionalDraft) {
      void library
        .removeProvisionalDraft(item.photo.id, provisionalContentSha256, flushedDraft.generation)
        .catch(() => undefined);
    }
    oldEngine?.dispose();
    setSourceError(null);
    setOpening(false);
    const timeline = timelineRef.current;
    if (timeline?.key === item.key && photoDevelopDiagnosticsEnabled()) {
      console.info("[photo-develop-ui-perf]", {
        stage: "canonicalReady",
        elapsedMs: Math.max(0, performance.now() - timeline.selectedAt),
      });
    }
    return true;
  }, [beforeFrameRef, canvasRef, createSaver, developSessionRef, edit.settingsRef, engineRef, frameCacheRef, framePostProcessRef, latestAccessRef, library, onFramePaintedRef, presets, rebaseSettings, reportMaskSurfaceIssue, startSession, workingEpoch]);

  /** 作業コピーを待っている写真の状態を変える（その写真を開いたまま待っているときだけ）。 */
  const setWorkWait = useCallback((key: string, work: WorkWait) => {
    const current = openedRef.current;
    if (!current || current.key !== key || current.work === null) return;
    const next: OpenedSource = { ...current, work };
    openedRef.current = next;
    setOpened(next);
  }, []);

  /**
   * 作業コピーの結果を画面に出す（まだ待つなら状態だけ変える）。開いただけでは記事用の画像を作らない（K3 移行元設計。記事制作の
   * 画像ライブラリに出す RAW なども、記事に入れる・サムネイルにするときに描く）。
   */
  const applyWorkOutcome = (key: string, outcome: WorkOutcome) => {
    if (outcome.kind === "wait") {
      setWorkWait(key, outcome.work);
      return;
    }
    commitOpenResult(outcome.result);
  };

  // 開く流れは、呼ぶときの最新（拠点・権限）を使う
  const openFlowContext: BrowserPhotoOpenFlowContext = {
    spotId,
    library,
    canEdit: () => latestAccessRef.current.canEdit,
    createSaver,
    rememberOpenedFrame,
  };
  const openFlowRef = useRef({ context: openFlowContext, applyWorkOutcome });
  openFlowRef.current = { context: openFlowContext, applyWorkOutcome };

  const openItem = useCallback(
    async (item: BrowserItem, options: { reload?: boolean } = {}) => {
      if (operationRef.current || item.adding) return;
      setExportSheetOpen(false);
      if (openedRef.current?.key === item.key && !options.reload) {
        const current = openedRef.current;
        const shouldLoadEditorSource = !current.loadedForEditing && editingAllowedRef.current;
        if (!shouldLoadEditorSource) {
          if (viewModeRef.current !== "loupe" && photoDevelopDiagnosticsEnabled()) {
            startTimeline(item.key, performance.now());
          }
          const session = developSessionRef.current;
          if (session?.key === item.key) uploadOpenedEditedPreview(session, settings);
          setSelectedKey(item.key);
          // 一覧から戻ったら、取り消しの履歴は今の編集内容から始める（1 枚で見ている間は続ける）
          if (viewModeRef.current !== "loupe") startHistory();
          setViewMode("loupe");
          return;
        }
      }
      timelineRef.current = null;
      const selectedAt = photoDevelopDiagnosticsEnabled() ? performance.now() : null;
      // 直している写真の保存を送り終えてから離れる（補正後のプレビューは上げ始めるだけ。保存できなければ開かない）
      if (!(await leaveEditing({ release: true }))) {
        setSelectedKey(openedRef.current?.key ?? null);
        return;
      }
      if (!(await confirmSourceSwitch())) {
        setSelectedKey(openedRef.current?.key ?? null);
        return;
      }
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      if (selectedAt !== null) startTimeline(item.key, selectedAt);
      loadAbortRef.current?.abort();
      const abort = new AbortController();
      loadAbortRef.current = abort;
      openingKeyRef.current = item.key;
      // 面のマスク（M4 #68）の面は、session ができる前の仮の描画からこの写真の置き場で読む
      maskSurfacePhotoIdRef.current = item.photo.id;
      setSelectedKey(item.key);
      setViewMode("loupe");
      setOpening(true);
      setSourceError(null);
      loadSettings(neutralDevelopSettings(), { history: false });
      setCompareOriginal(false);
      releaseOpened();
      const isStale = () => abort.signal.aborted || generation !== loadGenerationRef.current;
      // 写真を替えたら、Wasm の起動と並行して始めた読み込みも止める。
      const workAbort = new AbortController();
      const abortWork = () => workAbort.abort();
      abort.signal.addEventListener("abort", abortWork, { once: true });
      const previewAbort = new AbortController();
      const abortPreview = () => previewAbort.abort();
      abort.signal.addEventListener("abort", abortPreview, { once: true });
      try {
        const allowEditing = editingAllowedRef.current;
        // 作業コピーで直す写真（RAW など。移行元設計）は、開いた瞬間はクラウドのプレビューを見せる（揃ったら 1 回だけ差し替える）
        const showWorkPreview = () => {
          const preview = workPreviewOpened(item);
          openedRef.current = preview;
          setOpened(preview);
        };
        const workTarget = allowEditing && isDevelopWorkTarget(item.photo);
        if (workTarget) showWorkPreview();
        // 署名付き URL の取得と作業コピーの読み込みを、初回の Wasm 起動と重ねる。
        // 失敗は使用時に投げ直し、起動不可・写真切替時にも未処理の rejection を残さない。
        const pendingWork = workTarget && !developUnavailable
          ? library.ensureWorkingCopy(item.photo.id, {
              signal: workAbort.signal,
              sourceContext: sourceContextFor(item.photo),
            }).then((result) => {
              const copy = result.kind === "ready"
                ? library.loadWorkingCopy(item.photo.id, result.download, { signal: workAbort.signal })
                : null;
              void copy?.catch(() => undefined);
              return { result, copy };
            })
          : null;
        void pendingWork?.catch(() => undefined);
        const pendingPreview = workTarget && library.loadInteractivePreview
          ? library.loadInteractivePreview(item.photo.id, {
              signal: previewAbort.signal,
              maxDimension: 1600,
            })
          : null;
        const previewDeadlineAt = pendingPreview ? performance.now() + 1_950 : null;
        void pendingPreview?.catch(() => undefined);
        // 段 2 の wasm を使えるかを先に確かめる（使えればどちらの補正も描けるので、入力を読む前に閉じない）。開く前から閉じると
        // 分かる写真（記事の画像など）では起こさない
        const engine =
          allowEditing && (workTarget || browserCloudLockedReason(item.photo) === null) ? await readyDevelopEngine() : null;
        if (isStale()) return;
        if (!engine) workAbort.abort();
        // 作業コピーを確かめ、揃っていれば読んで wasm で開く（まだなら「現像の準備中」で待つ）
        const openWork = async (
          readyEngine: DevelopEngine,
          prepared?: Promise<{ result: PhotoLibraryWorkingCopyResult; copy: Promise<PhotoLibraryWorkingCopy> | null }>,
          atomicHandoff = false,
        ): Promise<WorkOutcome | "stale"> => {
          const { result: work, copy } = prepared
            ? await prepared
            : {
                result: await library.ensureWorkingCopy(item.photo.id, {
                  signal: abort.signal,
                  sourceContext: sourceContextFor(item.photo),
                }),
                copy: null,
              };
          if (isStale()) return "stale";
          const context = atomicHandoff
            ? { ...openFlowRef.current.context, rememberOpenedFrame: () => undefined }
            : openFlowRef.current.context;
          const outcome = await resolveWorkOutcome(context, item, work, readyEngine, abort.signal, isStale, copy ?? undefined);
          return isStale() ? "stale" : outcome;
        };
        if (workTarget && engine) {
          const failCanonical = () => {
            const current = openedRef.current;
            if (current?.key === item.key && current.input?.kind === "provisional") {
              const next = { ...current, canonicalPending: false };
              openedRef.current = next;
              setOpened(next);
            }
            setSourceError("高画質表示を準備できませんでした。もう一度読み込んでください。");
          };
          let provisionalReady = false;
          if (pendingPreview) {
            try {
              let timeout: ReturnType<typeof setTimeout> | null = null;
              const preview = await Promise.race([
                pendingPreview,
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(
                    () => {
                      previewAbort.abort();
                      reject(new Error("interactive preview deadline"));
                    },
                    Math.max(0, (previewDeadlineAt ?? performance.now()) - performance.now()),
                  );
                }),
              ]).finally(() => {
                if (timeout !== null) clearTimeout(timeout);
              });
              if (!isStale()) {
                const draft = await library.loadProvisionalDraft?.(item.photo.id, preview.photo.contentSha256);
                const sourceSettings = draft?.settings ?? readDevelopSettings(preview.photo.developSettings) ??
                  neutralDevelopSettings(null, { raw: isBrowserCloudRawPhoto(item.photo) });
                const projected = provisionalDevelopSettings(sourceSettings);
                const bytes = await preview.file.arrayBuffer();
                if (!isStale()) {
                  await engine.open(bytes, Math.max(preview.width, preview.height));
                  const frame = await engine.render(projected, {
                    maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION,
                    interactive: true,
                  });
                  if (frame && !isStale()) {
                    provisionalReady = true;
                    commitProvisional(item, preview, projected, frame, draft ?? null);
                    recordProxyReady(item.key);
                  }
                }
              }
            } catch {
              // provisional は任意。使えなければ従来どおり canonical を同じ engine で開く。
            }
          }
          if (!provisionalReady) {
            const outcome = await openWork(engine, pendingWork ?? undefined);
            if (outcome !== "stale") openFlowRef.current.applyWorkOutcome(item.key, outcome);
            return;
          }

          const canonicalEngine = createDevelopEngine({
            manifestUrl: library.engineAssets.manifestUrl() ?? undefined,
            maskSurfaces: maskSurfaceSource,
          });
          const canonicalReady = await canonicalEngine.ready();
          if (!canonicalReady || isStale()) {
            canonicalEngine.dispose();
            if (!isStale()) failCanonical();
            return;
          }
          try {
            const outcome = await openWork(canonicalEngine, pendingWork ?? undefined, true);
            if (outcome === "stale") {
              canonicalEngine.dispose();
              return;
            }
            if (outcome.kind === "opened" && outcome.result.session) {
              const handedOff = await handoffCanonical(item, outcome.result, canonicalEngine, isStale);
              if (!handedOff && !isStale()) failCanonical();
              return;
            }
            canonicalEngine.dispose();
            if (outcome.kind === "wait") openFlowRef.current.applyWorkOutcome(item.key, outcome);
            failCanonical();
          } catch {
            canonicalEngine.dispose();
            if (!isStale()) failCanonical();
          }
          return;
        }
        try {
          // wasm を使えない RAW などは S1 と同じく閲覧だけ（理由と次の一歩を 1 行）
          const source = await loadBrowserCloudPhotoSource(library, item.photo, abort.signal, {
            allowEditing,
            canDevelop: engine !== null,
          });
          if (isStale()) return;
          const result = await openEditableSource(
            openFlowRef.current.context,
            item,
            source,
            allowEditing,
            engine,
            abort.signal,
            isStale,
          );
          if (!result || isStale()) return;
          commitOpenResult(result);
        } catch (error) {
          // オリジナルが大きすぎた JPEG（4,000 万画素・64MiB を超える。K5-a 移行元設計）は、エラーにせず作業コピーで開き直す（「編集の
          // 準備中」→ 揃ったら差し替え）。このタブの間は覚えて、次からはオリジナルを落とさずに作業コピーで開く
          if (isStale()) return;
          if (!engine || !canOpenDevelopWorkInstead(item.photo, error)) throw error;
          rememberDevelopOriginalTooLarge(item.photo.id);
          showWorkPreview();
          const outcome = await openWork(engine);
          if (outcome !== "stale") openFlowRef.current.applyWorkOutcome(item.key, outcome);
        }
      } catch (error) {
        if (mountedRef.current && !abort.signal.aborted && generation === loadGenerationRef.current) {
          setSourceError(describeBrowserPhotoSourceError(error));
        }
      } finally {
        abort.signal.removeEventListener("abort", abortWork);
        abort.signal.removeEventListener("abort", abortPreview);
        workAbort.abort();
        previewAbort.abort();
        if (generation === loadGenerationRef.current) {
          if (loadAbortRef.current === abort) loadAbortRef.current = null;
          openingKeyRef.current = null;
          if (mountedRef.current) setOpening(false);
        }
      }
    },
    [
      commitOpenResult,
      commitProvisional,
      confirmSourceSwitch,
      developUnavailable,
      developSessionRef,
      leaveEditing,
      handoffCanonical,
      library,
      loadSettings,
      maskSurfacePhotoIdRef,
      maskSurfaceSource,
      mountedRef,
      operationRef,
      readyDevelopEngine,
      recordProxyReady,
      releaseOpened,
      setExportSheetOpen,
      setSelectedKey,
      setViewMode,
      sourceContextFor,
      startHistory,
      startTimeline,
      settings,
      uploadOpenedEditedPreview,
    ],
  );
  const openItemRef = useRef(openItem);
  openItemRef.current = openItem;

  /** provisional の履歴・プリセット・現在値を保ったまま canonical だけを作り直す。 */
  const retryCanonical = useCallback(async (): Promise<void> => {
    const current = openedRef.current;
    if (!current || current.input?.kind !== "provisional" || current.canonicalPending || operationRef.current) return;
    const item = allItemsRef.current.find((candidate) => candidate.key === current.key);
    if (!item) return;
    const generation = loadGenerationRef.current;
    const abort = new AbortController();
    loadAbortRef.current?.abort();
    loadAbortRef.current = abort;
    openingKeyRef.current = item.key;
    maskSurfacePhotoIdRef.current = item.photo.id;
    const pending: OpenedSource = { ...current, canonicalPending: true };
    openedRef.current = pending;
    setOpened(pending);
    setSourceError(null);
    const isStale = () => {
      const latest = openedRef.current;
      return abort.signal.aborted || generation !== loadGenerationRef.current || latest?.key !== item.key || latest.input?.kind !== "provisional";
    };
    const fail = () => {
      if (isStale()) return;
      const latest = openedRef.current;
      if (latest?.key === item.key && latest.input?.kind === "provisional") {
        const failed = { ...latest, canonicalPending: false };
        openedRef.current = failed;
        setOpened(failed);
      }
      setSourceError("高画質表示を準備できませんでした。もう一度読み込んでください。");
    };
    let canonicalEngine: DevelopEngine | null = null;
    try {
      canonicalEngine = createDevelopEngine({
        manifestUrl: library.engineAssets.manifestUrl() ?? undefined,
        maskSurfaces: maskSurfaceSource,
      });
      if (!(await canonicalEngine.ready()) || isStale()) {
        canonicalEngine.dispose();
        canonicalEngine = null;
        fail();
        return;
      }
      const work = await library.ensureWorkingCopy(item.photo.id, {
        signal: abort.signal,
        sourceContext: sourceContextFor(item.photo, edit.settingsRef.current),
      });
      if (isStale()) {
        canonicalEngine.dispose();
        canonicalEngine = null;
        return;
      }
      const context = { ...openFlowRef.current.context, rememberOpenedFrame: () => undefined };
      const outcome = await resolveWorkOutcome(context, item, work, canonicalEngine, abort.signal, isStale);
      if (outcome === "stale" || isStale()) {
        canonicalEngine.dispose();
        canonicalEngine = null;
        return;
      }
      if (outcome.kind !== "opened" || !outcome.result.session) {
        canonicalEngine.dispose();
        canonicalEngine = null;
        fail();
        return;
      }
      const handedOff = await handoffCanonical(item, outcome.result, canonicalEngine, isStale);
      canonicalEngine = null;
      if (!handedOff) fail();
    } catch {
      canonicalEngine?.dispose();
      fail();
    } finally {
      if (loadAbortRef.current === abort) loadAbortRef.current = null;
      if (openingKeyRef.current === item.key) openingKeyRef.current = null;
    }
  }, [edit.settingsRef, handoffCanonical, library, maskSurfacePhotoIdRef, maskSurfaceSource, operationRef, sourceContextFor]);

  /** 開いている写真を、今の開き直しの経路で開き直す（入力を落とし直して、今の行の補正で開く）。 */
  const reopen = (key: string) => {
    const item = allItemsRef.current.find((candidate) => candidate.key === key);
    if (item) void openItemRef.current(item, { reload: true });
  };
  reopenRef.current = reopen;

  // 別の端末で直した補正を、開いている写真に読み直す（保存が 409 で断られた・画面に戻ったとき。移行元設計）
  const staleReloading = useBrowserPhotoDevelopReload({
    mountedRef,
    latestAccessRef,
    develop: params.develop,
    openedRef,
    setOpened,
    loadSettings,
    viewModeRef,
    operationRef,
    openingKeyRef,
    reopen,
    ensureDevelopWorkingSize,
    replaceCloudPhoto,
    setStatus,
  });

  /**
   * 端末に残った未保存補正を、明示操作の後だけ既存 commitEdit → 自動保存へ戻す。復元前に現在の行を API で読み、actor・拠点・写真・
   * 権限・revision・入力の base・engine / look を await の前後で照合する。候補は保存成功まで消さない。
   */
  const restoreDraft = useCallback(async (): Promise<void> => {
    const showRecoveryMessage = (kind: "notice" | "error", text: string) => {
      params.develop.draftRecovery.setMessage(text);
      setStatus({ kind, text });
    };
    params.develop.draftRecovery.setMessage(null);
    const draft = params.develop.draftRecovery.selectedDraft;
    const session = developSessionRef.current;
    const currentOpened = openedRef.current;
    const actorId = params.develop.draftRecovery.actorIdRef.current;
    if (
      !draft ||
      !session?.saver ||
      !currentOpened ||
      currentOpened.mode !== "wasm" ||
      currentOpened.key !== session.key ||
      actorId !== draft.actorId ||
      draft.spotId !== session.spotId ||
      draft.photoId !== session.photoId ||
      !latestAccessRef.current.canEdit ||
      latestAccessRef.current.spotId !== session.spotId
    ) {
      showRecoveryMessage("error", "この写真では未保存の補正を復元できません。候補は端末に残しています。");
      params.develop.draftRecovery.refresh();
      return;
    }
    params.develop.draftRecovery.setBusy(true);
    const expectedRevision = session.saver.getExpectedRevision();
    const isCurrent = () =>
      mountedRef.current &&
      developSessionRef.current === session &&
      openedRef.current === currentOpened &&
      params.develop.draftRecovery.actorIdRef.current === actorId &&
      latestAccessRef.current.canEdit &&
      latestAccessRef.current.spotId === session.spotId &&
      session.saver?.getExpectedRevision() === expectedRevision;
    try {
      const latest = await readBrowserCloudPhotoRow(library, session.photo);
      if (!isCurrent()) return;
      if (!latest) {
        showRecoveryMessage("error", "写真の最新状態を確認できません。未保存の補正は端末に残しています。");
        return;
      }
      if (expectedRevision === undefined || latest.photo.developRevision !== expectedRevision) {
        params.develop.saveStaleHandlerRef.current?.(latest.photo);
        showRecoveryMessage("notice", "別の端末の補正を先に読み直します。未保存の補正はその後に復元できます。");
        return;
      }
      // 土台・数式・ルックが今と同じ draft だけ戻す（保存したことの無い写真の niho-2 の draft は、既定が niho-6 になっても戻す）
      if (
        !canRestoreDevelopSettingsDraft({
          draftSettings: draft.settings,
          currentSettings: edit.settingsRef.current,
          inputBase: developBaseVersion(session.input),
          hasSavedSettings: hasSavedDevelopSettings(latest.photo),
        })
      ) {
        showRecoveryMessage(
          "error",
          "写真の土台または補正形式が変わったため復元できません。未保存の補正は端末に残しています。",
        );
        return;
      }
      const engine = engineRef.current;
      if (!engine) {
        showRecoveryMessage("error", "補正を確認できないため復元しませんでした。候補は端末に残しています。");
        return;
      }
      const validated = await engine
        .render(draft.settings, { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, interactive: false })
        .catch(() => null);
      if (!isCurrent()) return;
      if (!validated) {
        showRecoveryMessage("error", "この版では読めない補正のため復元しませんでした。候補は端末に残しています。");
        return;
      }
      if (sameDevelopSettings(draft.settings, edit.settingsRef.current)) {
        params.develop.draftRecovery.discardSelectedDraft();
        setStatus({ kind: "notice", text: "未保存の補正は、写真の最新の補正と同じ内容でした。" });
        return;
      }
      params.develop.draftRecovery.retainDraftUntilSaved(session.saver, draft);
      if (!edit.commitEdit(draft.settings)) {
        params.develop.draftRecovery.releaseRetainedDraft(session.saver, draft);
        showRecoveryMessage("error", "写真の状態が変わったため復元しませんでした。候補は端末に残しています。");
        return;
      }
      params.develop.draftRecovery.hideRestoredDraft(draft);
      setStatus({ kind: "notice", text: "未保存の補正を復元しました。保存が完了するまで端末にも残します。" });
    } catch {
      if (isCurrent()) {
        showRecoveryMessage("error", "写真の最新状態を確認できません。未保存の補正は端末に残しています。");
      }
    } finally {
      if (mountedRef.current) params.develop.draftRecovery.setBusy(false);
    }
  }, [developSessionRef, edit, engineRef, latestAccessRef, library, mountedRef, params.develop, setStatus]);

  /**
   * 作業コピーを待っている写真の状態を確かめ直す（移行元設計）。揃っていれば作業コピーを読んで wasm で開き、プレビューを 1 回だけ描いた
   * 画に差し替える。別の写真を開いた・一覧へ戻った・画面を閉じたら結果を捨てる。確かめられなければ（通信など）次の間隔で確かめ直す。
   */
  const refreshWork = async (key: string, signal: AbortSignal): Promise<void> => {
    const item = allItemsRef.current.find((candidate) => candidate.key === key);
    const engine = engineRef.current;
    const generation = loadGenerationRef.current;
    const isStale = () => {
      const current = openedRef.current;
      return (
        signal.aborted ||
        !mountedRef.current ||
        generation !== loadGenerationRef.current ||
        current === null ||
        current.key !== key ||
        current.work === null
      );
    };
    if (!item || !engine || isStale()) return;
    let result: PhotoLibraryWorkingCopyResult;
    try {
      result = await library.ensureWorkingCopy(item.photo.id, {
        signal,
        sourceContext: sourceContextFor(
          item.photo,
          openedRef.current?.key === item.key ? edit.settingsRef.current : null,
        ),
      });
    } catch (error) {
      if (isStale()) return;
      console.warn("[photo-editing] work status check failed", error);
      const current = openedRef.current?.work;
      if (current?.phase === "preparing") setWorkWait(key, { ...current, checkedAt: Date.now() });
      return;
    }
    if (isStale()) return;
    try {
      const outcome = await resolveWorkOutcome(openFlowRef.current.context, item, result, engine, signal, isStale);
      if (outcome === "stale" || isStale()) return;
      openFlowRef.current.applyWorkOutcome(key, outcome);
    } catch (error) {
      if (isStale()) return;
      // 作業コピーを読めなかった（通信など）。プレビューのまま理由と「もう一度読み込む」を出す
      setWorkWait(key, { phase: "opening" });
      setSourceError(describeBrowserPhotoSourceError(error));
    }
  };
  const refreshWorkRef = useRef(refreshWork);
  refreshWorkRef.current = refreshWork;

  // 作業コピーの準備中は、その写真を 1 枚で見ている間だけ段階的に確かめ直す（タブを隠している間は確かめない。移行元設計 / W1 移行元設計）
  const openedWork = opened?.work ?? null;
  const workPollKey = viewMode === "loupe" && opened !== null && openedWork?.phase === "preparing" ? opened.key : null;
  const workCheckedAt = openedWork?.phase === "preparing" ? openedWork.checkedAt : null;
  useDevelopWorkPoll(workPollKey, workCheckedAt, refreshWorkRef);

  /**
   * 「再試行」（作れなかった作業コピーを待ちに戻す。移行元設計）。戻したら「現像の準備中」。失敗していなかった（ほかの人が戻した・
   * できていた）・作らない写真は、今の状態を確かめ直す。
   */
  const retryWork = async () => {
    const current = openedRef.current;
    const work = current?.work ?? null;
    if (!canEdit || !current || !work || work.phase !== "failed" || work.retrying) return;
    const key = current.key;
    const item = allItemsRef.current.find((candidate) => candidate.key === key);
    if (!item) return;
    const generation = loadGenerationRef.current;
    const isStale = () => !mountedRef.current || generation !== loadGenerationRef.current || openedRef.current?.key !== key;
    setWorkWait(key, { phase: "failed", retrying: true });
    setStatus(null);
    try {
      const result = await library.retryWorkingCopy(item.photo.id);
      if (isStale()) return;
      if (result.kind === "queued") {
        const now = Date.now();
        setWorkWait(key, { phase: "preparing", slow: isWorkSlow(result.workQueuedAt, now), checkedAt: now });
        // retry は開いている写真のローカル状態だけでなく、一覧の React Query cache も更新する。
        refetchCloudPhotos();
        return;
      }
      setWorkWait(key, { phase: "opening" });
      await refreshWorkRef.current(key, new AbortController().signal);
    } catch (error) {
      if (isStale()) return;
      setWorkWait(key, { phase: "failed", retrying: false });
      setStatus({ kind: "error", text: library.errors.describe(error, workFailedText(isBrowserCloudRawPhoto(item.photo))) });
    }
  };

  // 補正の入力を読まずに開いた写真（狭い幅・スマホで直せるかを読み終える前）は、直せるようになったとき（広げた・読み終えた）に
  // 補正の入力を読む
  useEffect(() => {
    if (!editingAllowed || viewMode !== "loupe") return;
    const current = openedRef.current;
    if (!current || current.loadedForEditing) return;
    const item = allItemsRef.current.find((candidate) => candidate.key === current.key);
    if (item) void openItemRef.current(item);
  }, [allItemsRef, editingAllowed, viewMode]);

  useEffect(() => {
    const photoId = openCloudPhotoId;
    if (!photoId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const photo = allItemsRef.current.find((candidate) => candidate.photo.id === photoId)?.photo ??
          await library.get(photoId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!photo) {
          setViewMode("grid");
          setSourceError("指定された写真が見つかりませんでした。一覧を更新して、もう一度お試しください。");
          return;
        }
        setDeepLinkedPhoto(photo);
        setPlace(browserCloudPhotoPlace(photo));
        // 絞り込みの条件に合わない写真でも開けるよう、条件を外す（場所を写真の場所へ移すのと同じ。F5b 移行元設計）
        clearFilter();
        await openItem({ key: cloudKey(photo.id), photo, localPreviewUrl: null, adding: false });
      } catch {
        if (!controller.signal.aborted && mountedRef.current) {
          setViewMode("grid");
          setSourceError("指定された写真を読み込めませんでした。通信状態を確かめて、もう一度お試しください。");
        }
      } finally {
        if (!controller.signal.aborted) onOpenCloudPhotoHandled();
      }
    })();
    return () => controller.abort();
    // URL の依頼 1 件につき一度だけ処理する。クラウド一覧の更新では再実行しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCloudPhotoId, spotId]);

  const switchToGrid = () => {
    timelineRef.current = null;
    setViewMode("grid");
    setCompareOriginal(false);
    setDragging(false);
    // 写真を離れたら取り消しの履歴を捨てる
    dropHistory();
    setExportSheetOpen(false);
  };

  /**
   * 一覧へ戻る。wasm で直している写真は、保存を送り終え、補正後のプレビューを上げ始めてから切り替える（上げ終わりは待たない。
   * 開いた写真は手放さない。保存できなければ戻らない）。戻れたら true（`showGrid` の待てる形。戻ってから続ける操作に使う）。
   */
  const returnToGrid = (): Promise<boolean> => {
    if (!developSessionRef.current) {
      switchToGrid();
      return Promise.resolve(true);
    }
    return leaveEditing({ release: false }).then((left) => {
      if (!left || !mountedRef.current) return false;
      switchToGrid();
      return true;
    });
  };
  const showGrid = () => {
    void returnToGrid();
  };

  const selectPlace = async (next: BrowserCloudPlace): Promise<boolean> => {
    if (operationRef.current) return false;
    if (next === place && viewMode === "grid") return true;
    // 開いていた写真を手放すので、wasm の編集も保存を送り終えてから手放す（S1 の canvas は破棄の確認）
    if (!(await leaveEditing({ release: true }))) return false;
    if ((next !== place || viewMode !== "grid") && !(await confirmSourceSwitch())) return false;
    if (operationRef.current) return false;
    abortOpening();
    if (next !== place) setSelectedKey(null);
    clearOpened();
    setSourceError(null);
    setPlace(next);
    switchToGrid();
    return true;
  };

  return {
    opened,
    staleReloading,
    /** 描画が面を読めなかったマスク（マスクの面の理由の 1 行。M4 #68） */
    maskSurfaceIssue,
    retryMaskSurfaces,
    openedRef,
    opening,
    openingKeyRef,
    sourceError,
    setSourceError,
    settings,
    settingsRef: edit.settingsRef,
    settingsKey,
    /** 補正のスライダーのつまみを動かしている */
    dragging,
    setSavedSettingsKey: edit.setSavedSettingsKey,
    dirty,
    compareOriginal,
    setCompareOriginal,
    openItem,
    previewGeneration: timelineRef.current?.generation ?? null,
    onPreviewLoaded,
    onPreviewFailed,
    previewAccurate: Boolean(opened?.previewPending && opened.previewCurrent &&
      initialFrameRef.current?.key === opened.key &&
      initialFrameRef.current.settingsJson === JSON.stringify(settings) &&
      previewSettings === null && !compareOriginal && !cropActive && !healActive),
    retryWork,
    retryCanonical,
    showGrid,
    returnToGrid,
    selectPlace,
    abortOpening,
    clearOpened,
    changeSettings: edit.changeSettings,
    resetSettings: edit.resetSettings,
    commitEdit: edit.commitEdit,
    undo: edit.undo,
    redo: edit.redo,
    canUndo: edit.canUndo,
    canRedo: edit.canRedo,
    resetDone: edit.resetDone,
    clearResetDone: edit.clearResetDone,
    restoreDraft,
    cropSettling,
    presets,
    crop,
    heal,
    autoResetRef,
    clipboard,
    ensureDevelopWorkingSize,
    repaintLastFrame,
  };
}

export type BrowserPhotoOpen = ReturnType<typeof useBrowserPhotoOpen>;
