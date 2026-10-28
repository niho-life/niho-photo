"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Aperture,
  Blend,
  CircleDashed,
  Crop,
  ChevronLeft,
  Droplet,
  Grid2x2,
  Palette,
  Pipette,
  Redo2,
  Rows2,
  SquareSplitHorizontal,
  Sparkles,
  Sun,
  Triangle,
  Undo2,
  type LucideIcon,
} from "lucide-react";

import type { PhotoEditingSettings } from "../photo-editing-types";
import type {
  BrowserPhotoExportChoices,
  BrowserPhotoExportFormat,
  BrowserPhotoExportSize,
} from "../browser-photo-export";
import { workWaitText, type WorkWait } from "../develop-engine/develop-work-wait";
import {
  visiblePhotoEditingAdjustmentGroups,
  type PhotoEditingAdjustmentGroup,
  type PhotoEditingAdjustmentGroupId,
  type PhotoEditingControlKey,
} from "../photo-editing-adjustments";
import {
  BROWSER_PHOTO_EDITING_READ_ONLY_TEXT,
  PHOTO_EDITING_COLOR_GRADING_TITLE,
  PHOTO_EDITING_COMPARE_ORIGINAL_LABEL,
  PHOTO_EDITING_COMPARE_STACKED_LABEL,
  PHOTO_EDITING_EXPORT_LABEL,
  PHOTO_EDITING_HSL_TITLE,
  PHOTO_EDITING_MOBILE_BACK_LABEL,
  PHOTO_EDITING_MOBILE_EDITOR_LABEL,
  PHOTO_EDITING_MOBILE_PRESETS_LABEL,
  PHOTO_EDITING_MOBILE_TOOLS_LABEL,
  PHOTO_EDITING_POINT_COLOR_TITLE,
  PHOTO_EDITING_REDO_LABEL,
  PHOTO_EDITING_RESET_LABEL,
  PHOTO_EDITING_RESET_WHITE_BALANCE_LABEL,
  PHOTO_EDITING_RETRY_LABEL,
  PHOTO_EDITING_TOOL_MASK_LABEL,
  PHOTO_EDITING_UNDO_LABEL,
  photoEditingMobileItemsLabel,
} from "../photo-editing-copy";
import { hasPhotoEditingColorGradingEdits } from "../photo-editing-color-grading";
import { hasPhotoEditingHslEdits } from "../photo-editing-hsl";
import type { PhotoSaveRoute } from "../save-photos-to-device";
import type { DevelopGeometry, DevelopSize } from "../develop-engine/develop-geometry";
import { usePhotoEditingLayerHistory } from "../use-photo-editing-layer-history";
import { cn } from "niho-ui/cn";

import { BrowserPhotoFavoriteButton, type BrowserPhotoFavoriteControl } from "./browser-photo-editing-favorite-button";
import { BROWSER_WHITE_BALANCE_SOURCE } from "./browser-photo-editing-model";
import { BrowserPhotoMobileExportSheet } from "./browser-photo-editing-mobile-export-sheet";
import {
  BrowserPhotoEditingMobilePresets,
  type BrowserPhotoEditingMobilePresetsProps,
} from "./browser-photo-editing-mobile-presets";
import {
  resolvePhotoEditingControlSliders,
  type PhotoEditingSettingsUpdate,
  type PhotoEditingSliderPhase,
} from "./photo-editing-adjustment-controls";
import {
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";
import { PhotoEditingRuler } from "./photo-editing-ruler";
import { PhotoEditingCropTools } from "./photo-editing-crop-tools";
import type { BrowserPhotoExportResult } from "./use-browser-photo-export-delete";
import { usePhotoEditingZoom } from "./use-photo-editing-zoom";

/**
 * スマホ（1024px 未満）の 1 枚の編集の層（NIHO Photo 段 1 F6c 移行元設計・モック `idea/mock/photo-editing-mobile-v1.html`）。
 * host のヘッダーとサブタブを隠す全画面の層で、上から 上の帯（‹・取り消す・やり直す／♥・補正前・書き出す）→ 写真（残り全部）
 * → 状態の 1 行 → 道具別の操作段 → 道具の帯（プリセット／自動／ライト／カラー／効果／カラーミキサー／カラーグレーディング／
 * ポイントカラー／マスク／切り抜き）。
 *
 * - 層の地は白 1 色（帯・写真・段・書き出すのシートを塗り分けない。owner 決定 2026-10-01）。PC の 1 枚の面と同じ地で、
 *   肌色は白の見え方を寄せるので敷かない。地を持つのは層だけで、帯と写真の面は塗らない。
 * - 段 A と段 B を分ける（帯を送る指と、値を変える指を取り合わせない）。チップは既定値でない項目に値を添える。
 * - 道具の帯には今ある道具（プリセット・自動・補正の群・切り抜き）だけを出す。プリセット（`presets` を渡したときだけ）は先頭で、
 *   層を開いたときの道具。プリセットの間は段 A・段 B の代わりに、72px の見本（320pxでは64px）と、選択中だけ適用量の目盛りを出す。
 * - 補正の値・保存・取り消しの履歴は面の hook のものをそのまま使う。ここが持つのは「今の道具」「今の項目」「書き出すのシートの
 *   開閉」「写真の拡大」だけ。
 * - 写真の面の指の操作（長押しで補正前・ピンチ / ダブルタップで拡大・拡大中のドラッグで送る）は `usePhotoEditingZoom`。
 *   拡大はジェスチャだけで、ボタンは置かない。「補正前」の札・直せない理由・「もう一度読み込む」は拡大しない。
 * - 写真の面の右上の切り替えで、補正前（上）と補正後（下）を上下に並べる（niho-photo#41。拡大と送りは両方の画に同じだけ当たる）。
 * - 端末の「戻る」は一覧へ（`usePhotoEditingLayerHistory`）。書き出すのシートが開いていれば、まずシートを閉じる。
 * - 層は host の shell（`[data-niho-host-shell]`。無ければ `document.body`）に出す（host のヘッダー・サブタブより上。shell の中に
 *   出すのは、host のテーマの色の変数を層にも効かせるため。面の section の外なので、面の `inert` はかからない）。z-index は Dialog と同じ帯（150）で、
 *   後から開く確認のダイアログ（`appDialog`）と通知（200 番台）はこの上に出る。safe area の余白は層が持つ。
 */

/** プリセットの道具（補正の群の id と重ならない） */
/** 帯の末尾（切り抜きの後ろ）に置く補正の群。応用の道具で、使う人が少ない */
const TRAILING_GROUP_IDS: ReadonlySet<PhotoEditingAdjustmentGroupId> = new Set(["detail"]);
const PRESETS_TOOL_ID = "presets";
const AUTO_TOOL_ID = "auto";
const CROP_TOOL_ID = "crop";
const COLOR_MIXER_TOOL_ID = "color-mixer";
/** カラーミキサー（HSL。niho-photo#38）の道具（`COLOR_MIXER_TOOL_ID` は Oklch の「ポイントカラー」） */
const HSL_MIXER_TOOL_ID = "hsl-mixer";
/** カラーグレーディング（niho-photo#39）の道具 */
const COLOR_GRADING_TOOL_ID = "color-grading";
/** マスク（部分補正。niho-photo#93）の道具 */
const MASK_TOOL_ID = "mask";
/** 道具の帯の道具（プリセット・自動・補正の群・カラーミキサー・カラーグレーディング・ポイントカラー・マスク・切り抜き） */
type MobileToolId =
  | typeof PRESETS_TOOL_ID
  | typeof AUTO_TOOL_ID
  | typeof CROP_TOOL_ID
  | typeof COLOR_MIXER_TOOL_ID
  | typeof HSL_MIXER_TOOL_ID
  | typeof COLOR_GRADING_TOOL_ID
  | typeof MASK_TOOL_ID
  | PhotoEditingAdjustmentGroupId;

const TOOL_ICONS: Record<MobileToolId, LucideIcon> = {
  presets: Grid2x2,
  auto: Sparkles,
  light: Sun,
  color: Droplet,
  effects: Aperture,
  // ディテール（Issue #32。Lightroom のディテールの道具と同じ三角）。帯の幅が足りないので、今のスマホの面には出さない
  detail: Triangle,
  crop: Crop,
  "hsl-mixer": Palette,
  "color-grading": Blend,
  "color-mixer": Pipette,
  mask: CircleDashed,
};

const BAND_CLASS_NAME = "shrink-0 border-t border-niho-border";
const ICON_BUTTON_CLASS_NAME =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40";
/** 見た目の高さ（32px）は変えず、押せる範囲だけ上下に広げて 44px にする */
const TALL_HIT_AREA_CLASS_NAME = "relative after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";
const CHIP_CLASS_NAME = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed",
  TALL_HIT_AREA_CLASS_NAME,
);
const STATUS_ROW_CLASS_NAME = cn(BAND_CLASS_NAME, "flex min-h-[30px] items-center justify-center gap-1 px-3");
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function BrowserPhotoEditingMobileEditor(props: {
  /** 開いている写真（替わったら、書き出すのシートを閉じる） */
  photoKey: string;
  /** 写真の面の中身（面が `BrowserPhotoEditingLoupe` を渡す） */
  photo: ReactNode;
  /** ポータルの層を親のショートカット範囲にも登録する */
  onLayerRef?: (element: HTMLDivElement | null) => void;
  /** 状態の 1 行（面が `BrowserPhotoEditingStatusLine` を渡す。出すものが無ければ行ごと出さない） */
  statusLine: ReactNode;
  /** 目盛りとチップに見せる値（編集中の `developSettings`） */
  settings: PhotoEditingSettings;
  /** 見せる項目（省略時は全部。S1 の canvas は 5 項目） */
  visibleKeys?: ReadonlyArray<PhotoEditingControlKey>;
  /**
   * プリセット（段 2 の wasm で開く写真だけ。渡したときだけ道具の帯の先頭に出し、層を開いたときの道具にする。当てる・外すは面の
   * `useBrowserPhotoPresets`）
   */
  presets?: BrowserPhotoEditingMobilePresetsProps;
  /** 対応する wasm の Oklch 色ミキサー（道具の名前は「ポイントカラー」）。 */
  colorMixer?: ReactNode;
  /**
   * カラーミキサー（HSL。niho-photo#38。段 2 の wasm で開いた写真だけ）。渡したときだけ道具の帯の「ポイントカラー」の前に出し、
   * 道具の段に「調整」の切り替えと 8 色のスライダーを縦に並べる（段の高さに収まらない分は段の中で送る）
   */
  hslMixer?: ReactNode;
  /**
   * カラーグレーディング（niho-photo#39。カラーミキサーと同じ写真だけ）。渡したときだけ道具の帯の「カラーミキサー」の後ろに出し、
   * 道具の段に帯の 4 択・色相環・スライダーを縦に並べる（段の高さに収まらない分は段の中で送る）
   */
  colorGrading?: ReactNode;
  colorPicking?: boolean;
  /** 段 2 の既存の自動補正（口のある wasm だけ）。 */
  auto?: { pressed: boolean; disabled: boolean; onToggle: () => void; onWarm?: () => void };
  /** 既存の切り抜き hook。available な写真だけ道具を出す。 */
  crop?: {
    active: boolean;
    disabled: boolean;
    geometry: DevelopGeometry;
    source: DevelopSize | null;
    liveAngle: number | null;
    exportLongEdge: number | null;
    enter: () => void;
    leave: () => void;
    commit: (geometry: DevelopGeometry) => void;
    reset: () => void;
    setLiveAngle: (angle: number | null) => void;
  };
  /**
   * マスク（部分補正。niho-photo#93。マスクを描ける wasm の写真だけ）。渡したときだけ道具の帯の「切り抜き」の前に出し、道具の段に
   * `band`（足す・一覧・選んだマスクの補正）を出す（段の高さを超える分は段の中で送る）。入る・出るはマスクの hook の `enter` / `leave`
   * で、hook がひとりでに出た（写真を替えた・使えなくなった）ら、ここも今の道具を既定に戻す。マスクの間も写真の拡大（ピンチ）は使え、
   * 長押しの補正前は使わない（指は形を動かす・塗るのに使う）
   */
  mask?: { active: boolean; edited: boolean; disabled: boolean; enter: () => void; leave: () => void; band: ReactNode };
  canEdit: boolean;
  /** 「補正前」を出す（補正の入力を開けていて、直せる） */
  canCompare: boolean;
  /**
   * 補正前と補正後を上下に並べる切り替え（niho-photo#41）。写真の面の右上に置く（上の帯は ♥ が縮んで受ける幅しか無いので足さない）。
   * 並べている間は「補正前」（ボタン・長押し）を使わない。渡さない間（切り抜きの道具の間など）は出さない
   */
  compareView?: { active: boolean; onToggle: () => void } | null;
  /** 目盛り・チップ・取り消し・「初期化」・「補正前」を押せない（PC の右パネルと同じ条件） */
  controlsDisabled: boolean;
  /** 何か当てている（「初期化」を出す） */
  canReset: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** お気に入りの ♥（開いている写真。上の帯の「補正前」の左。F5b 移行元設計） */
  favorite?: BrowserPhotoFavoriteControl;
  /** 作業コピーを待っている間の状態 */
  work: WorkWait | null;
  /** RAW の写真か（待ち文言の語彙を切り替える） */
  raw: boolean;
  /** 書き出し・消している途中 */
  busy: boolean;
  compareOriginal: boolean;
  canExport: boolean;
  /** 書き出すの形式（選んでいる写真が無ければ null） */
  exportChoices: BrowserPhotoExportChoices | null;
  /** 書き出している途中（シートの主ボタンを「書き出し中…」にする） */
  exporting: boolean;
  /** 描き終えて、同じボタンをもう一度押すのを待っている */
  exportReady: boolean;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onRetryWork: () => void;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
  onCompareOriginalChange: (compare: boolean) => void;
  onExport: (
    format: BrowserPhotoExportFormat,
    saveRoute: PhotoSaveRoute,
    size: BrowserPhotoExportSize,
  ) => Promise<BrowserPhotoExportResult>;
  /** 描き終えた写真を共有シートへ渡す（押した操作の中で呼ぶ） */
  onSharePending: () => Promise<BrowserPhotoExportResult>;
  /** シートを閉じた（待っていた写真を捨てる） */
  onExportSheetClosed: () => void;
  /** 書き出すのシートを開いた（閉じたら {@link onExportSheetClosed}。「大きく」の長辺を読む間。niho-photo#134） */
  onExportSheetOpened?: () => void;
}) {
  const idPrefix = useId();
  // 層を出す先（host の shell）。最初の描画から出す: 1 枚の canvas が面の描画の effect と同じ commit で付いていないと、
  // 付け替えた canvas に今の画が描かれない（`canvasSurface`）。層は写真を開いた後にだけ出るので、shell はもう DOM にある
  const [container] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.querySelector<HTMLElement>("[data-niho-host-shell]") ?? document.body),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const toolStripRef = useRef<HTMLElement | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  // 今の道具（null はまだ選んでいない: プリセットがあればプリセット、無ければ先頭の補正の群）。マスクは hook が入っている間だけ
  // マスク（hook がひとりでに出たら既定の道具。層を開いたときに入っていれば〔PC の幅から狭めた〕マスクから始める）
  const [selectedToolId, setToolId] = useState<MobileToolId | null>(() => (props.mask?.active ? MASK_TOOL_ID : null));
  const mask = props.mask ?? null;
  const toolId = selectedToolId === MASK_TOOL_ID && mask?.active !== true ? null : selectedToolId;
  useEffect(() => {
    if (selectedToolId === MASK_TOOL_ID && mask?.active !== true) setToolId(null);
  }, [mask?.active, selectedToolId]);
  // 補正の群ごとの、最後に選んでいた項目（道具を切り替えて戻ったときに続きから）
  const [itemByTool, setItemByTool] = useState<Partial<Record<PhotoEditingAdjustmentGroupId, PhotoEditingControlKey>>>({});
  const [exportOpen, setExportOpen] = useState(false);

  // 今ある道具（項目が 1 つも無い群は出ない）。選んでいる道具・項目が無くなったら先頭へ寄せる。プリセットの間は補正の群を選ばない
  const presets = props.presets ?? null;
  const auto = props.auto ?? null;
  const crop = props.crop ?? null;
  const colorMixer = props.colorMixer ?? null;
  const hslMixer = props.hslMixer ?? null;
  const colorGrading = props.colorGrading ?? null;
  const groups = useMemo(() => visiblePhotoEditingAdjustmentGroups(props.visibleKeys), [props.visibleKeys]);
  const presetsCurrent = presets !== null && (toolId === null || toolId === PRESETS_TOOL_ID);
  const autoCurrent = !presetsCurrent && auto !== null && toolId === AUTO_TOOL_ID;
  const cropCurrent = !presetsCurrent && crop !== null && toolId === CROP_TOOL_ID;
  const colorMixerCurrent = !presetsCurrent && colorMixer !== null && toolId === COLOR_MIXER_TOOL_ID;
  const hslMixerCurrent = !presetsCurrent && hslMixer !== null && toolId === HSL_MIXER_TOOL_ID;
  const colorGradingCurrent = !presetsCurrent && colorGrading !== null && toolId === COLOR_GRADING_TOOL_ID;
  const maskCurrent = !presetsCurrent && mask !== null && toolId === MASK_TOOL_ID;
  // カラーミキサー・カラーグレーディングに調整が入っている（道具の帯のその道具に点を添える。プリセット・自動の点と同じ）
  const hslEdited = hslMixer !== null && hasPhotoEditingHslEdits(props.settings);
  const colorGradingEdited = colorGrading !== null && hasPhotoEditingColorGradingEdits(props.settings);
  // 「自動」の道具に入った時点で結果の計算を始める（ボタンを押すまでの間に終える。押して 300ms 以内に画を変える）
  const onAutoWarmRef = useRef(auto?.onWarm);
  onAutoWarmRef.current = auto?.onWarm;
  const autoWarmable = autoCurrent && auto !== null && !auto.disabled;
  useEffect(() => {
    if (autoWarmable) onAutoWarmRef.current?.();
  }, [autoWarmable, auto?.pressed]);
  const group =
    presetsCurrent || autoCurrent || cropCurrent || colorMixerCurrent || hslMixerCurrent || colorGradingCurrent || maskCurrent
      ? null
      : (groups.find((candidate) => candidate.id === toolId) ?? groups[0] ?? null);
  // 道具の帯（プリセットは先頭。カラーミキサー → カラーグレーディング → ポイントカラーは補正の群の後ろ。Lightroom と同じくカラーの続き）。
  // ディテール（シャープ・ノイズ軽減。niho-photo#86）は応用の道具なので、切り抜きの後ろの末尾に置く（帯は横に送れる）
  const toolOf = (candidate: PhotoEditingAdjustmentGroup) => ({ id: candidate.id, title: candidate.title });
  const tools: { id: MobileToolId; title: string }[] = groups
    .filter((candidate) => !TRAILING_GROUP_IDS.has(candidate.id))
    .map(toolOf);
  if (presets) tools.unshift({ id: PRESETS_TOOL_ID, title: PHOTO_EDITING_MOBILE_PRESETS_LABEL });
  if (auto) tools.splice(presets ? 1 : 0, 0, { id: AUTO_TOOL_ID, title: "自動" });
  if (hslMixer) tools.push({ id: HSL_MIXER_TOOL_ID, title: PHOTO_EDITING_HSL_TITLE });
  if (colorGrading) tools.push({ id: COLOR_GRADING_TOOL_ID, title: PHOTO_EDITING_COLOR_GRADING_TITLE });
  if (colorMixer) tools.push({ id: COLOR_MIXER_TOOL_ID, title: PHOTO_EDITING_POINT_COLOR_TITLE });
  // マスク（部分補正）は全体の補正の後ろ・切り抜きの前
  if (mask) tools.push({ id: MASK_TOOL_ID, title: PHOTO_EDITING_TOOL_MASK_LABEL });
  if (crop) tools.push({ id: CROP_TOOL_ID, title: "切り抜き" });
  tools.push(...groups.filter((candidate) => TRAILING_GROUP_IDS.has(candidate.id)).map(toolOf));
  const currentToolId: MobileToolId | null = presetsCurrent
    ? PRESETS_TOOL_ID
    : autoCurrent
      ? AUTO_TOOL_ID
      : cropCurrent
        ? CROP_TOOL_ID
        : colorMixerCurrent
          ? COLOR_MIXER_TOOL_ID
          : hslMixerCurrent
            ? HSL_MIXER_TOOL_ID
            : colorGradingCurrent
              ? COLOR_GRADING_TOOL_ID
              : maskCurrent
                ? MASK_TOOL_ID
                : (group?.id ?? null);
  const control = group
    ? (group.controls.find((candidate) => candidate.key === itemByTool[group.id]) ?? group.controls[0] ?? null)
    : null;
  const groupId = group?.id ?? null;
  const controlKey = control?.key ?? null;

  const { sliderFor, resetWhiteBalance } = resolvePhotoEditingControlSliders({
    settings: props.settings,
    // 白は PC の右パネルと同じ材料で絶対 / 相対を決める
    photo: BROWSER_WHITE_BALANCE_SOURCE,
    disabled: props.controlsDisabled,
    idPrefix,
    onSettingsChange: props.onSettingsChange,
  });
  const slider = control ? sliderFor(control) : null;

  const selectTool = (next: MobileToolId) => {
    if (next === CROP_TOOL_ID) crop?.enter();
    else crop?.leave();
    if (next === MASK_TOOL_ID) mask?.enter();
    else if (mask?.active) mask.leave();
    setToolId(next);
  };

  // 層を開いている間は、後ろのページを送らせない
  useEffect(() => {
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  // 開いたらフォーカスを層へ移し（Tab が後ろのページではなく層の中から始まる）、閉じたら元の場所（一覧のタイル）へ戻す
  useEffect(() => {
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [container]);

  // 選んだチップを帯の見える位置（中央）へ送る
  useEffect(() => {
    const strip = stripRef.current;
    const chip = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !chip) return;
    strip.scrollLeft = Math.max(0, chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2);
  }, [groupId, controlKey]);

  // 道具の帯が収まらない幅では、選んだ道具を帯の見える位置（中央）へ送る（収まる幅では動かさない）
  useEffect(() => {
    const strip = toolStripRef.current;
    const tool = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !tool || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft = Math.max(0, tool.offsetLeft - (strip.clientWidth - tool.offsetWidth) / 2);
  }, [currentToolId]);

  // 写真が替わったらシートを閉じる
  const photoKey = props.photoKey;
  const [sheetPhotoKey, setSheetPhotoKey] = useState(photoKey);
  if (sheetPhotoKey !== photoKey) {
    setSheetPhotoKey(photoKey);
    setExportOpen(false);
    if (toolId === CROP_TOOL_ID || toolId === MASK_TOOL_ID) setToolId(presets ? PRESETS_TOOL_ID : (groups[0]?.id ?? null));
  }
  // 書き出せなくなったら（写真を読み込み直している途中など）開かない。書き出している間は、結果を出すまで開いたままにする
  const exportChoices = props.exportChoices;
  const sheetOpen = exportOpen && exportChoices !== null && (props.canExport || props.exporting || props.exportReady);
  // 閉じたシートが、書き出せるようになったときにひとりでに開き直さない
  if (exportOpen && !sheetOpen) setExportOpen(false);

  // シートを閉じた・層を閉じたら、共有シートを待っていた写真を捨てる
  const onExportSheetClosedRef = useRef(props.onExportSheetClosed);
  const onExportSheetOpenedRef = useRef(props.onExportSheetOpened);
  useEffect(() => {
    onExportSheetClosedRef.current = props.onExportSheetClosed;
    onExportSheetOpenedRef.current = props.onExportSheetOpened;
  });
  useEffect(() => {
    if (!sheetOpen) return;
    onExportSheetOpenedRef.current?.();
    return () => onExportSheetClosedRef.current();
  }, [sheetOpen]);

  const closeExportSheet = () => {
    setExportOpen(false);
    exportButtonRef.current?.focus({ preventScroll: true });
  };

  // 端末の「戻る」: シートが開いていればシートだけ閉じ（層は残る）、無ければ一覧へ
  usePhotoEditingLayerHistory(() => {
    if (sheetOpen) closeExportSheet();
    else props.onBack();
  });

  // 「補正前」: 押している間だけ（ボタンが正。写真の面の長押しは近道）。上下に並べている間（niho-photo#41）は使わない
  const setCompareOriginal = props.onCompareOriginalChange;
  const compareView = props.compareView ?? null;
  const comparing = compareView?.active === true;
  const compareEnabled = props.canCompare && !props.controlsDisabled;
  // 写真の面の指の操作（長押しで補正前・ピンチ / ダブルタップで拡大・拡大中のドラッグで送る）
  const zoom = usePhotoEditingZoom({
    photoKey,
    enabled: !cropCurrent && props.colorPicking !== true,
    // マスクの間は、指を形のつまみ・塗るのに使う（長押しの補正前にしない。ピンチの拡大は使える）
    holdEnabled: compareEnabled && !comparing && !maskCurrent,
    onHoldChange: setCompareOriginal,
  });

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    // Esc は一覧へ戻る（シートの Esc はシートが使う）
    if (event.key === "Escape") {
      event.preventDefault();
      if (cropCurrent || crop?.active) {
        crop?.leave();
        setToolId(presets ? PRESETS_TOOL_ID : (groups[0]?.id ?? null));
      } else if (maskCurrent && mask) {
        mask.leave();
        setToolId(presets ? PRESETS_TOOL_ID : (groups[0]?.id ?? null));
      } else props.onBack();
      return;
    }
    if ((event.key === "r" || event.key === "R") && crop) {
      event.preventDefault();
      selectTool(cropCurrent ? (presets ? PRESETS_TOOL_ID : (groups[0]?.id ?? CROP_TOOL_ID)) : CROP_TOOL_ID);
      return;
    }
    if (event.key !== "Tab") return;
    const root = rootRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      root.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const work = props.work;
  const workText = work ? workWaitText(work, props.raw) : null;

  if (!container) return null;

  const layer = (
    <div
      ref={(element) => {
        rootRef.current = element;
        props.onLayerRef?.(element);
      }}
      role="region"
      aria-label={PHOTO_EDITING_MOBILE_EDITOR_LABEL}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      // 目盛りの両端が薄れる先は、層の地の色
      style={{ "--photo-editing-panel": "white" } as CSSProperties}
      className="fixed inset-0 z-[150] flex flex-col overscroll-contain bg-white pb-[var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))] pt-[var(--niho-safe-area-top,env(safe-area-inset-top,0px))] text-niho-text outline-none"
    >
      {/* 上の帯 */}
      <div className="flex h-11 shrink-0 items-center pl-0.5 pr-2">
        <button type="button" aria-label={PHOTO_EDITING_MOBILE_BACK_LABEL} onClick={props.onBack} className={ICON_BUTTON_CLASS_NAME}>
          <ChevronLeft className="h-6 w-6" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={PHOTO_EDITING_UNDO_LABEL}
          disabled={props.controlsDisabled || !props.canUndo}
          onClick={props.onUndo}
          className={ICON_BUTTON_CLASS_NAME}
        >
          <Undo2 className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={PHOTO_EDITING_REDO_LABEL}
          disabled={props.controlsDisabled || !props.canRedo}
          onClick={props.onRedo}
          className={ICON_BUTTON_CLASS_NAME}
        >
          <Redo2 className="h-5 w-5" aria-hidden />
        </button>
        <span className="min-w-0 flex-1" />
        {props.favorite ? (
          // 1 行に収める: 足りない幅は ♥ だけが縮んで受ける（ほかのボタンは動かさない）。root 17px で、幅 375px 以上は w-11 の丸の
          // まま、360px は約 45px、320px は約 27px（高さは h-11 のまま。ハートは 22px のまま）
          <BrowserPhotoFavoriteButton {...props.favorite} className="min-w-0 shrink" />
        ) : null}
        {props.canCompare ? (
          <button
            type="button"
            // 幅 360px 未満はアイコンだけ（読み上げは同じ「補正前」）
            aria-label={PHOTO_EDITING_COMPARE_ORIGINAL_LABEL}
            aria-pressed={props.compareOriginal}
            disabled={props.controlsDisabled || comparing}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              setCompareOriginal(true);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
              setCompareOriginal(false);
            }}
            onPointerCancel={() => setCompareOriginal(false)}
            onLostPointerCapture={() => setCompareOriginal(false)}
            onPointerLeave={() => setCompareOriginal(false)}
            onBlur={() => setCompareOriginal(false)}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") setCompareOriginal(true);
            }}
            onKeyUp={() => setCompareOriginal(false)}
            onContextMenu={(event) => event.preventDefault()}
            className={cn(
              PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
              TALL_HIT_AREA_CLASS_NAME,
              "mr-1.5 min-w-11 touch-none select-none [-webkit-touch-callout:none] max-[359px]:border-transparent max-[359px]:bg-transparent max-[359px]:px-0 max-[359px]:text-niho-text-sub",
              "aria-pressed:border-niho-text aria-pressed:bg-niho-text aria-pressed:text-niho-surface",
            )}
          >
            <SquareSplitHorizontal className="h-5 w-5 min-[360px]:hidden" aria-hidden />
            <span className="hidden min-[360px]:inline">{PHOTO_EDITING_COMPARE_ORIGINAL_LABEL}</span>
          </button>
        ) : null}
        <button
          ref={exportButtonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          disabled={!props.canExport}
          onClick={() => setExportOpen(true)}
          className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, TALL_HIT_AREA_CLASS_NAME)}
        >
          {PHOTO_EDITING_EXPORT_LABEL}
        </button>
      </div>

      {/* 写真の面（残り全部）。拡大した画はここで切り抜く（`--photo-editing-zoom` は hook が直接書くので、
          この要素に style は渡さない） */}
      <div
        ref={zoom.surfaceRef}
        data-testid="photo-editing-mobile-photo"
        // 写真の上の印（マスクのつまみ・ブラシ）が、拡大の変化を見て測り直す印（`PHOTO_EDITING_ZOOM_SURFACE_ATTRIBUTE`）
        data-photo-zoom-surface=""
        data-zoomed={zoom.zoomed ? "true" : undefined}
        onPointerDown={zoom.onPointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerCancel}
        onPointerLeave={zoom.onPointerCancel}
        onContextMenu={(event) => {
          if (compareEnabled) event.preventDefault();
        }}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden [-webkit-touch-callout:none]"
      >
        <div className="absolute inset-2.5">{props.photo}</div>
        {compareView ? (
          // 補正前と補正後を上下に並べる（niho-photo#41）。拡大しない・写真の面の指の操作には渡さない（ボタンの上は扱わない）
          <button
            type="button"
            aria-label={PHOTO_EDITING_COMPARE_STACKED_LABEL}
            aria-pressed={comparing}
            disabled={props.controlsDisabled}
            onClick={compareView.onToggle}
            className={cn(
              ICON_BUTTON_CLASS_NAME,
              "absolute right-3.5 top-3.5 z-10 bg-white/95 shadow-sm",
              "aria-pressed:bg-niho-text aria-pressed:text-niho-surface",
            )}
          >
            <Rows2 className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* 状態の 1 行（道具の帯のすぐ上・段の上）。出すものが無ければ行を出さない */}
      <div className={cn(STATUS_ROW_CLASS_NAME, "empty:hidden")}>{props.statusLine}</div>
      {work && workText ? (
        <div className={STATUS_ROW_CLASS_NAME}>
          <p role="status" className="min-w-0 truncate text-xs font-bold text-niho-text-sub">
            {workText}
          </p>
          {work.phase === "failed" ? (
            <button
              type="button"
              disabled={!props.canEdit || work.retrying || props.busy}
              onClick={props.onRetryWork}
              className={PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME}
            >
              {PHOTO_EDITING_RETRY_LABEL}
            </button>
          ) : null}
        </div>
      ) : null}
      {!props.canEdit ? (
        <div className={STATUS_ROW_CLASS_NAME}>
          <p className="min-w-0 truncate text-xs text-niho-text-muted">{BROWSER_PHOTO_EDITING_READ_ONLY_TEXT}</p>
        </div>
      ) : null}

      {presetsCurrent && presets ? (
        // プリセットの段（見本の分だけ補正の段より高く、写真が少し縮む）
        <BrowserPhotoEditingMobilePresets
          {...presets}
          disabled={props.controlsDisabled}
          bandClassName={BAND_CLASS_NAME}
          statusRowClassName={STATUS_ROW_CLASS_NAME}
        />
      ) : autoCurrent && auto ? (
        <div className={cn(BAND_CLASS_NAME, "flex h-[7.5rem] items-center justify-center")}>
          <button
            type="button"
            aria-pressed={auto.pressed}
            disabled={auto.disabled}
            onClick={auto.onToggle}
            onPointerDown={auto.onWarm}
            onFocus={auto.onWarm}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-full border border-niho-border px-5 text-body font-bold text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40",
              auto.pressed && "border-niho-accent-ink/25 bg-niho-accent-soft text-niho-accent-ink",
            )}
          >
            <Sparkles className="h-[18px] w-[18px]" aria-hidden />
            自動補正
          </button>
        </div>
      ) : cropCurrent && crop ? (
        crop.source ? (
          <PhotoEditingCropTools
            mobile
            bandClassName={BAND_CLASS_NAME}
            geometry={crop.geometry}
            source={crop.source}
            disabled={crop.disabled}
            liveAngle={crop.liveAngle}
            exportLongEdge={crop.exportLongEdge}
            onLiveAngleChange={crop.setLiveAngle}
            onCommit={crop.commit}
            onReset={props.canReset ? crop.reset : undefined}
          />
        ) : (
          <div className={cn(BAND_CLASS_NAME, "h-[7.5rem]")} aria-busy="true" />
        )
      ) : colorMixerCurrent && colorMixer ? (
        <div className={cn(BAND_CLASS_NAME, "max-h-[17rem] overflow-y-auto")}>{colorMixer}</div>
      ) : hslMixerCurrent && hslMixer ? (
        // 「調整」の切り替えと 8 本のスライダーを縦に（段の高さを超える分は段の中で送る。帯と写真は動かさない）
        <div
          data-testid="photo-editing-mobile-hsl"
          className={cn(BAND_CLASS_NAME, "max-h-[17rem] overflow-y-auto overscroll-y-contain px-3 pb-2 pt-1")}
        >
          {hslMixer}
        </div>
      ) : maskCurrent && mask ? (
        // マスク（部分補正。niho-photo#93）: 足す・一覧・選んだマスクの補正を縦に（段の高さを超える分は段の中で送る）
        <div
          data-testid="photo-editing-mobile-mask"
          className={cn(BAND_CLASS_NAME, "max-h-[17rem] overflow-y-auto overscroll-y-contain")}
        >
          {mask.band}
        </div>
      ) : colorGradingCurrent && colorGrading ? (
        // 帯の 4 択・色相環・スライダーを縦に（段の高さを超える分は段の中で送る。帯と写真は動かさない）
        <div
          data-testid="photo-editing-mobile-color-grading"
          className={cn(BAND_CLASS_NAME, "max-h-[17rem] overflow-y-auto overscroll-y-contain px-3 pb-2 pt-1")}
        >
          {colorGrading}
        </div>
      ) : group && slider ? (
        <div className={BAND_CLASS_NAME}>
          {/* 段 A: 今の道具の項目のチップ（横に送れる帯） */}
          <div
            ref={stripRef}
            role="toolbar"
            aria-label={photoEditingMobileItemsLabel(group.title)}
            className={cn(
              "relative flex h-11 items-center gap-1 overflow-x-auto overscroll-x-contain px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              props.controlsDisabled && "opacity-40",
            )}
          >
            {group.controls.map((candidate) => {
              const item = sliderFor(candidate);
              const selected = candidate.key === control?.key;
              return (
                <button
                  key={candidate.key}
                  type="button"
                  aria-pressed={selected}
                  disabled={props.controlsDisabled}
                  onClick={() => setItemByTool((current) => ({ ...current, [group.id]: candidate.key }))}
                  className={cn(CHIP_CLASS_NAME, selected ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-sub")}
                >
                  {item.label}
                  {item.isDefault ? null : (
                    <span className="font-medium tabular-nums">{item.valueText}</span>
                  )}
                </button>
              );
            })}
            {(group.id === "color" && resetWhiteBalance) || props.canReset ? (
              <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-niho-border" />
            ) : null}
            {group.id === "color" && resetWhiteBalance ? (
              <button type="button" onClick={resetWhiteBalance} className={cn(CHIP_CLASS_NAME, "text-niho-accent-ink")}>
                {PHOTO_EDITING_RESET_WHITE_BALANCE_LABEL}
              </button>
            ) : null}
            {props.canReset ? (
              <button
                type="button"
                disabled={props.controlsDisabled}
                onClick={props.onReset}
                className={cn(CHIP_CLASS_NAME, "text-niho-accent-ink")}
              >
                {PHOTO_EDITING_RESET_LABEL}
              </button>
            ) : null}
          </div>
          {/* 段 B: 選んでいる項目の目盛り 1 本 */}
          <PhotoEditingRuler
            key={slider.key}
            id={slider.id}
            label={slider.label}
            min={slider.min}
            max={slider.max}
            step={slider.step}
            value={slider.value}
            valueText={slider.valueText}
            disabled={slider.disabled}
            onChange={slider.onChange}
            onReset={slider.onReset}
          />
        </div>
      ) : null}

      {/* 道具の帯: 今ある道具だけ（名前の長さに合わせた幅で 1 行）。現在地は墨の文字と下線。収まる幅では均等に並べ、道具が多くて
          収まらない幅（カラーミキサー・ポイントカラーまで出る写真の狭い幅）は横に送る（選んだ道具を見える位置へ寄せる） */}
      {tools.length > 0 ? (
        <nav
          ref={toolStripRef}
          aria-label={PHOTO_EDITING_MOBILE_TOOLS_LABEL}
          className={cn(
            BAND_CLASS_NAME,
            "relative h-14 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          <div className="flex h-full w-max min-w-full items-stretch justify-around px-1">
            {tools.map((candidate) => {
              const Icon = TOOL_ICONS[candidate.id];
              const current = candidate.id === currentToolId;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  aria-current={current ? "true" : undefined}
                  disabled={
                    (candidate.id === AUTO_TOOL_ID && auto?.disabled) ||
                    (candidate.id === CROP_TOOL_ID && crop?.disabled) ||
                    (candidate.id === MASK_TOOL_ID && mask?.disabled && !maskCurrent)
                  }
                  onClick={() => selectTool(candidate.id)}
                  className={cn(
                    "relative flex min-w-11 shrink-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap rounded-xl px-1.5 pb-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40",
                    // 12px の文字なので、現在地でない道具も muted にしない（コントラスト）。現在地は太字と下線で分ける
                    current ? "font-bold text-niho-text" : "font-medium text-niho-text-sub",
                  )}
                >
                  <Icon className="h-[22px] w-[22px]" aria-hidden />
                  {candidate.title}
                  {(candidate.id === AUTO_TOOL_ID && auto?.pressed) ||
                  (candidate.id === PRESETS_TOOL_ID && presets?.appliedPresetKey !== null) ||
                  (candidate.id === HSL_MIXER_TOOL_ID && hslEdited) ||
                  (candidate.id === COLOR_GRADING_TOOL_ID && colorGradingEdited) ||
                  (candidate.id === MASK_TOOL_ID && mask?.edited) ? (
                    <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-niho-text" />
                  ) : null}
                  {current ? (
                    <span aria-hidden className="absolute bottom-1 left-1/2 h-0.5 w-[22px] -translate-x-1/2 rounded-full bg-niho-text" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </nav>
      ) : null}

      {sheetOpen && exportChoices ? (
        <BrowserPhotoMobileExportSheet
          choices={exportChoices}
          exporting={props.exporting}
          ready={props.exportReady}
          onExport={props.onExport}
          onSharePending={props.onSharePending}
          onClose={closeExportSheet}
        />
      ) : null}
    </div>
  );

  return createPortal(layer, container);
}
