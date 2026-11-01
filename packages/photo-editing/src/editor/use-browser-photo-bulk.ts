"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  runBrowserPhotoBulkApply,
  runBrowserPhotoBulkUndo,
  type BrowserPhotoBulkPhoto,
  type BrowserPhotoBulkRecipe,
  type BrowserPhotoBulkSave,
  type BrowserPhotoBulkUndoEntry,
} from "../browser-photo-bulk-apply";
import {
  createDevelopEngine,
  type DevelopBuiltinPreset,
  type DevelopEngine,
} from "../develop-engine/develop-engine-client";
import {
  browserEditingDevelopSettings,
  copyDevelopSettings,
  hasSavedDevelopSettings,
  isEditableDevelopSettings,
  isNeutralDevelopSettings,
  neutralDevelopSettings,
  readDevelopSettings,
  type CopiedDevelopSettings,
} from "../develop-engine/develop-settings";
import {
  BROWSER_PHOTO_EDITING_READ_ONLY_TEXT,
  PHOTO_EDITING_BULK_COPY_NEEDS_ONE_TEXT,
  PHOTO_EDITING_BULK_COPY_NO_SETTINGS_TEXT,
  PHOTO_EDITING_BULK_COPY_UNREADABLE_TEXT,
  PHOTO_EDITING_BULK_ENGINE_UNAVAILABLE_TEXT,
  PHOTO_EDITING_BULK_FAILED_TEXT,
  PHOTO_EDITING_BULK_PASTE_NEEDS_COPY_TEXT,
  PHOTO_EDITING_BULK_PASTE_NEEDS_SELECTION_TEXT,
  PHOTO_EDITING_BULK_UNDO_LABEL,
  PHOTO_EDITING_COPY_SETTINGS_DONE_TEXT,
  photoEditingBulkPresetUnusableText,
  photoEditingBulkProgressText,
  photoEditingBulkResultStatus,
  photoEditingBulkUndoProgressText,
  photoEditingBulkUndoResultStatus,
  type PhotoEditingBulkAction,
} from "../photo-editing-copy";
import { builtinPhotoPresetDisplayName } from "../photo-editing-preset-names";
import {
  readPhotoEditingSettingsClipboard,
  usePhotoEditingSettingsClipboard,
  writePhotoEditingSettingsClipboard,
} from "../photo-editing-settings-clipboard";
import { isPhotoEditingTypingTarget, isWithinPhotoEditingScope } from "../use-photo-editing-shortcuts";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import type { PhotoLibraryPhoto } from "../library/photo-library";
import { usePhotoLibrary } from "../library/photo-library-context";

import type { BrowserPhotoBulkMenuPresets, BrowserPhotoBulkMenuProps } from "./browser-photo-editing-bulk-menu";
import {
  cloudKey,
  type BrowserItem,
  type BrowserPhotoAccess,
  type BrowserPhotoOperation,
  type BrowserPhotoOperationKind,
  type BrowserViewMode,
  type FooterStatus,
} from "./browser-photo-editing-model";
import { builtinPhotoPresetKey, spotPhotoPresetKey, type PhotoEditingPresetTarget } from "./photo-editing-presets-panel";
import type { BrowserPhotoDevelop } from "./use-browser-photo-develop";
import { resolveBrowserPhotoEditingKey } from "./use-browser-photo-editing-keys";
import type { BrowserPhotoOpen } from "./use-browser-photo-open";

/**
 * 一覧で選んだ複数枚への一括の補正（F5a-2 移行元設計）。状態・キー・メニューの組み立てを持ち、1 枚ずつの処理は純粋な核
 * （`lib/photo-editing/browser-photo-bulk-apply.ts`）に任せる。ワークベンチは配線だけ。
 *
 * - 入口: PC のブラウザ版の選択バー（2 枚以上）の「補正」メニュー、狭い幅の選択バーの「操作」メニュー
 *   （{@link BrowserPhotoBulkMenuProps}）と、PC の一覧を見ている間のキー
 *   ⌥⇧⌘C（1 枚だけ選んでいる写真の保存済みの補正をコピー）・⌥⇧⌘V（選んでいる写真〔1 枚以上〕へ貼り付け）。Windows などは
 *   Ctrl+Alt+Shift+C / V（1 枚の面のキーと同じ判定 `resolveBrowserPhotoEditingKey`）。何もコピーしていない・直せない選択のときは
 *   状態欄に 1 行（黙って何もしないを避ける）
 * - プリセット: 開いている写真が無いので、撮影時の白は作業コピーのメタから引く（`applyPreset(xmp, base, 1, { workMetaJson })`）。
 *   口（`asShotWhiteFromMeta`）の無い wasm では、メニューにプリセットの群を出さない（貼り付けは engine が要らないので出す）。
 *   一覧の画面に engine が無ければ、プリセットを読む・当てる間だけ短命の engine を起こし、使い終えたら `dispose` する
 * - 処理中は `operation` を `bulk` にしてほかの操作を止め、状態欄に進み具合（「補正を貼り付けています（12 / 29）」）。「補正」の
 *   ボタンは「止める」（走っている写真を終えてから止める）。画面を閉じた・拠点や権限が変わったら打ち切り、以後の結果を出さない
 * - 終わったら状態欄に 1 行（保存できなかった写真があれば error）。保存できた写真があれば［元に戻す］を添える（次の操作・選択の
 *   変更・写真を開く・一覧を離れるまで。押すと当てる前の補正を保存し直す。1 回きり）
 * - 保存できた写真は一覧の cache に応答の写真を入れ、補正後のプレビューをワーカーが描くまで一覧を読み直す（`markEditedPreviewPending`）。
 *   選択は残す
 */

type PresetSupport = {
  status: "idle" | "checking" | "supported" | "unsupported";
  builtin: DevelopBuiltinPreset[];
  builtinFailed: boolean;
};

const PRESET_SUPPORT_IDLE: PresetSupport = { status: "idle", builtin: [], builtinFailed: false };

/** 走っている一括（止める・打ち切る合図と、始めたときの拠点）。 */
type BulkRun = { stop: AbortController; cancel: AbortController; spotId: string };

/** ［元に戻す］の材料（作ったときの選択・一覧・拠点を過ぎたら使えない）。 */
type BulkUndo = {
  token: number;
  entries: BrowserPhotoBulkUndoEntry[];
  selectedKeys: readonly string[];
  selectionKey: string;
  listKey: string;
  spotId: string;
};

type BulkSpec = { kind: "paste"; copied: CopiedDevelopSettings } | { kind: "preset"; preset: PhotoEditingPresetTarget };

/** engine を借りる（一覧の画面の engine があればそれ、無ければ短命の engine。`release` で返す）。 */
type EngineLease = { engine: DevelopEngine; release: () => void };

/** 確かめる（無い口・失敗は false。古い engine で関数が無くても投げない）。 */
function check(read: () => Promise<boolean>): Promise<boolean> {
  return Promise.resolve()
    .then(read)
    .then(
      (value) => value === true,
      () => false,
    );
}

function selectionKeyOf(keys: readonly string[]): string {
  return keys.join("\u001f");
}

export function useBrowserPhotoBulk(params: {
  spotId: string;
  scopeKey?: string;
  /** Worker の論理メモリ予算。host / 画面 class を呼び出し側が明示する。 */
  deviceClass: "pc" | "mobile";
  canEdit: boolean;
  /** PC の広い幅（1024px 以上）。狭い幅はメニューを「操作」に畳み、キーは扱わない */
  wide: boolean;
  /** PC はブラウザ実行面だけに入口・ショートカットを出す。狭い幅の可視メニューは runtime を問わない */
  browserRuntime: boolean;
  /** 設定サブタブなどでこのworkbenchが隠れていない */
  active: boolean;
  viewMode: BrowserViewMode;
  /** 一覧のキー（⌥⇧⌘C / ⌥⇧⌘V）を聞く（面を見せていて、一覧を見ていて、複数選択できる場所で、シートを開いていない） */
  keysEnabled: boolean;
  /** 一覧の条件（場所・並び・絞り込み）。変わったら［元に戻す］を消す */
  listKey: string;
  rootRef: RefObject<HTMLElement | null>;
  mountedRef: MutableRefObject<boolean>;
  latestAccessRef: MutableRefObject<BrowserPhotoAccess>;
  /** 選んでいる写真（選んだ順。追加している途中を除く） */
  selectedItems: readonly BrowserItem[];
  /** 一覧にまだ表示されない写真も含む、現在の選択順 */
  selectedKeys: readonly string[];
  /** 一括適用・undo中に絞り込みで選択から落ちるkeyを保つ */
  setPreservedSelectionKeys: (keys: readonly string[]) => void;
  operation: BrowserPhotoOperation | null;
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  setOperation: (operation: BrowserPhotoOperation | null) => void;
  saveGenerationRef: MutableRefObject<number>;
  setStatus: Dispatch<SetStateAction<FooterStatus | null>>;
  /** ほかの一括操作（お気に入り・アルバム）の途中・別の端末の補正の読み直し中（「補正」を押せない） */
  blocked: boolean;
  replaceCloudPhoto: (photo: PhotoLibraryPhoto) => void;
  markEditedPreviewPending: (photoId: string) => void;
  develop: Pick<BrowserPhotoDevelop, "engineRef" | "developSessionRef" | "leaveEditing" | "releaseDevelopSession">;
  open: Pick<BrowserPhotoOpen, "openedRef" | "clearOpened">;
}): { menu: BrowserPhotoBulkMenuProps | null } {
  const {
    spotId,
    deviceClass,
    canEdit,
    wide,
    browserRuntime,
    active,
    viewMode,
    listKey,
    rootRef,
    mountedRef,
    latestAccessRef,
    selectedItems,
    selectedKeys,
    setPreservedSelectionKeys,
    operation,
    operationRef,
    setOperation,
    saveGenerationRef,
    setStatus,
    replaceCloudPhoto,
    markEditedPreviewPending,
    develop,
    open,
  } = params;
  const queryClient = useQueryClient();
  // 写真の出どころ（接続口 PhotoLibrary。保存・作業コピーの確認・拠点のプリセット・wasm の manifest の場所。移行元設計）
  const library = usePhotoLibrary();
  const clipboard = usePhotoEditingSettingsClipboard();
  const [stopping, setStopping] = useState(false);
  const runRef = useRef<BulkRun | null>(null);
  const [menuRequested, setMenuRequested] = useState(false);
  const [presetSupport, setPresetSupport] = useState<PresetSupport>(PRESET_SUPPORT_IDLE);
  const presetSupportRef = useRef<PresetSupport>(PRESET_SUPPORT_IDLE);
  // 短命の engine（一覧の画面に engine が無いとき。使い終えたら・画面を閉じたら dispose）
  const ownEnginesRef = useRef(new Set<DevelopEngine>());
  const undoRef = useRef<BulkUndo | null>(null);
  const undoStatusRef = useRef<FooterStatus | null>(null);
  const undoTokenRef = useRef(0);
  const selectionKey = selectionKeyOf(selectedKeys);
  // 終わったときの選択・一覧（［元に戻す］の有効な範囲）と、［元に戻す］の押し先（今の描画の関数）
  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const listKeyRef = useRef(listKey);
  listKeyRef.current = listKey;
  const undoHandlerRef = useRef<(token: number) => Promise<void>>(async () => undefined);
  // 狭幅で始めた一括処理は、幅を広げても停止できるよう処理中だけ入口を残す。
  const menuAvailable = active && canEdit && (browserRuntime || !wide || operation?.kind === "bulk");

  // 画面を閉じたら走っている一括を打ち切り、短命の engine を手放す
  useEffect(() => {
    const ownEngines = ownEnginesRef.current;
    return () => {
      runRef.current?.cancel.abort();
      runRef.current?.stop.abort();
      for (const engine of ownEngines) engine.dispose();
      ownEngines.clear();
    };
  }, []);

  // 拠点・権限が変わったら走っている一括を打ち切る（以後の結果を出さない）
  useEffect(() => {
    const run = runRef.current;
    if (run && (run.spotId !== spotId || !canEdit)) run.cancel.abort();
  }, [canEdit, spotId]);

  // 設定サブタブへ移ると編集面は隠れたままmountされる。一括処理は現在の写真まで完了して止める。
  useEffect(() => {
    if (active) return;
    const run = runRef.current;
    if (!run || run.stop.signal.aborted) return;
    run.stop.abort();
    setStopping(true);
  }, [active]);

  /** ［元に戻す］を使えなくする（状態欄に出している 1 行からボタンを外す）。 */
  const dropUndo = useCallback(() => {
    undoRef.current = null;
    setPreservedSelectionKeys([]);
    const shown = undoStatusRef.current;
    undoStatusRef.current = null;
    if (!shown || (shown.kind !== "notice" && shown.kind !== "error") || !shown.action) return;
    const plain: FooterStatus = shown.kind === "error" ? { kind: "error", text: shown.text } : { kind: "notice", text: shown.text };
    setStatus((current) => (current === shown ? plain : current));
  }, [setPreservedSelectionKeys, setStatus]);

  // ［元に戻す］は次の操作・選択の変更・写真を開く・一覧を離れるまで
  useEffect(() => {
    const entry = undoRef.current;
    if (!entry) return;
    if (
      entry.selectionKey !== selectionKey ||
      entry.listKey !== listKey ||
      entry.spotId !== spotId ||
      viewMode !== "grid" ||
      !canEdit ||
      operation !== null
    ) {
      dropUndo();
    }
  }, [canEdit, dropUndo, listKey, operation, selectionKey, spotId, viewMode]);

  /** engine を借りる（一覧の画面の engine があればそれ。無ければ短命の engine を起こす。使えなければ null）。 */
  const acquireEngine = useCallback(async (): Promise<EngineLease | null> => {
    const shared = develop.engineRef.current;
    if (shared) return (await shared.ready()) ? { engine: shared, release: () => undefined } : null;
    const own = createDevelopEngine({
      manifestUrl: library.engineAssets.manifestUrl() ?? undefined,
      preferNative: library.engineAssets.preferNative === true,
      deviceClass,
    });
    ownEnginesRef.current.add(own);
    const release = () => {
      if (!ownEnginesRef.current.delete(own)) return;
      own.dispose();
    };
    if (!(await own.ready())) {
      release();
      return null;
    }
    return { engine: own, release };
  }, [develop.engineRef, deviceClass, library]);

  /**
   * プリセットを当てられる wasm か確かめ、同梱のプリセットを読む（メニューを初めて開いたときに 1 回。読めなかったら開き直したときに
   * 読み直す）。結果は画面を開いている間覚える（読み込む wasm の版は変わらない）。
   */
  const ensurePresetSupport = useCallback(() => {
    const current = presetSupportRef.current;
    if (current.status === "checking" || current.status === "unsupported") return;
    if (current.status === "supported" && !current.builtinFailed) return;
    const checking: PresetSupport = { ...current, status: "checking" };
    presetSupportRef.current = checking;
    setPresetSupport(checking);
    void (async () => {
      const lease = await acquireEngine();
      let next: PresetSupport;
      try {
        const engine = lease?.engine ?? null;
        if (!engine || !(await check(() => engine.supportsPresetFromMeta()))) {
          next = { status: "unsupported", builtin: [], builtinFailed: false };
        } else {
          try {
            const builtin = await queryClient.fetchQuery({
              queryKey: photoEditingQueryKeys.developBuiltinPresets(),
              queryFn: () => engine.builtinPresets(),
              staleTime: Number.POSITIVE_INFINITY,
              retry: false,
            });
            next = { status: "supported", builtin, builtinFailed: false };
          } catch {
            next = { status: "supported", builtin: [], builtinFailed: true };
          }
        }
      } finally {
        lease?.release();
      }
      presetSupportRef.current = next;
      if (mountedRef.current) setPresetSupport(next);
    })();
  }, [acquireEngine, mountedRef, queryClient]);

  // 拠点のプリセット（1 枚の面の右パネルの節と同じデータ源・同じ cache）。メニューを開いて、プリセットを当てられると分かってから読む
  const spotPresetsQuery = useQuery({
    queryKey: photoEditingQueryKeys.spotPresets(spotId, params.scopeKey),
    // 1 枚の面の右パネル（photo-editing-presets-panel）と同じ cache の形（`{ presets }`）。読むのは写真の出どころ（移行元設計）
    queryFn: async () => ({ presets: await library.presets.list() }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: menuAvailable && menuRequested && presetSupport.status === "supported",
  });

  /** 1 枚の面の保存が一覧の行より新しければ、その補正と版で直す（一覧の読み直しを待たずに 409 を避ける）。 */
  const latestPhoto = <T extends BrowserPhotoBulkPhoto>(photo: T): T => {
    const session = develop.developSessionRef.current;
    if (!session || session.photoId !== photo.id || session.spotId !== spotId) return photo;
    const saved = session.saver?.getLastSaved() ?? null;
    if (!saved || saved.developRevision <= photo.developRevision) return photo;
    return { ...photo, developSettings: saved.settings, developRevision: saved.developRevision };
  };

  /**
   * 始める前に、1 枚の面の保存を送り終え（一覧へ戻るときに送り終えている。念のため）、一括で替わる写真を 1 枚の面に持っていたら
   * 手放す（次に開いたときに今の補正で開く。古い版で保存して 409 にしない）。送り終えられなければ false。
   */
  const releaseOpenedTargets = async (
    photoIds: readonly string[],
    beforeRelease?: () => void,
  ): Promise<boolean> => {
    const session = develop.developSessionRef.current;
    if (session?.saver?.hasPendingWork()) {
      const left = await develop.leaveEditing({ release: false });
      if (!left) return false;
    }
    beforeRelease?.();
    const keys = new Set(photoIds.map((photoId) => cloudKey(photoId)));
    const current = develop.developSessionRef.current;
    if (current && keys.has(current.key)) develop.releaseDevelopSession();
    const opened = open.openedRef.current;
    if (opened && keys.has(opened.key)) open.clearOpened();
    return true;
  };

  /** 1 枚の保存（打ち切った・拠点や権限が変わったら送らない）。 */
  const saveFor =
    (run: BulkRun): BrowserPhotoBulkSave =>
    async (photoId, settings, options) => {
      const access = latestAccessRef.current;
      if (run.cancel.signal.aborted || access.spotId !== run.spotId || !access.canEdit) {
        run.cancel.abort();
        throw new Error("photo editing bulk was cancelled");
      }
      return library.saveDevelopSettings(photoId, settings, options);
    };

  /**
   * 一括を走らせる共通の枠（`operation` を `bulk` にしてほかの操作を止め、進み具合を出し、終わったら状態欄に 1 行）。`work` は
   * 状態欄の 1 行（と［元に戻す］の材料）を返す。打ち切った・画面を閉じたら何も出さない。
   */
  const runBulk = async (
    total: number,
    progressText: (done: number) => string,
    work: (
      run: BulkRun,
      showProgress: (done: number) => void,
      alive: () => boolean,
    ) => Promise<{ status: FooterStatus; undo: BrowserPhotoBulkUndoEntry[] } | null>,
    undoSelectionKeys?: readonly string[],
  ) => {
    const run: BulkRun = { stop: new AbortController(), cancel: new AbortController(), spotId };
    runRef.current = run;
    operationRef.current = "bulk";
    saveGenerationRef.current += 1;
    const alive = () => mountedRef.current && !run.cancel.signal.aborted;
    const fileName = `${total} 枚`;
    const showProgress = (done: number) => {
      if (alive()) setOperation({ kind: "bulk", fileName, deleting: false, progressText: progressText(done) });
    };
    showProgress(0);
    setStopping(false);
    setStatus(null);
    let finished: { status: FooterStatus; undo: BrowserPhotoBulkUndoEntry[] } | null = null;
    try {
      finished = await work(run, showProgress, alive);
    } catch (error) {
      console.warn("[photo-editing] bulk failed", error);
      finished = { status: { kind: "error", text: PHOTO_EDITING_BULK_FAILED_TEXT }, undo: [] };
    } finally {
      if (runRef.current === run) runRef.current = null;
      operationRef.current = null;
      if (mountedRef.current) {
        setOperation(null);
        setStopping(false);
      }
    }
    if (!finished || !alive()) {
      setPreservedSelectionKeys([]);
      return;
    }
    let status = finished.status;
    if (finished.undo.length > 0 && (status.kind === "notice" || status.kind === "error")) {
      undoTokenRef.current += 1;
      const token = undoTokenRef.current;
      const retainedKeys = undoSelectionKeys ?? selectedKeys;
      undoRef.current = {
        token,
        entries: finished.undo,
        selectedKeys: retainedKeys,
        selectionKey: selectionKeyOf(retainedKeys),
        listKey: listKeyRef.current,
        spotId: run.spotId,
      };
      status = { ...status, action: { label: PHOTO_EDITING_BULK_UNDO_LABEL, onClick: () => void undoHandlerRef.current(token) } };
    } else {
      setPreservedSelectionKeys([]);
    }
    undoStatusRef.current = status;
    setStatus(status);
  };

  /** 選んだ写真に一括で当てる（貼り付け・プリセット 100%）。 */
  const runApply = async (spec: BulkSpec, items: readonly BrowserItem[]) => {
    if (
      operationRef.current ||
      params.blocked ||
      !active ||
      (!browserRuntime && wide) ||
      items.length === 0 ||
      !latestAccessRef.current.canEdit
    ) return;
    dropUndo();
    const selectedKeysAtStart = items.map((item) => item.key);
    setPreservedSelectionKeys(selectedKeysAtStart);
    const action: PhotoEditingBulkAction = spec.kind === "paste" ? { kind: "paste" } : { kind: "preset", name: spec.preset.name };
    await runBulk(
      items.length,
      (done) => photoEditingBulkProgressText(action, done, items.length),
      async (run, showProgress, alive) => {
        // 借りた engine（プリセットだけ。終えたら返す）
        let lease: EngineLease | null | undefined;
        try {
          let photos: BrowserPhotoBulkPhoto[] = items.map((item) => item.photo);
          if (!(await releaseOpenedTargets(items.map((item) => item.photo.id), () => {
            // leaveEditingがpending saveをflushした後、releaseDevelopSessionがsnapshotを消す前に退避する。
            photos = items.map((item) => latestPhoto(item.photo));
          }))) {
            return { status: { kind: "error", text: PHOTO_EDITING_BULK_FAILED_TEXT }, undo: [] };
          }
          let recipe: BrowserPhotoBulkRecipe;
          if (spec.kind === "paste") {
            recipe = { kind: "paste", copied: spec.copied };
          } else {
            lease = await acquireEngine();
            const engine = lease?.engine ?? null;
            if (!engine || !(await check(() => engine.supportsPresetFromMeta()))) {
              return { status: { kind: "error", text: PHOTO_EDITING_BULK_ENGINE_UNAVAILABLE_TEXT }, undo: [] };
            }
            const { xmp, name } = spec.preset;
            // 段 2 で扱えない項目が残るプリセットは、どの写真にも当てられない（始める前に 1 回確かめる）
            const probe = await engine.applyPreset(xmp, neutralDevelopSettings(), 1, { workMetaJson: null }).catch(() => null);
            if (!probe?.converted) {
              return { status: { kind: "error", text: photoEditingBulkPresetUnusableText(name) }, undo: [] };
            }
            recipe = { kind: "preset", name, apply: (base, asShot) => engine.applyPreset(xmp, base, 1, asShot) };
          }
          if (!alive()) return null;
          const result = await runBrowserPhotoBulkApply({
            photos,
            recipe,
            save: saveFor(run),
            workDownload: (photoId, signal) => {
              const photo = photos.find((candidate) => candidate.id === photoId);
              const settings = readDevelopSettings(photo?.developSettings);
              const base = typeof settings === "object" && settings !== null && "base" in settings ? settings.base : null;
              return library.ensureWorkingCopy(photoId, {
                ...(signal ? { signal } : {}),
                ...(photo
                  ? {
                      sourceContext: {
                        hasSavedDevelopSettings: hasSavedDevelopSettings(photo),
                        hasDevelopEdits: settings !== null && !isNeutralDevelopSettings(settings),
                        baseVersion: typeof base === "string" ? base : null,
                      },
                    }
                  : {}),
              });
            },
            stopSignal: run.stop.signal,
            cancelSignal: run.cancel.signal,
            onProgress: ({ done }) => showProgress(done),
            onPhotoDone: (photoId, outcome) => {
              if (!alive()) return;
              if (outcome.kind === "applied") {
                replaceCloudPhoto(outcome.photo);
                // 補正後のプレビューはワーカーが描く。描けるまで一覧を読み直す（タイルは今の画のまま）
                markEditedPreviewPending(photoId);
              } else if (outcome.kind === "stale") {
                replaceCloudPhoto(outcome.photo);
              }
            },
          });
          return {
            status: photoEditingBulkResultStatus({
              action,
              counts: result.counts,
              lockedReasons: result.lockedReasons,
              stopped: result.stopped,
            }),
            undo: result.undo,
          };
        } finally {
          lease?.release();
        }
      },
      selectedKeysAtStart,
    );
  };

  /** ［元に戻す］: 一括で保存した写真を、当てる前の補正に戻す（1 回きり）。 */
  const runUndo = async (token: number) => {
    const entry = undoRef.current;
    if (
      !entry ||
      entry.token !== token ||
      operationRef.current ||
      params.blocked ||
      !active ||
      !latestAccessRef.current.canEdit
    ) return;
    dropUndo();
    setPreservedSelectionKeys(entry.selectedKeys);
    const entries = entry.entries;
    await runBulk(
      entries.length,
      (done) => photoEditingBulkUndoProgressText(done, entries.length),
      async (run, showProgress, alive) => {
        if (!(await releaseOpenedTargets(entries.map((item) => item.photoId)))) {
          return { status: { kind: "error", text: PHOTO_EDITING_BULK_FAILED_TEXT }, undo: [] };
        }
        if (!alive()) return null;
        const result = await runBrowserPhotoBulkUndo({
          entries,
          save: saveFor(run),
          stopSignal: run.stop.signal,
          cancelSignal: run.cancel.signal,
          onProgress: ({ done }) => showProgress(done),
          onPhotoDone: (photoId, outcome) => {
            if (!alive()) return;
            if (outcome.kind === "undone") {
              replaceCloudPhoto(outcome.photo);
              markEditedPreviewPending(photoId);
            } else if (outcome.kind === "stale") {
              replaceCloudPhoto(outcome.photo);
            }
          },
        });
        return { status: photoEditingBulkUndoResultStatus({ counts: result.counts, stopped: result.stopped }), undo: [] };
      },
    );
  };
  undoHandlerRef.current = runUndo;

  /** ⌥⇧⌘C: 1 枚だけ選んでいる写真の保存済みの補正をコピーする。 */
  const copySelected = () => {
    if (selectedItems.length !== 1) {
      setStatus({ kind: "notice", text: PHOTO_EDITING_BULK_COPY_NEEDS_ONE_TEXT });
      return;
    }
    const photo = latestPhoto(selectedItems[0]!.photo);
    if (!hasSavedDevelopSettings(photo)) {
      setStatus({ kind: "notice", text: PHOTO_EDITING_BULK_COPY_NO_SETTINGS_TEXT });
      return;
    }
    const saved = isEditableDevelopSettings(photo.developSettings) ? readDevelopSettings(photo.developSettings) : null;
    if (!saved) {
      setStatus({ kind: "notice", text: PHOTO_EDITING_BULK_COPY_UNREADABLE_TEXT });
      return;
    }
    // 1 枚で開いたときの補正と同じ形にしてから写す（幾何・絶対のホワイトバランスは写さない）
    writePhotoEditingSettingsClipboard(copyDevelopSettings(browserEditingDevelopSettings(saved)));
    setStatus({ kind: "notice", text: PHOTO_EDITING_COPY_SETTINGS_DONE_TEXT });
  };

  /** ⌥⇧⌘V / メニューの「補正を貼り付け」: 選んでいる写真へ貼り付ける。 */
  const pasteSelected = () => {
    if (operationRef.current) return;
    if (!latestAccessRef.current.canEdit) {
      setStatus({ kind: "notice", text: BROWSER_PHOTO_EDITING_READ_ONLY_TEXT });
      return;
    }
    const copied = readPhotoEditingSettingsClipboard();
    if (!copied) {
      setStatus({ kind: "notice", text: `${PHOTO_EDITING_BULK_PASTE_NEEDS_COPY_TEXT}。` });
      return;
    }
    if (selectedItems.length === 0) {
      setStatus({ kind: "notice", text: PHOTO_EDITING_BULK_PASTE_NEEDS_SELECTION_TEXT });
      return;
    }
    void runApply({ kind: "paste", copied: copied.settings }, selectedItems);
  };

  const keyHandlersRef = useRef({ copySelected, pasteSelected });
  keyHandlersRef.current = { copySelected, pasteSelected };
  const keysEnabled = params.keysEnabled && active && browserRuntime && wide;
  useEffect(() => {
    if (!keysEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !isWithinPhotoEditingScope(root, event.target)) return;
      const key = resolveBrowserPhotoEditingKey(event, { typing: isPhotoEditingTypingTarget(event.target) });
      if (key !== "copy" && key !== "paste") return;
      event.preventDefault();
      // 押しっぱなしの繰り返し・処理中は扱わない（処理中は状態欄に進み具合が出ている）
      if (event.repeat || operationRef.current) return;
      if (key === "copy") keyHandlersRef.current.copySelected();
      else keyHandlersRef.current.pasteSelected();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keysEnabled, operationRef, rootRef]);

  const stop = () => {
    const run = runRef.current;
    if (!run || run.stop.signal.aborted) return;
    run.stop.abort();
    setStopping(true);
  };

  const running = operation?.kind === "bulk";
  const copyUnavailableReason = (() => {
    if (selectedItems.length !== 1) return PHOTO_EDITING_BULK_COPY_NEEDS_ONE_TEXT;
    const photo = latestPhoto(selectedItems[0]!.photo);
    if (!hasSavedDevelopSettings(photo)) return PHOTO_EDITING_BULK_COPY_NO_SETTINGS_TEXT;
    if (!isEditableDevelopSettings(photo.developSettings) || !readDevelopSettings(photo.developSettings)) {
      return PHOTO_EDITING_BULK_COPY_UNREADABLE_TEXT;
    }
    return undefined;
  })();
  const presets: BrowserPhotoBulkMenuPresets | null =
    presetSupport.status === "unsupported"
      ? null
      : presetSupport.status === "supported"
        ? {
            status: "ready",
            builtin: presetSupport.builtin.map((preset) => ({
              key: builtinPhotoPresetKey(preset.id),
              name: builtinPhotoPresetDisplayName(preset),
              xmp: preset.xmp,
            })),
            builtinFailed: presetSupport.builtinFailed,
            spot: (spotPresetsQuery.data?.presets ?? []).map((preset) => ({
              key: spotPhotoPresetKey(preset.id),
              name: preset.name,
              xmp: preset.xmp,
            })),
            spotStatus: spotPresetsQuery.isError ? "failed" : spotPresetsQuery.isSuccess ? "ready" : "loading",
          }
        : { status: "loading" };

  const menu: BrowserPhotoBulkMenuProps | null = menuAvailable
    ? {
        compact: !wide,
        running,
        stopping,
        disabled: params.blocked || (operation !== null && !running),
        canPaste: clipboard !== null && (wide || selectedItems.length > 0),
        pasteUnavailableReason:
          clipboard === null ? PHOTO_EDITING_BULK_PASTE_NEEDS_COPY_TEXT : PHOTO_EDITING_BULK_PASTE_NEEDS_SELECTION_TEXT,
        canCopy: copyUnavailableReason === undefined,
        copyUnavailableReason,
        // 今回の狭幅追加はコピー／貼り付けだけ。PC の一括プリセットの範囲は変えない。
        presets: wide ? presets : null,
        onOpenChange: (nextOpen) => {
          if (!nextOpen || !wide) return;
          setMenuRequested(true);
          ensurePresetSupport();
          if (spotPresetsQuery.isError) void spotPresetsQuery.refetch();
        },
        onCopy: copySelected,
        onPaste: pasteSelected,
        onApplyPreset: (preset) => void runApply({ kind: "preset", preset }, selectedItems),
        onStop: stop,
      }
    : null;

  return { menu };
}
