"use client";

import { Fragment, useId } from "react";
import {
  CircleDot,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  FlipVertical2,
  Loader2,
  Paintbrush,
  Rows3,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";

import type { DevelopMask, DevelopMaskAdjustKey } from "../develop-engine/develop-masks";
import { formatAdjustmentValue, formatSignedInteger } from "../photo-editing-adjustments";
import {
  PHOTO_EDITING_MASK_ADD_BRUSH_LABEL,
  PHOTO_EDITING_MASK_ADD_LINEAR_LABEL,
  PHOTO_EDITING_MASK_ADD_RADIAL_LABEL,
  PHOTO_EDITING_MASK_ADD_SKY_LABEL,
  PHOTO_EDITING_MASK_ADD_SUBJECT_LABEL,
  PHOTO_EDITING_MASK_ADD_TITLE,
  PHOTO_EDITING_MASK_DETECTED_TEXT,
  PHOTO_EDITING_MASK_DETECTING_TEXTS,
  PHOTO_EDITING_MASK_DETECT_CANCEL_LABEL,
  PHOTO_EDITING_MASK_SURFACE_RETRY_LABEL,
  PHOTO_EDITING_MASK_FEATHER_LABEL,
  PHOTO_EDITING_MASK_HINT_TEXT,
  PHOTO_EDITING_MASK_LIST_EMPTY_TEXT,
  PHOTO_EDITING_MASK_LIST_TITLE,
  PHOTO_EDITING_MASK_OVERLAY_KEY_HINT,
  PHOTO_EDITING_MASK_OVERLAY_LABEL,
  PHOTO_EDITING_MASK_SHAPE_TITLE,
  PHOTO_EDITING_MASK_SURFACE_TEXT,
  photoEditingMaskAdjustTitle,
  photoEditingMaskDeleteLabel,
  photoEditingMaskDuplicateLabel,
  photoEditingMaskEnabledLabel,
  photoEditingMaskInvertLabel,
  photoEditingMaskLabel,
  photoEditingMaskSelectLabel,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_MASK_ADJUST_GROUPS,
  PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER,
  readPhotoEditingMaskAdjust,
} from "../photo-editing-masks";
import { cn } from "niho-ui/cn";

import { WHITE_BALANCE_TRACK_CLASS_NAMES, type PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PhotoEditingMaskBrushTools } from "./photo-editing-mask-brush-tools";
import { PhotoEditingMaskHslSection } from "./photo-editing-mask-hsl";
import { PhotoEditingSlider } from "./photo-editing-slider";
import type { BrowserPhotoMaskTool, PhotoEditingMaskAddKind } from "./use-browser-photo-masks";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
const SECTION_TITLE_CLASS_NAME = "text-xs font-bold text-niho-text-muted";
const NOTE_CLASS_NAME = "text-xs leading-relaxed text-niho-text-sub";
/** 足すボタン（右パネルの幅いっぱい・高さ 32px） */
const ADD_BUTTON_CLASS_NAME = cn(
  "inline-flex h-8 w-full items-center gap-2 rounded-lg border border-niho-border px-2.5 text-xs font-bold text-niho-text transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
);
/** 一覧の行の小さな操作（押せる範囲 24px。NIHO photo の密な画面の最小） */
const ROW_ICON_BUTTON_CLASS_NAME = cn(
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-niho-text-sub transition enabled:hover:bg-niho-pale/60 aria-pressed:text-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40",
  FOCUS_RING_CLASS_NAME,
);

/** マスクの種類の印（一覧・足すボタン。スマホの段も使う） */
export const PHOTO_EDITING_MASK_KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  linear: Rows3,
  radial: CircleDot,
  brush: Paintbrush,
  subject: User,
  sky: Cloud,
};
/** 足すボタンの名前（スマホの段は読み上げ名に使う） */
export const PHOTO_EDITING_MASK_ADD_LABELS: Readonly<Record<PhotoEditingMaskAddKind, string>> = {
  linear: PHOTO_EDITING_MASK_ADD_LINEAR_LABEL,
  radial: PHOTO_EDITING_MASK_ADD_RADIAL_LABEL,
  brush: PHOTO_EDITING_MASK_ADD_BRUSH_LABEL,
  subject: PHOTO_EDITING_MASK_ADD_SUBJECT_LABEL,
  sky: PHOTO_EDITING_MASK_ADD_SKY_LABEL,
};

/** 右パネルのマスクの面の値（{@link BrowserPhotoMaskTool} から必要な分だけ。テストで直接渡せる形）。 */
export type PhotoEditingMaskToolsProps = Pick<
  BrowserPhotoMaskTool,
  | "masks"
  | "selected"
  | "select"
  | "kinds"
  | "canAdd"
  | "addBlockedReason"
  | "whiteBalanceAbsolute"
  | "overlayVisible"
  | "setOverlayVisible"
  | "add"
  | "duplicate"
  | "remove"
  | "toggleEnabled"
  | "toggleInvert"
  | "changeAdjust"
  | "changeFeather"
> &
  Partial<
    Pick<
      BrowserPhotoMaskTool,
      // 局所のカラーミキサー（niho-photo#93。渡したときだけ節を出す）
      | "brush"
      | "addingBrush"
      | "notice"
      | "canRetrySurfaces"
      | "retrySurfaces"
      | "changeHsl"
      | "resetHsl"
      | "grayscale"
      // 写真から範囲を探している間（niho-photo#135。渡したときだけ 1 行と取り消しを出す）
      | "detecting"
      | "cancelDetect"
    >
  > & {
    disabled: boolean;
  };

/** 局所の差分の値の見せ方（露光量は全体と同じ書き方、ほかは符号つきの整数）。スマホの段（niho-photo#93）も使う。 */
export function formatPhotoEditingMaskAdjust(key: DevelopMaskAdjustKey, value: number): string {
  return key === "exposure" ? formatAdjustmentValue("exposure", value) : formatSignedInteger(value);
}

/**
 * 右パネルのマスクの面（部分補正。M3 #67。見出し行・↶ ↷・「初期化」は右パネルが持つ）。上から「マスクを追加」（wasm が描ける
 * 種類だけ。8 枚・原寸の書き出しが描けないときは押せず、理由を出す）、マスクの一覧（種類の印・名前・目〔当てる / 外す〕・反転・
 * 複製・削除）、範囲の重ね表示の切り替え（O）、選んだマスクの局所の補正（全体と同じ ライト／カラー／効果。値は全体への差分で
 * 0 が既定。相対の白は全体の白が `absolute` の間は出さない。カラーの群の後ろに既定で閉じた局所のカラーミキサー〔niho-photo#93〕）と、
 * 円形のぼかし。
 */
export function PhotoEditingMaskTools(props: PhotoEditingMaskToolsProps) {
  const idPrefix = useId();
  const { masks, selected, disabled } = props;
  const selectedIndex = selected ? masks.findIndex((mask) => mask.id === selected.id) : -1;
  const selectedName = selected ? photoEditingMaskLabel(selected.kind, selectedIndex) : null;
  const overlayId = `${idPrefix}-overlay`;
  const reasonId = `${idPrefix}-add-reason`;

  const renderSlider = (
    mask: DevelopMask,
    definition: { key: DevelopMaskAdjustKey; label: string; min: number; max: number; step: number; whiteBalance: boolean },
    channel: "temperature" | "tint" | null,
  ) => {
    const value = readPhotoEditingMaskAdjust(mask, definition.key);
    return (
      <PhotoEditingSlider
        key={definition.key}
        id={`${idPrefix}-${mask.id}-${definition.key}`}
        label={definition.label}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={value}
        valueText={formatPhotoEditingMaskAdjust(definition.key, value)}
        disabled={disabled}
        onChange={(next: number, phase: PhotoEditingSliderPhase) => props.changeAdjust(mask.id, definition.key, next, phase)}
        onReset={() => props.changeAdjust(mask.id, definition.key, 0, "commit")}
        changed={value !== 0}
        trackClassName={channel ? WHITE_BALANCE_TRACK_CLASS_NAMES[channel] : undefined}
      />
    );
  };

  return (
    <div data-testid="photo-mask-tools" className="space-y-3 pb-2">
      <section aria-labelledby={`${idPrefix}-add`} className="space-y-1.5">
        <h3 id={`${idPrefix}-add`} className={SECTION_TITLE_CLASS_NAME}>
          {PHOTO_EDITING_MASK_ADD_TITLE}
        </h3>
        <div className="grid grid-cols-1 gap-1.5">
          {props.kinds.map((kind) => {
            const Icon = PHOTO_EDITING_MASK_KIND_ICONS[kind] ?? CircleDot;
            return (
              <button
                key={kind}
                type="button"
                disabled={disabled || !props.canAdd}
                aria-describedby={props.addBlockedReason ? reasonId : undefined}
                onClick={() => props.add(kind)}
                className={ADD_BUTTON_CLASS_NAME}
              >
                <Icon className="h-4 w-4 shrink-0 text-niho-text-sub" aria-hidden />
                {PHOTO_EDITING_MASK_ADD_LABELS[kind]}
              </button>
            );
          })}
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
            className="flex items-center gap-2 rounded-lg bg-niho-pale/60 px-2.5 py-2"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-niho-text-sub motion-reduce:animate-none" aria-hidden />
            <p className={cn(NOTE_CLASS_NAME, "min-w-0 flex-1")}>{PHOTO_EDITING_MASK_DETECTING_TEXTS[props.detecting]}</p>
            {props.cancelDetect ? (
              <button
                type="button"
                onClick={props.cancelDetect}
                className={cn("shrink-0 text-xs font-bold text-niho-accent-ink underline-offset-2 hover:underline", FOCUS_RING_CLASS_NAME)}
              >
                {PHOTO_EDITING_MASK_DETECT_CANCEL_LABEL}
              </button>
            ) : null}
          </div>
        ) : null}
        {props.notice ? (
          <div role="status" data-testid="photo-mask-notice" className="space-y-1 rounded-lg bg-niho-pale/60 px-2.5 py-2">
            <p className={NOTE_CLASS_NAME}>{props.notice}</p>
            {props.canRetrySurfaces && props.retrySurfaces ? (
              <button
                type="button"
                onClick={props.retrySurfaces}
                className={cn("text-xs font-bold text-niho-accent-ink underline-offset-2 hover:underline", FOCUS_RING_CLASS_NAME)}
              >
                {PHOTO_EDITING_MASK_SURFACE_RETRY_LABEL}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby={`${idPrefix}-list`} className="space-y-1">
        <h3 id={`${idPrefix}-list`} className={SECTION_TITLE_CLASS_NAME}>
          {PHOTO_EDITING_MASK_LIST_TITLE}
        </h3>
        {masks.length === 0 ? (
          <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_LIST_EMPTY_TEXT}</p>
        ) : (
          <ul className="space-y-0.5">
            {masks.map((mask, index) => {
              const name = photoEditingMaskLabel(mask.kind, index);
              const Icon = PHOTO_EDITING_MASK_KIND_ICONS[mask.kind] ?? CircleDot;
              const isSelected = selected?.id === mask.id;
              return (
                <li
                  key={mask.id}
                  data-mask-row={mask.id}
                  className={cn(
                    "flex h-9 items-center gap-0.5 rounded-lg pr-1",
                    isSelected ? "bg-niho-accent-soft" : "hover:bg-niho-pale/60",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={photoEditingMaskSelectLabel(name)}
                    onClick={() => props.select(isSelected ? null : mask.id)}
                    className={cn(
                      "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 text-left text-xs font-bold",
                      isSelected ? "text-niho-accent-ink" : "text-niho-text",
                      !mask.enabled && "opacity-50",
                      FOCUS_RING_CLASS_NAME,
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">{name}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={mask.enabled}
                    aria-label={photoEditingMaskEnabledLabel(name)}
                    title={photoEditingMaskEnabledLabel(name)}
                    disabled={disabled}
                    onClick={() => props.toggleEnabled(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    {mask.enabled ? <Eye className="h-3.5 w-3.5" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
                  </button>
                  <button
                    type="button"
                    aria-pressed={mask.invert}
                    aria-label={photoEditingMaskInvertLabel(name)}
                    title={photoEditingMaskInvertLabel(name)}
                    disabled={disabled}
                    onClick={() => props.toggleInvert(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    <FlipVertical2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={photoEditingMaskDuplicateLabel(name)}
                    title={photoEditingMaskDuplicateLabel(name)}
                    disabled={disabled || props.addBlockedReason !== null}
                    onClick={() => props.duplicate(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={photoEditingMaskDeleteLabel(name)}
                    title={photoEditingMaskDeleteLabel(name)}
                    disabled={disabled}
                    onClick={() => props.remove(mask.id)}
                    className={ROW_ICON_BUTTON_CLASS_NAME}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        id={overlayId}
        type="button"
        role="switch"
        aria-checked={props.overlayVisible}
        aria-keyshortcuts="O"
        onClick={() => props.setOverlayVisible(!props.overlayVisible)}
        className={cn("flex min-h-8 w-full items-center justify-between gap-2 rounded text-left", FOCUS_RING_CLASS_NAME)}
      >
        <span className="text-xs font-bold text-niho-text-sub">
          {PHOTO_EDITING_MASK_OVERLAY_LABEL}
          <span aria-hidden className="ml-1.5 font-normal text-niho-text-muted">
            {PHOTO_EDITING_MASK_OVERLAY_KEY_HINT}
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full motion-safe:transition-colors",
            props.overlayVisible ? "bg-niho-accent-ink" : "bg-niho-text-muted/50",
          )}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm motion-safe:transition-transform",
              props.overlayVisible ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>

      {selected && selectedName ? (
        <section aria-labelledby={`${idPrefix}-selected`} className="space-y-1" data-testid="photo-mask-adjust">
          <h3 id={`${idPrefix}-selected`} className="text-sm font-bold text-niho-text">
            {photoEditingMaskAdjustTitle(selectedName)}
          </h3>
          {selected.kind === "linear" || selected.kind === "radial" ? (
            <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_HINT_TEXT}</p>
          ) : selected.kind === "subject" || selected.kind === "sky" ? (
            <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_DETECTED_TEXT}</p>
          ) : props.brush?.available && props.brush.mask?.id === selected.id ? (
            <PhotoEditingMaskBrushTools brush={props.brush} disabled={disabled} />
          ) : (
            <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_MASK_SURFACE_TEXT}</p>
          )}
          {PHOTO_EDITING_MASK_ADJUST_GROUPS.map((group) => {
            const adjustments = group.adjustments.filter((definition) => !(definition.whiteBalance && props.whiteBalanceAbsolute));
            if (adjustments.length === 0) return null;
            return (
              <Fragment key={group.id}>
                <div role="group" aria-labelledby={`${idPrefix}-group-${group.id}`} className="pt-1">
                  <h4 id={`${idPrefix}-group-${group.id}`} className={cn(SECTION_TITLE_CLASS_NAME, "py-1")}>
                    {group.title}
                  </h4>
                  {adjustments.map((definition) =>
                    renderSlider(
                      selected,
                      definition,
                      definition.key === "relativeTemperature" ? "temperature" : definition.key === "relativeTint" ? "tint" : null,
                    ),
                  )}
                </div>
                {group.id === "color" && props.changeHsl && props.resetHsl ? (
                  // 局所のカラーミキサー（niho-photo#93。全体の右パネルと同じくカラーの群の後ろ・既定は閉じる）
                  <div className="pt-1" data-testid="photo-mask-hsl">
                    <PhotoEditingMaskHslSection
                      mask={selected}
                      disabled={disabled}
                      grayscale={props.grayscale === true}
                      onChange={props.changeHsl}
                      onReset={props.resetHsl}
                    />
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {selected.kind === "radial" ? (
            <div role="group" aria-labelledby={`${idPrefix}-shape`} className="pt-1">
              <h4 id={`${idPrefix}-shape`} className={cn(SECTION_TITLE_CLASS_NAME, "py-1")}>
                {PHOTO_EDITING_MASK_SHAPE_TITLE}
              </h4>
              <PhotoEditingSlider
                id={`${idPrefix}-${selected.id}-feather`}
                label={PHOTO_EDITING_MASK_FEATHER_LABEL}
                min={0}
                max={100}
                step={1}
                value={selected.feather}
                valueText={String(Math.round(selected.feather))}
                disabled={disabled}
                onChange={(next, phase) => props.changeFeather(selected.id, next, phase)}
                onReset={() => props.changeFeather(selected.id, PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER, "commit")}
                changed={selected.feather !== PHOTO_EDITING_RADIAL_MASK_DEFAULT_FEATHER}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
