"use client";

import { useId, useState } from "react";
import { CircleDot, Copy, Eraser, Eye, EyeOff, FlipVertical2, Loader2, Paintbrush, Plus, Trash2 } from "lucide-react";

import type { DevelopMask, DevelopMaskAdjustKey } from "../develop-engine/develop-masks";
import {
  PHOTO_EDITING_HSL_TITLE,
  PHOTO_EDITING_MASK_ACTION_LABELS,
  PHOTO_EDITING_MASK_ADD_SHORT_LABELS,
  PHOTO_EDITING_MASK_BRUSH_CLEAR_LABEL,
  PHOTO_EDITING_MASK_BRUSH_ERASE_LABEL,
  PHOTO_EDITING_MASK_BRUSH_FILL_LABEL,
  PHOTO_EDITING_MASK_BRUSH_FLOW_LABEL,
  PHOTO_EDITING_MASK_BRUSH_HINT_MOBILE_TEXT,
  PHOTO_EDITING_MASK_BRUSH_LOADING_TEXT,
  PHOTO_EDITING_MASK_BRUSH_PAINT_LABEL,
  PHOTO_EDITING_MASK_BRUSH_RESUME_LABEL,
  PHOTO_EDITING_MASK_BRUSH_SIZE_LABEL,
  PHOTO_EDITING_MASK_BRUSH_TITLE,
  PHOTO_EDITING_MASK_DETECTED_TEXT,
  PHOTO_EDITING_MASK_DETECTING_TEXTS,
  PHOTO_EDITING_MASK_DETECT_CANCEL_LABEL,
  PHOTO_EDITING_MASK_FEATHER_LABEL,
  PHOTO_EDITING_MASK_HINT_MOBILE_TEXT,
  PHOTO_EDITING_MASK_LIST_EMPTY_TEXT,
  PHOTO_EDITING_MASK_MOBILE_ADD_LABEL,
  PHOTO_EDITING_MASK_MOBILE_LIST_LABEL,
  PHOTO_EDITING_MASK_OVERLAY_LABEL,
  PHOTO_EDITING_MASK_OVERLAY_SHORT_LABEL,
  PHOTO_EDITING_MASK_SHAPE_TITLE,
  PHOTO_EDITING_MASK_SURFACE_RETRY_LABEL,
  PHOTO_EDITING_MASK_SURFACE_TEXT,
  PHOTO_EDITING_RESET_LABEL,
  photoEditingMaskAdjustTitle,
  photoEditingMaskDeleteLabel,
  photoEditingMaskDuplicateLabel,
  photoEditingMaskEnabledLabel,
  photoEditingMaskInvertLabel,
  photoEditingMaskLabel,
  photoEditingMaskMobileActionsLabel,
  photoEditingMaskSelectLabel,
  photoEditingMobileItemsLabel,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_FLOW_MIN,
  PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_SIZE_MAX,
  PHOTO_EDITING_MASK_BRUSH_SIZE_MIN,
  PHOTO_EDITING_MASK_BRUSH_SIZE_STEP,
} from "../photo-editing-mask-brush";
import {
  PHOTO_EDITING_MASK_ADJUST_GROUPS,
  PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER,
  readPhotoEditingMaskAdjust,
} from "../photo-editing-masks";
import { cn } from "niho-ui/cn";

import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingMaskHslMixer } from "./photo-editing-mask-hsl";
import {
  PHOTO_EDITING_MASK_ADD_LABELS,
  PHOTO_EDITING_MASK_KIND_ICONS,
  formatPhotoEditingMaskAdjust,
  type PhotoEditingMaskToolsProps,
} from "./photo-editing-mask-tools";
import { PhotoEditingRuler } from "./photo-editing-ruler";
import type { BrowserPhotoMaskBrush } from "./use-browser-photo-mask-brush";

/** 押せる範囲だけを上下に広げて 44px にする（見た目の高さ 32px。スマホの編集の層のチップと同じ） */
const TALL_HIT_AREA_CLASS_NAME = "relative after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";
const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
/** スマホの編集の層の段 A と同じチップ（選んでいる・押している間は淡い地） */
const CHIP_CLASS_NAME = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sub font-bold transition disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
  TALL_HIT_AREA_CLASS_NAME,
);
const CHIP_IDLE_CLASS_NAME = "text-niho-text-sub";
const CHIP_PRESSED_CLASS_NAME = "bg-niho-accent-soft text-niho-accent-ink";
/** 足す・操作のチップ（枠つき） */
const OUTLINE_CHIP_CLASS_NAME = cn(CHIP_CLASS_NAME, "border border-niho-border text-niho-text");
/** 横に送れる 1 行（高さ 44px。帯の送りと値を変える指を取り合わせない） */
const ROW_CLASS_NAME =
  "relative flex h-11 items-center gap-1 overflow-x-auto overscroll-x-contain px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const DIVIDER_CLASS_NAME = "mx-0.5 h-5 w-px shrink-0 bg-niho-border";
const NOTE_CLASS_NAME = "px-3 pb-1 text-xs leading-relaxed text-niho-text-sub";

type MaskTabId = "brush" | "hsl" | "shape" | (typeof PHOTO_EDITING_MASK_ADJUST_GROUPS)[number]["id"];
type MaskTab = { id: MaskTabId; title: string };

/** 目盛り 1 本の値（段 A のチップと段 B の目盛りが同じものを使う）。 */
type RulerItem = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText: string;
  /** 既定値（チップに値を添えない・ダブルタップで戻す値） */
  defaultValue: number;
  onChange: (value: number, phase: PhotoEditingSliderPhase) => void;
};

/** スマホのマスクの道具の段の値（右パネルの面と同じ値と、「初期化」）。 */
export type PhotoEditingMaskMobileToolsProps = PhotoEditingMaskToolsProps & {
  /** 「初期化」を出す（マスクが 1 枚でもある。マスクの道具の間はマスクだけを外す） */
  canReset: boolean;
  onReset: () => void;
};

function formatBrushSize(size: number): string {
  return Number.isInteger(size) ? String(size) : size.toFixed(1);
}

/** 選んだマスクで出す補正の種類（ブラシ → ライト → カラー → カラーミキサー → 効果 → 形）。 */
function maskTabs(props: PhotoEditingMaskMobileToolsProps, mask: DevelopMask, brushReady: boolean): MaskTab[] {
  const tabs: MaskTab[] = [];
  if (brushReady) tabs.push({ id: "brush", title: PHOTO_EDITING_MASK_BRUSH_TITLE });
  for (const group of PHOTO_EDITING_MASK_ADJUST_GROUPS) {
    if (group.adjustments.some((definition) => !(definition.whiteBalance && props.whiteBalanceAbsolute))) {
      tabs.push({ id: group.id, title: group.title });
    }
    // 局所のカラーミキサーは、全体の右パネルと同じくカラーの後ろ
    if (group.id === "color" && props.changeHsl && props.resetHsl) tabs.push({ id: "hsl", title: PHOTO_EDITING_HSL_TITLE });
  }
  if (mask.kind === "radial") tabs.push({ id: "shape", title: PHOTO_EDITING_MASK_SHAPE_TITLE });
  return tabs;
}

/** 段 A（項目のチップ）と段 B（選んだ項目の目盛り 1 本）。スマホの全体の補正の段と同じ形。 */
function RulerBand(props: {
  idPrefix: string;
  label: string;
  items: RulerItem[];
  selectedKey: string | undefined;
  onSelect: (key: string) => void;
  disabled: boolean;
  /** 目盛りを替えたら作り直す（マスクを替えたとき） */
  scope: string;
  testId?: string;
}) {
  const item = props.items.find((candidate) => candidate.key === props.selectedKey) ?? props.items[0];
  if (!item) return null;
  return (
    <div data-testid={props.testId}>
      <div role="toolbar" aria-label={photoEditingMobileItemsLabel(props.label)} className={cn(ROW_CLASS_NAME, props.disabled && "opacity-40")}>
        {props.items.map((candidate) => {
          const selected = candidate.key === item.key;
          return (
            <button
              key={candidate.key}
              type="button"
              aria-pressed={selected}
              disabled={props.disabled}
              onClick={() => props.onSelect(candidate.key)}
              className={cn(CHIP_CLASS_NAME, selected ? CHIP_PRESSED_CLASS_NAME : CHIP_IDLE_CLASS_NAME)}
            >
              {candidate.label}
              {candidate.value === candidate.defaultValue ? null : (
                <span className="font-medium tabular-nums">{candidate.valueText}</span>
              )}
            </button>
          );
        })}
      </div>
      <PhotoEditingRuler
        key={`${props.scope}-${item.key}`}
        id={`${props.idPrefix}-${props.scope}-${item.key}`}
        label={item.label}
        min={item.min}
        max={item.max}
        step={item.step}
        value={item.value}
        valueText={item.valueText}
        disabled={props.disabled}
        onChange={item.onChange}
        onReset={() => item.onChange(item.defaultValue, "commit")}
      />
    </div>
  );
}

/** ブラシの段（描く / 消しゴム・全体を塗る / 消す・大きさ / ぼかし / 流量）。ブラシの設定は補正ではない（取り消しの外）。 */
function BrushBand(props: { idPrefix: string; brush: BrowserPhotoMaskBrush; disabled: boolean; maskId: string }) {
  const { brush, disabled } = props;
  const settings = brush.brush;
  const surfaceReady = brush.status === "ready" && !disabled;
  const [itemKey, setItemKey] = useState<string>("size");
  const items: RulerItem[] = [
    {
      key: "size",
      label: PHOTO_EDITING_MASK_BRUSH_SIZE_LABEL,
      min: PHOTO_EDITING_MASK_BRUSH_SIZE_MIN,
      max: PHOTO_EDITING_MASK_BRUSH_SIZE_MAX,
      step: PHOTO_EDITING_MASK_BRUSH_SIZE_STEP,
      value: settings.size,
      valueText: formatBrushSize(settings.size),
      defaultValue: PHOTO_EDITING_MASK_BRUSH_SIZE_DEFAULT,
      onChange: (value) => brush.setSize(value),
    },
    {
      key: "feather",
      label: PHOTO_EDITING_MASK_FEATHER_LABEL,
      min: 0,
      max: 100,
      step: 1,
      value: settings.feather,
      valueText: String(settings.feather),
      defaultValue: PHOTO_EDITING_MASK_BRUSH_FEATHER_DEFAULT,
      onChange: (value) => brush.setFeather(value),
    },
    {
      key: "flow",
      label: PHOTO_EDITING_MASK_BRUSH_FLOW_LABEL,
      min: PHOTO_EDITING_MASK_BRUSH_FLOW_MIN,
      max: 100,
      step: 1,
      value: settings.flow,
      valueText: String(settings.flow),
      defaultValue: PHOTO_EDITING_MASK_BRUSH_FLOW_DEFAULT,
      onChange: (value) => brush.setFlow(value),
    },
  ];
  return (
    <div data-testid="photo-mask-mobile-brush">
      <div role="toolbar" aria-label={PHOTO_EDITING_MASK_BRUSH_TITLE} className={ROW_CLASS_NAME}>
        <button
          type="button"
          aria-pressed={!settings.erase}
          disabled={disabled}
          onClick={() => brush.setErase(false)}
          className={cn(CHIP_CLASS_NAME, settings.erase ? CHIP_IDLE_CLASS_NAME : CHIP_PRESSED_CLASS_NAME)}
        >
          <Paintbrush className="h-4 w-4" aria-hidden />
          {PHOTO_EDITING_MASK_BRUSH_PAINT_LABEL}
        </button>
        <button
          type="button"
          aria-pressed={settings.erase}
          disabled={disabled}
          onClick={() => brush.setErase(true)}
          className={cn(CHIP_CLASS_NAME, settings.erase ? CHIP_PRESSED_CLASS_NAME : CHIP_IDLE_CLASS_NAME)}
        >
          <Eraser className="h-4 w-4" aria-hidden />
          {PHOTO_EDITING_MASK_BRUSH_ERASE_LABEL}
        </button>
        <span aria-hidden className={DIVIDER_CLASS_NAME} />
        {!brush.paintMode ? (
          <button type="button" disabled={disabled} onClick={brush.resumePaint} className={OUTLINE_CHIP_CLASS_NAME}>
            {PHOTO_EDITING_MASK_BRUSH_RESUME_LABEL}
          </button>
        ) : null}
        <button type="button" disabled={!surfaceReady} onClick={brush.fill} className={OUTLINE_CHIP_CLASS_NAME}>
          {PHOTO_EDITING_MASK_BRUSH_FILL_LABEL}
        </button>
        <button type="button" disabled={!surfaceReady} onClick={brush.clear} className={OUTLINE_CHIP_CLASS_NAME}>
          {PHOTO_EDITING_MASK_BRUSH_CLEAR_LABEL}
        </button>
      </div>
      <RulerBand
        idPrefix={props.idPrefix}
        label={PHOTO_EDITING_MASK_BRUSH_TITLE}
        items={items}
        selectedKey={itemKey}
        onSelect={setItemKey}
        disabled={disabled}
        scope={`brush-${props.maskId}`}
      />
      {brush.status === "loading" ? (
        <p role="status" className={NOTE_CLASS_NAME}>
          {PHOTO_EDITING_MASK_BRUSH_LOADING_TEXT}
        </p>
      ) : null}
      <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_BRUSH_HINT_MOBILE_TEXT}</p>
    </div>
  );
}

/**
 * スマホ（1024px 未満）の全体の編集の層の「マスク」の段（部分補正。niho-photo#93。Lightroom のモバイルのマスクの面にならう）。値と
 * 操作は右パネルのマスクの面（`PhotoEditingMaskTools`）と同じ hook のもの。段の高さを超える分は段の中で縦に送る。
 *
 * - 1 行目: 足す（線形・円形・ブラシ。押せない理由は下に 1 行）・範囲の重ね表示の切り替え・「初期化」（マスクだけを外す）
 * - 2 行目: マスクの一覧（種類の印と名前のチップを横に送る。押すと選ぶ・もう一度で外す）
 * - 選んだマスク: 操作（表示・反転・複製・削除）、指の操作の説明、補正の種類（ブラシ／ライト／カラー／カラーミキサー／効果／円形の
 *   形）を選ぶチップ、その中の項目のチップと目盛り 1 本（全体の補正の段と同じ形。カラーミキサーは全体と同じ 8 本のスライダー）
 * - チップ・ボタンの押せる範囲はどれも 44px
 */
export function PhotoEditingMaskMobileTools(props: PhotoEditingMaskMobileToolsProps) {
  const idPrefix = useId();
  const { masks, selected, disabled } = props;
  const selectedIndex = selected ? masks.findIndex((mask) => mask.id === selected.id) : -1;
  const name = selected ? photoEditingMaskLabel(selected.kind, selectedIndex) : null;
  const reasonId = `${idPrefix}-add-reason`;
  const brush = props.brush ?? null;
  const brushReady = selected !== null && selected.kind === "brush" && brush?.available === true && brush.mask?.id === selected.id;
  // 選んだ補正の種類と項目（マスクを替えたら、そのマスクの最初の種類から）
  const [tabState, setTabState] = useState<{ maskId: string; tab: MaskTabId } | null>(null);
  const [itemByTab, setItemByTab] = useState<Partial<Record<MaskTabId, string>>>({});

  const tabs = selected ? maskTabs(props, selected, brushReady) : [];
  const tab =
    (selected && tabState?.maskId === selected.id ? tabs.find((candidate) => candidate.id === tabState.tab) : undefined) ?? tabs[0];

  const adjustItems = (mask: DevelopMask, groupId: MaskTabId): RulerItem[] => {
    const group = PHOTO_EDITING_MASK_ADJUST_GROUPS.find((candidate) => candidate.id === groupId);
    if (!group) return [];
    return group.adjustments
      .filter((definition) => !(definition.whiteBalance && props.whiteBalanceAbsolute))
      .map((definition) => {
        const key: DevelopMaskAdjustKey = definition.key;
        const value = readPhotoEditingMaskAdjust(mask, key);
        return {
          key,
          label: definition.label,
          min: definition.min,
          max: definition.max,
          step: definition.step,
          value,
          valueText: formatPhotoEditingMaskAdjust(key, value),
          defaultValue: 0,
          onChange: (next: number, phase: PhotoEditingSliderPhase) => props.changeAdjust(mask.id, key, next, phase),
        };
      });
  };

  const renderTab = (mask: DevelopMask, current: MaskTab) => {
    if (current.id === "brush" && brush) {
      return <BrushBand idPrefix={idPrefix} brush={brush} disabled={disabled} maskId={mask.id} />;
    }
    if (current.id === "hsl" && props.changeHsl && props.resetHsl) {
      return (
        <div className="px-3 pb-2 pt-1" data-testid="photo-mask-mobile-hsl">
          <PhotoEditingMaskHslMixer
            mask={mask}
            disabled={disabled}
            grayscale={props.grayscale === true}
            onChange={props.changeHsl}
            onReset={props.resetHsl}
          />
        </div>
      );
    }
    const items: RulerItem[] =
      current.id === "shape"
        ? mask.kind === "radial"
          ? [
              {
                key: "feather",
                label: PHOTO_EDITING_MASK_FEATHER_LABEL,
                min: 0,
                max: 100,
                step: 1,
                value: mask.feather,
                valueText: String(Math.round(mask.feather)),
                defaultValue: PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER,
                onChange: (next, phase) => props.changeFeather(mask.id, next, phase),
              },
            ]
          : []
        : adjustItems(mask, current.id);
    return (
      <RulerBand
        idPrefix={idPrefix}
        label={current.title}
        items={items}
        selectedKey={itemByTab[current.id]}
        onSelect={(key) => setItemByTab((state) => ({ ...state, [current.id]: key }))}
        disabled={disabled}
        scope={mask.id}
        testId="photo-mask-mobile-adjust"
      />
    );
  };

  const hint = !selected
    ? null
    : selected.kind === "linear" || selected.kind === "radial"
      ? PHOTO_EDITING_MASK_HINT_MOBILE_TEXT
      : selected.kind === "subject" || selected.kind === "sky"
        ? PHOTO_EDITING_MASK_DETECTED_TEXT
        : brushReady
          ? null
          : PHOTO_EDITING_MASK_SURFACE_TEXT;

  return (
    <div data-testid="photo-mask-mobile-tools" className="pb-1">
      {/* 1 行目: 足す・範囲の重ね表示・初期化 */}
      <div role="toolbar" aria-label={PHOTO_EDITING_MASK_MOBILE_ADD_LABEL} className={ROW_CLASS_NAME}>
        {props.kinds.map((kind) => (
          // 375px の幅に足す 3 つと「範囲を表示」が収まるよう、種類の印は一覧のチップだけに付ける
          <button
            key={kind}
            type="button"
            aria-label={PHOTO_EDITING_MASK_ADD_LABELS[kind]}
            aria-describedby={props.addBlockedReason ? reasonId : undefined}
            disabled={disabled || !props.canAdd}
            onClick={() => props.add(kind)}
            className={cn(OUTLINE_CHIP_CLASS_NAME, "gap-1 px-2.5")}
          >
            <Plus className="h-3.5 w-3.5 text-niho-text-sub" aria-hidden />
            {PHOTO_EDITING_MASK_ADD_SHORT_LABELS[kind]}
          </button>
        ))}
        <span aria-hidden className={DIVIDER_CLASS_NAME} />
        <button
          type="button"
          role="switch"
          aria-checked={props.overlayVisible}
          aria-label={PHOTO_EDITING_MASK_OVERLAY_LABEL}
          onClick={() => props.setOverlayVisible(!props.overlayVisible)}
          className={cn(CHIP_CLASS_NAME, props.overlayVisible ? CHIP_PRESSED_CLASS_NAME : CHIP_IDLE_CLASS_NAME)}
        >
          <span
            aria-hidden
            className={cn(
              "h-3 w-3 shrink-0 rounded-full border",
              // 赤い重ね表示の色の見本
              props.overlayVisible ? "border-transparent bg-[#ff3030]/70" : "border-niho-text-muted",
            )}
          />
          {PHOTO_EDITING_MASK_OVERLAY_SHORT_LABEL}
        </button>
        {props.canReset ? (
          <button type="button" disabled={disabled} onClick={props.onReset} className={cn(CHIP_CLASS_NAME, "text-niho-accent-ink")}>
            {PHOTO_EDITING_RESET_LABEL}
          </button>
        ) : null}
      </div>
      {props.addBlockedReason ? (
        <p id={reasonId} className={NOTE_CLASS_NAME}>
          {props.addBlockedReason}
        </p>
      ) : null}
      {props.detecting ? (
        <div
          role="status"
          data-testid="photo-mask-detecting"
          className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-niho-pale/60 px-2.5"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-niho-text-sub motion-reduce:animate-none" aria-hidden />
          <p className="min-w-0 flex-1 py-2 text-xs leading-relaxed text-niho-text-sub">
            {PHOTO_EDITING_MASK_DETECTING_TEXTS[props.detecting]}
          </p>
          {props.cancelDetect ? (
            <button
              type="button"
              onClick={props.cancelDetect}
              className={cn("min-h-11 shrink-0 px-1 text-xs font-bold text-niho-accent-ink", FOCUS_RING_CLASS_NAME)}
            >
              {PHOTO_EDITING_MASK_DETECT_CANCEL_LABEL}
            </button>
          ) : null}
        </div>
      ) : null}
      {props.notice ? (
        <div role="status" data-testid="photo-mask-notice" className="mx-3 mb-1 space-y-1 rounded-lg bg-niho-pale/60 px-2.5 py-2">
          <p className="text-xs leading-relaxed text-niho-text-sub">{props.notice}</p>
          {props.canRetrySurfaces && props.retrySurfaces ? (
            <button
              type="button"
              onClick={props.retrySurfaces}
              className={cn("min-h-11 text-xs font-bold text-niho-accent-ink", FOCUS_RING_CLASS_NAME)}
            >
              {PHOTO_EDITING_MASK_SURFACE_RETRY_LABEL}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 2 行目: マスクの一覧 */}
      {masks.length === 0 ? (
        <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_LIST_EMPTY_TEXT}</p>
      ) : (
        <div role="toolbar" aria-label={PHOTO_EDITING_MASK_MOBILE_LIST_LABEL} className={ROW_CLASS_NAME}>
          {masks.map((mask, index) => {
            const maskName = photoEditingMaskLabel(mask.kind, index);
            const Icon = PHOTO_EDITING_MASK_KIND_ICONS[mask.kind] ?? CircleDot;
            const isSelected = selected?.id === mask.id;
            return (
              <button
                key={mask.id}
                type="button"
                data-mask-chip={mask.id}
                aria-pressed={isSelected}
                aria-label={photoEditingMaskSelectLabel(maskName)}
                onClick={() => props.select(isSelected ? null : mask.id)}
                className={cn(
                  CHIP_CLASS_NAME,
                  isSelected ? CHIP_PRESSED_CLASS_NAME : "text-niho-text",
                  !mask.enabled && "opacity-50",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {maskName}
                {mask.enabled ? null : <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}

      {selected && name ? (
        <>
          {/* 選んだマスクの操作 */}
          <div role="toolbar" aria-label={photoEditingMaskMobileActionsLabel(name)} className={ROW_CLASS_NAME}>
            <button
              type="button"
              aria-pressed={selected.enabled}
              aria-label={photoEditingMaskEnabledLabel(name)}
              disabled={disabled}
              onClick={() => props.toggleEnabled(selected.id)}
              className={OUTLINE_CHIP_CLASS_NAME}
            >
              {selected.enabled ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
              {PHOTO_EDITING_MASK_ACTION_LABELS.enabled}
            </button>
            <button
              type="button"
              aria-pressed={selected.invert}
              aria-label={photoEditingMaskInvertLabel(name)}
              disabled={disabled}
              onClick={() => props.toggleInvert(selected.id)}
              className={cn(OUTLINE_CHIP_CLASS_NAME, selected.invert && cn("border-transparent", CHIP_PRESSED_CLASS_NAME))}
            >
              <FlipVertical2 className="h-4 w-4" aria-hidden />
              {PHOTO_EDITING_MASK_ACTION_LABELS.invert}
            </button>
            <button
              type="button"
              aria-label={photoEditingMaskDuplicateLabel(name)}
              disabled={disabled || props.addBlockedReason !== null}
              onClick={() => props.duplicate(selected.id)}
              className={OUTLINE_CHIP_CLASS_NAME}
            >
              <Copy className="h-4 w-4" aria-hidden />
              {PHOTO_EDITING_MASK_ACTION_LABELS.duplicate}
            </button>
            <button
              type="button"
              aria-label={photoEditingMaskDeleteLabel(name)}
              disabled={disabled}
              onClick={() => props.remove(selected.id)}
              className={OUTLINE_CHIP_CLASS_NAME}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {PHOTO_EDITING_MASK_ACTION_LABELS.delete}
            </button>
          </div>
          {hint ? <p className={NOTE_CLASS_NAME}>{hint}</p> : null}
          {/* 補正の種類 */}
          {tabs.length > 0 && tab ? (
            <>
              <div role="toolbar" aria-label={photoEditingMaskAdjustTitle(name)} className={ROW_CLASS_NAME}>
                {tabs.map((candidate) => {
                  const pressed = candidate.id === tab.id;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      aria-pressed={pressed}
                      data-mask-tab={candidate.id}
                      onClick={() => setTabState({ maskId: selected.id, tab: candidate.id })}
                      className={cn(CHIP_CLASS_NAME, "rounded-lg", pressed ? "bg-niho-text text-niho-surface" : CHIP_IDLE_CLASS_NAME)}
                    >
                      {candidate.title}
                    </button>
                  );
                })}
              </div>
              {renderTab(selected, tab)}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
