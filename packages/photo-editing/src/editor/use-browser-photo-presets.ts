"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import {
  photoDevelopDiagnosticsEnabled,
  type DevelopEngine,
  type DevelopPresetResult,
} from "../develop-engine/develop-engine-client";
import type { DevelopSize } from "../develop-engine/develop-geometry";
import type { PresetMasksPlacement } from "../develop-engine/develop-preset-masks";
import {
  developSettingsKey,
  presetDevelopSettings,
  readDevelopSettings,
  sameDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import { photoEditingPresetInvalidError, photoEditingPresetInvalidText } from "../photo-library-messages";

import type { PhotoEditingSliderPhase } from "./photo-editing-slider";
import type { PhotoEditingPresetReadResult, PhotoEditingPresetTarget } from "./photo-editing-presets-panel";

/** 行に載せてから仮の表示を始める・離れてから戻すまでの待ち（行の上を通り過ぎただけでは描かない）。 */
export const BROWSER_PRESET_PREVIEW_DELAY_MS = 120;
/** 仮の表示を粗い画で見せてから、止まったままなら丁寧な画に差し替えるまでの待ち（#127）。 */
export const BROWSER_PRESET_PREVIEW_FINAL_DELAY_MS = 300;
/** プリセットを当てた結果を覚えておく数（超えたら捨てて作り直す）。 */
const PRESET_RESULT_CACHE_LIMIT = 48;
/** 新しく当てたときの適用量（%）と、動かせる範囲。 */
export const BROWSER_PRESET_AMOUNT_DEFAULT = 100;
export const BROWSER_PRESET_AMOUNT_MAX = 150;

/** 最後に当てたプリセット（保存しない画面の状態。写真ごとに 1 つ）。 */
type RememberedPreset = {
  photoKey: string;
  presetKey: string;
  /** プリセットの XMP（適用量を変えるときに土台へ当て直す） */
  xmp: string;
  /** 当てる直前の編集内容（別のプリセットに替える・「なし」で戻す・適用量を変えるときの土台） */
  base: DevelopSettings;
  /** 当てた結果（今の編集内容がこれと同じ間だけ、選ばれた表示にする） */
  resultKey: string;
  /** 適用量（%。保存しない画面の状態。新しく当てたときは 100） */
  amount: number;
};

/** 適用量を動かしている間に写真に仮に見せる編集内容（状態・履歴・自動保存には入れない。札も出さない）。 */
type AmountPreview = {
  photoKey: string;
  settings: DevelopSettings;
  /** 仮の結果を作ったときの編集内容（選ばれているプリセットの結果。変わったら使わない） */
  forSettingsKey: string;
};

/** 写真に仮に見せているプリセット（状態・履歴・自動保存には入れない）。 */
type PresetPreview = {
  photoKey: string;
  name: string;
  settings: DevelopSettings;
  /** 仮の結果を作ったときの編集内容（編集内容が変わったら、この仮の表示は使わない） */
  forSettingsKey: string;
};

/**
 * ブラウザ版の右パネルのプリセット（NIHO Photo 段 1 F2b 移行元設計。公開済みの wasm の `presetSettings` だけで作る分）。wasm で開いた
 * 写真を 1 枚で見ている間、プリセットを 100% で当てる・別のプリセットに替える・「なし」で外す。
 *
 * - 当てるのは取り消しの 1 単位（`commitEdit`。自動保存と丁寧な描画もそこに任せる）。結果は当てる前の `engine`・`look`・`base` と
 *   切り抜きを保つ（`presetDevelopSettings`）。変換できない（`converted: false`）プリセットは当てず、理由を 1 行
 * - 「選ばれているプリセット」は保存せず、導出する: 最後に当てたプリセットの当てる直前の編集内容と当てた結果を覚え、今の編集内容が
 *   その結果と同じ間だけ選ばれた表示にする（スライダーを動かすと消え、取り消しで結果に戻ると表示も戻る）。選ばれている間に別の
 *   プリセットを押すと覚えている土台に当て直し（替える。重ねない）、選ばれていなければ今の編集内容の上に当てる
 * - 覚えているプリセットは、編集内容がまるごと入れ替わった（別の写真・別の端末の補正の読み直し）・写真を離れたら捨てる。当てて
 *   いる途中の結果も捨てる（世代番号）
 * - 行にマウスを載せた・キーボードのフォーカスが来たプリセットは、当てた結果を写真に仮に見せる（`previewSettings`。面の描画が
 *   それを描く）。ドラッグ・「補正前」・当てている途中・押せない間は仮の表示をやめる
 * - 押した・乗せたときは engine の `yieldToEdit` で次の見本を出させない（当てた結果・仮の表示の描画を見本の後ろで待たせない。#126）
 * - 押して当てた結果は、面の描画が先に粗い画を出してから丁寧な画に差し替える（`coarseFirstKeyRef` に当てた結果の key を 1 回だけ
 *   置き、面の描画が受け取ったら消す。#127）。乗せた仮の表示も粗い画から始める（面の描画が決める）
 * - 適用量（0〜150%。選ばれている間だけ。`applyPreset` のある wasm）: 動かしている間は覚えている土台に当て直した結果を仮に見せ
 *   （`previewSettings`・`previewInteractive` で速い描き方。札は出さない）、離したら確定する（取り消しの 1 単位。覚えている結果と
 *   適用量を入れ替え、選ばれた表示は続く）。0% は当てる直前の補正と同じ絵のまま選ばれた表示で、そこで「なし」を押すと覚えている
 *   プリセットを外すだけ（補正は変わらない）
 * - プリセットが部分補正（Lightroom のマスク）を持つときは、開いている写真の作業画像の大きさ（`readSourceSize`）を読み、写真の
 *   幾何で作業画像の座標へ写して写真のマスクと置き換える（`presetDevelopSettings`）。大きさを読めなければマスクは当てる前のまま
 */
export function useBrowserPhotoPresets(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  readyDevelopEngine: () => Promise<DevelopEngine | null>;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null。プリセットを当てられない） */
  photoKey: string | null;
  /** 当てられない（閲覧のみ・書き出し / 消している途中・離れる処理の途中） */
  disabled: boolean;
  settingsKey: string;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 取り消しの 1 単位として編集内容を確定する（直せなければ false） */
  commitEdit: (next: DevelopSettings) => boolean;
  /** スライダーのつまみを動かしている */
  dragging: boolean;
  /** 「補正前」を見せている */
  compareOriginal: boolean;
  /** 編集内容がまるごと入れ替わった・写真を離れたときに呼ばれる係を入れる先（`useBrowserPhotoEditSettings` が呼ぶ） */
  editResetHandlerRef: MutableRefObject<(() => void) | null>;
  /**
   * 開いている写真の作業画像（向き反映済み・幾何の前）の大きさ。マスクを持つプリセットを当てるときだけ読む（無い・読めなければ
   * プリセットのマスクを置かない）
   */
  readSourceSize?: () => Promise<DevelopSize | null>;
}) {
  const {
    mountedRef,
    engineRef,
    readyDevelopEngine,
    photoKey,
    disabled,
    settingsKey,
    settingsRef,
    commitEdit,
    dragging,
    compareOriginal,
  } = params;
  const [remembered, setRemembered] = useState<RememberedPreset | null>(null);
  const rememberedRef = useRef<RememberedPreset | null>(null);
  const [applyingPresetKey, setApplyingPresetKeyState] = useState<string | null>(null);
  const applyingPresetKeyRef = useRef<string | null>(null);
  const setApplyingPresetKey = useCallback((key: string | null) => {
    applyingPresetKeyRef.current = key;
    setApplyingPresetKeyState(key);
  }, []);
  const availableSpotPresetKeysRef = useRef<ReadonlySet<string> | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PresetPreview | null>(null);
  // 適用量: 動かしている途中の値（離して確定するまで）・仮の表示・動かしている〜確定し終えるまで
  const [amountDraft, setAmountDraft] = useState<number | null>(null);
  const [amountPreview, setAmountPreview] = useState<AmountPreview | null>(null);
  const [amountActive, setAmountActive] = useState(false);
  /** 適用量の操作の世代（確定した・当て直した・捨てたら進め、古い仮の結果を捨てる） */
  const amountGenerationRef = useRef(0);
  /** 動かしている間に仮に見せたい適用量（前の仮の結果を待っている間に来た最新の 1 つ） */
  const amountWantedRef = useRef<{ selection: RememberedPreset; amount: number } | null>(null);
  const amountRunningRef = useRef(false);
  /** 当てる操作の世代（別のプリセットを押した・写真が変わった・離れたら進め、古い結果を捨てる） */
  const applyGenerationRef = useRef(0);
  /** 載せている行（離れたら null） */
  const hoveredRef = useRef<PhotoEditingPresetTarget | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSequenceRef = useRef(0);
  /** `(プリセットの key, 土台の編集内容)` ごとの当てた結果（仮の表示の後に押したら、待たずに当たる） */
  const resultCacheRef = useRef(new Map<string, Promise<DevelopPresetResult>>());
  /** 押して当てた結果の key（面の描画が先に粗い画を出す。受け取ったら null に戻す。#127） */
  const coarseFirstKeyRef = useRef<string | null>(null);

  // 切替中も利用者が始めた操作は旧engineで確定させる。見本生成はこの待機へ含めない。
  const pendingWorkRef = useRef(new Set<Promise<unknown>>());
  const trackPending = <T,>(work: Promise<T>): Promise<T> => {
    const tracked: Promise<T> = work.finally(() => pendingWorkRef.current.delete(tracked));
    pendingWorkRef.current.add(tracked);
    return tracked;
  };
  const waitForPending = useCallback(async () => {
    while (pendingWorkRef.current.size > 0) {
      await Promise.allSettled([...pendingWorkRef.current]);
    }
  }, []);
  const hasPending = () => pendingWorkRef.current.size > 0;

  const canApply = photoKey !== null && !disabled;
  const previewAllowed = canApply && !dragging && !amountActive && !compareOriginal && applyingPresetKey === null;
  const latestRef = useRef({ photoKey, canApply, previewAllowed, commitEdit });
  latestRef.current = { photoKey, canApply, previewAllowed, commitEdit };
  const readSourceSizeRef = useRef(params.readSourceSize);
  readSourceSizeRef.current = params.readSourceSize;

  /** プリセットのマスクを写真に置くのに要るもの（マスクの無いプリセットは undefined。大きさを読めなければ置かない）。 */
  const masksPlacement = async (result: DevelopPresetResult): Promise<PresetMasksPlacement | undefined> => {
    if (!result.masks || result.masks.length === 0) return undefined;
    let source: DevelopSize | null = null;
    try {
      source = (await readSourceSizeRef.current?.()) ?? null;
    } catch {
      source = null;
    }
    return { masks: result.masks, source };
  };

  /** 今の編集内容が、覚えているプリセットの結果と同じなら返す（選ばれている）。 */
  const currentSelection = (): RememberedPreset | null => {
    const entry = rememberedRef.current;
    if (!entry || entry.photoKey !== latestRef.current.photoKey) return null;
    return entry.resultKey === developSettingsKey(settingsRef.current) ? entry : null;
  };

  const resolvePreset = (preset: PhotoEditingPresetTarget, base: DevelopSettings): Promise<DevelopPresetResult> => {
    const engine = engineRef.current;
    if (!engine) return Promise.reject(photoEditingPresetInvalidError());
    const cache = resultCacheRef.current;
    const cacheKey = `${preset.key}\n${developSettingsKey(base)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    if (cache.size >= PRESET_RESULT_CACHE_LIMIT) cache.clear();
    const pending = engine.presetSettings(preset.xmp, base);
    cache.set(cacheKey, pending);
    // 失敗は覚えない（次に押したときに当て直す）
    pending.catch(() => {
      if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
    });
    return pending;
  };

  const clearHoverTimer = () => {
    if (hoverTimerRef.current === null) return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  /** 載せている行のプリセットを、今の編集内容に当てた結果を仮に見せる（当てられなければ仮の表示をやめる）。 */
  const showPreview = async (preset: PhotoEditingPresetTarget) => {
    const latest = latestRef.current;
    const key = latest.photoKey;
    if (key === null || !latest.previewAllowed) return;
    const current = settingsRef.current;
    const selection = currentSelection();
    // 選ばれているプリセットは、今の画がその結果
    if (selection?.presetKey === preset.key) {
      setPreview(null);
      return;
    }
    const base = selection ? selection.base : current;
    const sequence = ++previewSequenceRef.current;
    let result: DevelopPresetResult | null;
    let placement: PresetMasksPlacement | undefined;
    try {
      result = await resolvePreset(preset, base);
      placement = await masksPlacement(result);
    } catch {
      result = null;
    }
    if (
      !mountedRef.current ||
      sequence !== previewSequenceRef.current ||
      hoveredRef.current?.key !== preset.key ||
      latestRef.current.photoKey !== key ||
      !latestRef.current.previewAllowed ||
      !sameDevelopSettings(settingsRef.current, current)
    ) {
      return;
    }
    const next = result?.converted ? presetDevelopSettings(base, result.settings, placement) : null;
    if (!next || sameDevelopSettings(next, current)) {
      setPreview(null);
      return;
    }
    setPreview({ photoKey: key, name: preset.name, settings: next, forSettingsKey: developSettingsKey(current) });
  };
  const showPreviewRef = useRef(showPreview);
  showPreviewRef.current = (preset) => trackPending(showPreview(preset));

  /**
   * 行にマウスを載せた・キーボードのフォーカスが来た（離れたら null）。少し待ってから仮に見せ、離れたら少し待ってから今の
   * 編集内容の画に戻す（隣の行へ移っただけなら、戻さずに次のプリセットへ差し替える）。
   */
  const requestPreview = useCallback((preset: PhotoEditingPresetTarget | null) => {
    clearHoverTimer();
    hoveredRef.current = preset;
    previewSequenceRef.current += 1;
    // 乗せたら次の見本を出さない（仮の表示の描画を見本の後ろで待たせない。#126）
    if (preset) engineRef.current?.yieldToEdit();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      if (preset) void showPreviewRef.current(preset);
      else setPreview(null);
    }, BROWSER_PRESET_PREVIEW_DELAY_MS);
  }, [engineRef]);

  /** 適用量の途中の値・仮の表示を捨てる（動かしている途中・確定を待っている結果も使わない）。 */
  const resetAmount = () => {
    amountGenerationRef.current += 1;
    amountWantedRef.current = null;
    setAmountDraft(null);
    setAmountPreview(null);
    setAmountActive(false);
  };

  /** 覚えているプリセット・当てている途中の結果・仮の表示を捨てる。 */
  const forget = () => {
    applyGenerationRef.current += 1;
    previewSequenceRef.current += 1;
    clearHoverTimer();
    hoveredRef.current = null;
    rememberedRef.current = null;
    coarseFirstKeyRef.current = null;
    setRemembered(null);
    setApplyingPresetKey(null);
    setApplyError(null);
    setPreview(null);
    resetAmount();
  };
  params.editResetHandlerRef.current = forget;

  /** 拠点から削除されたプリセットの選択・適用量を捨てる（現像設定そのものは保持する）。 */
  const reconcileSpotPresetKeys = useCallback(
    (keys: readonly string[]) => {
      const available = new Set(keys);
      availableSpotPresetKeysRef.current = available;
      const rememberedKey = rememberedRef.current?.presetKey;
      const rememberedWasDeleted =
        rememberedKey?.startsWith("spot:") === true && !available.has(rememberedKey);
      const applyingKey = applyingPresetKeyRef.current;
      const applyingWasDeleted = applyingKey?.startsWith("spot:") === true && !available.has(applyingKey);

      if (applyingWasDeleted) {
        applyGenerationRef.current += 1;
        setApplyingPresetKey(null);
      }
      if (!rememberedWasDeleted) return;

      rememberedRef.current = null;
      setRemembered(null);
      amountGenerationRef.current += 1;
      amountWantedRef.current = null;
      setAmountDraft(null);
      setAmountPreview(null);
      setAmountActive(false);
      setApplyError(null);
      setPreview(null);
    },
    [setApplyingPresetKey],
  );

  /** canonical handoff で、選択・量を保ったままプリセット土台と仮表示を同じmetadataへ結び直す。 */
  const rebaseSettings = useCallback((rebase: (value: DevelopSettings) => DevelopSettings) => {
    const selection = rememberedRef.current;
    if (selection) {
      let resultKey = selection.resultKey;
      try {
        const result = readDevelopSettings(JSON.parse(selection.resultKey) as unknown);
        if (result) resultKey = developSettingsKey(rebase(result));
      } catch {
        // 壊れた画面内keyは選択を維持せず、次の整合判定に任せる。
      }
      const next = { ...selection, base: rebase(selection.base), resultKey };
      rememberedRef.current = next;
      setRemembered(next);
      if (amountWantedRef.current?.selection === selection) {
        amountWantedRef.current = { ...amountWantedRef.current, selection: next };
      }
    }
    setAmountPreview((current) => current ? {
      ...current,
      settings: rebase(current.settings),
      forSettingsKey: (() => {
        try {
          const value = readDevelopSettings(JSON.parse(current.forSettingsKey) as unknown);
          return value ? developSettingsKey(rebase(value)) : current.forSettingsKey;
        } catch {
          return current.forSettingsKey;
        }
      })(),
    } : null);
    setPreview((current) => current ? {
      ...current,
      settings: rebase(current.settings),
      forSettingsKey: (() => {
        try {
          const value = readDevelopSettings(JSON.parse(current.forSettingsKey) as unknown);
          return value ? developSettingsKey(rebase(value)) : current.forSettingsKey;
        } catch {
          return current.forSettingsKey;
        }
      })(),
    } : null);
    resultCacheRef.current.clear();
  }, []);

  /** プリセットを 100% で当てる（選ばれているプリセットがあれば、その当てる前の編集内容に当て直す）。 */
  const apply = async (preset: PhotoEditingPresetTarget) => {
    const latest = latestRef.current;
    const key = latest.photoKey;
    if (key === null || !latest.canApply || applyingPresetKeyRef.current !== null || amountActive) return;
    if (
      preset.key.startsWith("spot:") &&
      availableSpotPresetKeysRef.current !== null &&
      !availableSpotPresetKeysRef.current.has(preset.key)
    ) {
      return;
    }
    const current = settingsRef.current;
    const selection = currentSelection();
    if (selection?.presetKey === preset.key) return;
    const base = selection ? selection.base : current;
    const generation = ++applyGenerationRef.current;
    resetAmount();
    const isCurrent = () =>
      mountedRef.current &&
      generation === applyGenerationRef.current &&
      latestRef.current.photoKey === key &&
      (!preset.key.startsWith("spot:") ||
        availableSpotPresetKeysRef.current === null ||
        availableSpotPresetKeysRef.current.has(preset.key)) &&
      // 当てている間に編集内容が変わっていたら（スライダー・取り消し）、古い土台の結果を当てない
      sameDevelopSettings(settingsRef.current, current);
    setApplyingPresetKey(preset.key);
    setApplyError(null);
    // 押したら次の見本を出さない（当てた結果の描画を見本の後ろで待たせない。#126）
    engineRef.current?.yieldToEdit();
    const resolveStartedAt = photoDevelopDiagnosticsEnabled() ? performance.now() : null;
    const invalidText = photoEditingPresetInvalidText();
    try {
      const result = await resolvePreset(preset, base);
      if (resolveStartedAt !== null) {
        console.info("[photo-develop-ui-perf]", {
          stage: "presetResolved",
          durationMs: Math.max(0, performance.now() - resolveStartedAt),
        });
      }
      const placement = await masksPlacement(result);
      if (!isCurrent()) return;
      // 当てた結果に段 2 で扱えない項目がある（変換できない）ときは当てない（黙って落とさない）
      if (!result.converted) {
        setApplyError(invalidText);
        return;
      }
      const next = presetDevelopSettings(base, result.settings, placement);
      const nextKey = developSettingsKey(next);
      coarseFirstKeyRef.current = nextKey;
      if (!latestRef.current.commitEdit(next)) {
        coarseFirstKeyRef.current = null;
        return;
      }
      const entry: RememberedPreset = {
        photoKey: key,
        presetKey: preset.key,
        xmp: preset.xmp,
        base,
        resultKey: nextKey,
        amount: BROWSER_PRESET_AMOUNT_DEFAULT,
      };
      rememberedRef.current = entry;
      setRemembered(entry);
    } catch {
      if (isCurrent()) setApplyError(invalidText);
    } finally {
      if (mountedRef.current && generation === applyGenerationRef.current) setApplyingPresetKey(null);
    }
  };

  /** 「なし」: 選ばれているプリセットを外し、当てる前の編集内容に戻す（取り消しの 1 単位）。 */
  const clear = () => {
    const selection = currentSelection();
    if (!selection || !latestRef.current.canApply || applyingPresetKeyRef.current !== null || amountActive) return;
    applyGenerationRef.current += 1;
    resetAmount();
    setApplyingPresetKey(null);
    setApplyError(null);
    // 適用量 0%（当てる直前の補正と同じ）の間は補正が変わらないので、覚えているプリセットを外すだけ
    if (sameDevelopSettings(selection.base, settingsRef.current)) {
      rememberedRef.current = null;
      setRemembered(null);
      return;
    }
    latestRef.current.commitEdit(selection.base);
  };

  /** 選ばれているプリセットを、覚えている土台に適用量（%）で当て直した編集内容（当てられなければ null）。 */
  const resolveAmount = async (selection: RememberedPreset, amount: number): Promise<DevelopSettings | null> => {
    const engine = engineRef.current;
    if (!engine) return null;
    try {
      const result = await engine.applyPreset(selection.xmp, selection.base, amount / 100);
      if (!result.converted) return null;
      // 0% は Rust 側でも base と同じだが、画面の枠の補完でも byte を変えない。
      if (amount === 0) return selection.base;
      return presetDevelopSettings(selection.base, result.settings, await masksPlacement(result));
    } catch {
      return null;
    }
  };

  /** 動かしている間の仮の表示（前の結果を待っている間に来た値は、最新の 1 つだけ当て直す）。 */
  const runAmountPreview = async () => {
    if (amountRunningRef.current) return;
    amountRunningRef.current = true;
    try {
      while (amountWantedRef.current) {
        const { selection, amount } = amountWantedRef.current;
        amountWantedRef.current = null;
        const generation = amountGenerationRef.current;
        const next = await resolveAmount(selection, amount);
        if (
          !next ||
          !mountedRef.current ||
          generation !== amountGenerationRef.current ||
          rememberedRef.current !== selection ||
          currentSelection() !== selection
        ) {
          continue;
        }
        setAmountPreview({ photoKey: selection.photoKey, settings: next, forSettingsKey: selection.resultKey });
      }
    } finally {
      amountRunningRef.current = false;
    }
  };

  /** 離した適用量を確定する（取り消しの 1 単位。覚えている結果と適用量を入れ替え、選ばれた表示は続く）。 */
  const commitAmount = async (selection: RememberedPreset, amount: number) => {
    const generation = ++amountGenerationRef.current;
    amountWantedRef.current = null;
    const current = settingsRef.current;
    const next = amount === selection.amount ? current : await resolveAmount(selection, amount);
    if (
      !mountedRef.current ||
      generation !== amountGenerationRef.current ||
      rememberedRef.current !== selection ||
      !sameDevelopSettings(settingsRef.current, current)
    ) {
      return;
    }
    if (!next) {
      setApplyError(photoEditingPresetInvalidText());
    } else if (latestRef.current.commitEdit(next)) {
      const entry: RememberedPreset = { ...selection, amount, resultKey: developSettingsKey(next) };
      rememberedRef.current = entry;
      setRemembered(entry);
    }
    // 確定した画を描くまで、仮の表示（速い描き方）を続ける（同じ描画の中で入れ替える）
    setAmountDraft(null);
    setAmountPreview(null);
    setAmountActive(false);
  };

  /** 「適用量」のスライダー（%。`drag` は仮の表示、`input` は値だけ、`commit` で確定）。 */
  const changeAmount = (value: number, phase: PhotoEditingSliderPhase) => {
    const selection = currentSelection();
    if (!selection || !latestRef.current.canApply || applyingPresetKeyRef.current !== null) return;
    const amount = Math.min(BROWSER_PRESET_AMOUNT_MAX, Math.max(0, Math.round(value)));
    setAmountDraft(amount);
    setApplyError(null);
    if (phase === "input") return;
    setAmountActive(true);
    if (phase === "drag") {
      amountWantedRef.current = { selection, amount };
      void trackPending(runAmountPreview());
      return;
    }
    void trackPending(commitAmount(selection, amount));
  };

  /** 取り込む前に、段 2 の wasm で読めて当てられるプリセットかを確かめる（読めなければ reject）。 */
  const readPreset = useCallback(
    async (xmp: string): Promise<PhotoEditingPresetReadResult> => {
      let engine: DevelopEngine | null;
      try {
        engine = await readyDevelopEngine();
      } catch {
        throw photoEditingPresetInvalidError();
      }
      if (!engine) throw photoEditingPresetInvalidError();
      let result: DevelopPresetResult;
      try {
        result = await engine.presetSettings(xmp, null);
      } catch {
        throw photoEditingPresetInvalidError();
      }
      // 何も当てていない写真にも当てられないプリセットは、取り込んでも使えない
      if (!result.converted) throw photoEditingPresetInvalidError();
      return { name: result.name, unsupported: result.unsupported };
    },
    [readyDevelopEngine],
  );

  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    },
    [],
  );

  const selected =
    remembered !== null && photoKey !== null && remembered.photoKey === photoKey && remembered.resultKey === settingsKey
      ? remembered
      : null;
  const appliedPresetKey = selected?.presetKey ?? null;
  // 適用量の仮の表示は、選ばれている結果の上で・当てられる間だけ持つ（取り消しなどで編集内容が変わったら捨てる）
  const amountPreviewKept =
    amountPreview !== null &&
    canApply &&
    selected !== null &&
    amountPreview.photoKey === photoKey &&
    amountPreview.forSettingsKey === settingsKey;
  if (amountPreview !== null && !amountPreviewKept) setAmountPreview(null);
  if (selected === null && (amountDraft !== null || amountActive)) {
    setAmountDraft(null);
    setAmountActive(false);
  }
  const activeAmountPreview = amountPreviewKept && !compareOriginal ? amountPreview : null;
  // 仮の表示は、作ったときの編集内容のまま・当てられる間だけ持つ。編集内容が変わった（当てた・取り消した）・ドラッグ・当てている
  // 途中・押せなくなったら捨てる（行を離れた知らせを取りこぼしても、後から仮の表示が戻らない）。「補正前」の間は持ったまま見せない
  const previewKept =
    preview !== null &&
    canApply &&
    !dragging &&
    !amountActive &&
    applyingPresetKey === null &&
    preview.photoKey === photoKey &&
    preview.forSettingsKey === settingsKey;
  if (preview !== null && !previewKept) setPreview(null);
  const activePreview = previewKept && !compareOriginal && activeAmountPreview === null ? preview : null;

  return {
    canApply,
    /** 選ばれているプリセット（今の編集内容が、最後に当てたプリセットの結果と同じ間だけ） */
    appliedPresetKey,
    applyingPresetKey,
    applyError,
    /** 「なし」を押せる（選ばれているプリセットがある） */
    canClear: canApply && appliedPresetKey !== null,
    apply: (preset: PhotoEditingPresetTarget) => trackPending(apply(preset)),
    waitForPending,
    hasPending,
    clear,
    reconcileSpotPresetKeys,
    rebaseSettings,
    requestPreview,
    /** 写真に仮に見せる編集内容（無ければ null。適用量を動かしている間はその結果） */
    previewSettings: activeAmountPreview?.settings ?? activePreview?.settings ?? null,
    /** 仮の表示を速い描き方で描く（適用量を動かしている間） */
    previewInteractive: activeAmountPreview !== null && amountActive,
    /** 仮に見せているプリセットの名前（写真の左上の札。適用量の仮の表示には出さない） */
    previewName: activePreview?.name ?? null,
    readPreset,
    /** 選ばれているプリセットの適用量（%。選ばれていなければ null） */
    amount: selected ? (amountDraft ?? selected.amount) : null,
    changeAmount,
    /** 適用量を動かしている〜確定し終えるまで（見本を作り直さない） */
    amountActive,
    /** 選ばれているプリセットの当てる直前の編集内容（見本の土台。選ばれていなければ null） */
    selectedBase: selected?.base ?? null,
    /** プリセットを土台に 100% で当てた結果（仮の表示・当てる操作と同じ覚えを使う） */
    resolvePreset,
    /** 押して当てた結果の key（面の描画が 1 回だけ受け取り、先に粗い画を出す。#127） */
    coarseFirstKeyRef,
  };
}

export type BrowserPhotoPresets = ReturnType<typeof useBrowserPhotoPresets>;
