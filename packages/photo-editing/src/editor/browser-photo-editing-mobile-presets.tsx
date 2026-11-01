"use client";

import { useQuery } from "@tanstack/react-query";

import { Spinner } from "niho-ui/components/spinner";
import { usePhotoLibrary } from "../library/photo-library-context";
import type { PhotoEditingBuiltinPreset } from "../photo-editing-types";
import {
  PHOTO_EDITING_MOBILE_PRESETS_LOAD_FAILED_TEXT,
  PHOTO_EDITING_MOBILE_PRESETS_LABEL,
  PHOTO_EDITING_MOBILE_PRESET_NONE_LABEL,
  PHOTO_EDITING_MOBILE_PRESETS_RELOAD_LABEL,
} from "../photo-editing-copy";
import { builtinPhotoPresetDisplayName } from "../photo-editing-preset-names";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import { cn } from "niho-ui/cn";

import { PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";
import {
  PhotoEditingPresetThumbnail,
  PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY,
  type PhotoEditingPresetThumbnails,
} from "./photo-editing-preset-thumbnail";
import { PhotoEditingRuler } from "./photo-editing-ruler";
import { builtinPhotoPresetKey, spotPhotoPresetKey, type PhotoEditingPresetTarget } from "./photo-editing-presets-panel";
import { BROWSER_PRESET_AMOUNT_DEFAULT, BROWSER_PRESET_AMOUNT_MAX } from "./use-browser-photo-presets";

/**
 * スマホ（1024px 未満）の 1 枚の編集の層の「プリセット」の段（NIHO Photo 段 1 F6c 移行元設計・モック
 * `idea/mock/photo-editing-mobile-v1.html`）。道具が「プリセット」の間、段 A（チップ）と段 B（目盛り）の代わりに出す。
 *
 * - 横に送れるタイルの列: 「なし」→ NIHO のプリセット（日本語名）→ 区切り → 拠点のプリセット（0 件なら区切りごと出さない）。
 *   押して当て、「なし」で外す（当てる・替える・外すは右パネルと同じ `useBrowserPhotoPresets`）。口のある wasm では、開いている
 *   写真に当てた 72px（360px 未満は 64px）の見本と、選択中の適用量（0〜150%）を出す
 * - 一覧は右パネル（`PhotoEditingPresetsPanel`）と同じ query key・読み込み関数で読む（cache を共有する。後で 1 つにまとめる）
 * - 読み込めなかった・当てられなかったときは、段のすぐ上の状態の行に 1 行
 */

/** 右パネルに渡すものと同じ形の、プリセットの情報と操作（面の `useBrowserPhotoPresets` から）。 */
export type BrowserPhotoEditingMobilePresetsProps = {
  spotId: string;
  scopeKey?: string;
  /** 同梱のプリセットの読み方（右パネルと同じ wasm エンジン） */
  builtinPresets: {
    queryKey: readonly unknown[];
    load: () => Promise<PhotoEditingBuiltinPreset[]>;
  };
  /** 当てられる（wasm で開いた写真を見ていて、閲覧のみ・操作の途中でない） */
  canApply: boolean;
  appliedPresetKey: string | null;
  applyingPresetKey: string | null;
  applyError: string | null;
  onApply: (preset: PhotoEditingPresetTarget) => void;
  /** 「なし」を押せる（選ばれているプリセットがある） */
  canClear: boolean;
  onClear: () => void;
  /** 開いている写真から描いた見本（口の無い wasm は undefined）。 */
  thumbnails?: PhotoEditingPresetThumbnails;
  /** 選択中の適用量。未選択または口の無い wasm は null。 */
  amount?: number | null;
  amountDisabled?: boolean;
  onAmountChange?: Parameters<typeof PhotoEditingRuler>[0]["onChange"];
};

/**
 * 面の高さ = 段 A（`h-11` = 2.75rem）＋ 段 B（`PhotoEditingRuler`: `pt-1` 0.25 ＋ 名前の行 `h-5` 1.25 ＋ `mt-0.5` 0.125 ＋
 * 目盛り `h-11` 2.75 ＋ `pb-1.5` 0.375 = 4.75rem）= 7.5rem（root 17px で 127.5px）。段 A・段 B を変えたらここも合わせる
 */
/** タイルは 72px 角（root 17px で 4.25rem）。幅 360px 未満は 4rem（「なし」と NIHO の 3 本が 320px に収まる） */
const TILE_SIZE_CLASS_NAME = "h-[4.25rem] w-[4.25rem] max-[359px]:h-16 max-[359px]:w-16";
const PLACEHOLDER_KEYS = ["placeholder-1", "placeholder-2", "placeholder-3"] as const;

function tileClassName(selected: boolean): string {
  return cn(
    "relative flex w-[4.25rem] shrink-0 flex-col items-center gap-1 text-center text-xs font-bold leading-tight transition max-[359px]:w-16 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed",
    selected ? "text-niho-accent-ink" : "text-niho-text-sub",
  );
}

export function BrowserPhotoEditingMobilePresets(
  props: BrowserPhotoEditingMobilePresetsProps & {
    /** 補正の入力を開けていない・保存の待ちなど（面ごと薄くして押せない。段 A のチップと同じ） */
    disabled: boolean;
    /** 段の帯と状態の行の見た目（層のものを渡す） */
    bandClassName: string;
    statusRowClassName: string;
  },
) {
  const onAmountChange = props.onAmountChange;
  // 拠点のプリセットは写真の出どころから読む（右パネル・一括の補正と同じ cache の形 `{ presets }`。移行元設計）
  const library = usePhotoLibrary();
  const builtinPresetsQuery = useQuery({
    queryKey: props.builtinPresets.queryKey,
    queryFn: props.builtinPresets.load,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const spotPresetsQuery = useQuery({
    queryKey: photoEditingQueryKeys.spotPresets(props.spotId, props.scopeKey),
    queryFn: async () => ({ presets: await library.presets.list() }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const locked = props.disabled || !props.canApply;
  const applying = props.applyingPresetKey !== null;
  const loadFailed = builtinPresetsQuery.isError || spotPresetsQuery.isError;
  const loading = !loadFailed && (builtinPresetsQuery.isPending || spotPresetsQuery.isPending);
  const spotPresets = spotPresetsQuery.data?.presets ?? [];
  const reloading =
    (builtinPresetsQuery.isError && builtinPresetsQuery.isFetching) ||
    (spotPresetsQuery.isError && spotPresetsQuery.isFetching);
  const showPresets = !loading && !loadFailed;
  const builtinTargets = showPresets
    ? (builtinPresetsQuery.data ?? []).map((preset) => ({
        key: builtinPhotoPresetKey(preset.id),
        name: builtinPhotoPresetDisplayName(preset),
        xmp: preset.xmp,
      }))
    : [];
  const spotTargets = showPresets
    ? spotPresets.map((preset) => ({ key: spotPhotoPresetKey(preset.id), name: preset.name, xmp: preset.xmp }))
    : [];

  const tile = (target: PhotoEditingPresetTarget) => {
    const selected = props.appliedPresetKey === target.key;
    const busy = props.applyingPresetKey === target.key;
    return (
      <button
        key={target.key}
        type="button"
        role="option"
        aria-selected={selected}
        aria-busy={busy || undefined}
        disabled={locked || applying}
        onClick={() => props.onApply(target)}
        className={tileClassName(selected)}
      >
        {props.thumbnails ? (
          <PhotoEditingPresetThumbnail
            thumbnailKey={target.key}
            xmp={target.xmp}
            thumbnails={props.thumbnails}
            className={cn(TILE_SIZE_CLASS_NAME, "rounded-xl", selected && "ring-2 ring-niho-text ring-offset-1 ring-offset-white")}
          />
        ) : (
          <span
            aria-hidden
            className={cn(TILE_SIZE_CLASS_NAME, "block rounded-xl bg-niho-pale", selected && "ring-2 ring-niho-text ring-offset-1 ring-offset-white")}
          />
        )}
        <span className="w-full truncate">{target.name}</span>
        {busy ? <Spinner size="sm" className="absolute right-1 top-1" /> : null}
      </button>
    );
  };

  const noneSelected = props.appliedPresetKey === null;
  // 当てられなかった理由が先（押した結果）。一覧を読めなかったときは、その場で読み直せる
  const status = props.applyError ? (
    <p role="alert" className="min-w-0 truncate text-xs font-bold text-niho-danger">
      {props.applyError}
    </p>
  ) : loadFailed ? (
    <>
      <p role="status" className="min-w-0 truncate text-xs font-bold text-niho-text-sub">
        {PHOTO_EDITING_MOBILE_PRESETS_LOAD_FAILED_TEXT}
      </p>
      <button
        type="button"
        disabled={reloading}
        onClick={() => {
          if (builtinPresetsQuery.isError) void builtinPresetsQuery.refetch();
          if (spotPresetsQuery.isError) void spotPresetsQuery.refetch();
        }}
        className={PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME}
      >
        {PHOTO_EDITING_MOBILE_PRESETS_RELOAD_LABEL}
      </button>
    </>
  ) : null;

  return (
    <>
      {status ? <div className={props.statusRowClassName}>{status}</div> : null}
      <div className={props.bandClassName}>
        <div
          role="listbox"
          aria-label={PHOTO_EDITING_MOBILE_PRESETS_LABEL}
          aria-busy={loading || undefined}
          aria-disabled={locked || undefined}
          className={cn(
            "flex items-start gap-2 overflow-x-auto overscroll-x-contain px-2.5 pb-1 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            locked && "opacity-40",
          )}
        >
          {/* 「なし」: 何も当てていなければ選ばれた表示のまま押せず、当てていれば押して外す */}
          <button
            type="button"
            role="option"
            aria-selected={noneSelected}
            disabled={locked || applying || !props.canClear}
            onClick={props.onClear}
            className={cn(tileClassName(noneSelected), !locked && !applying && !props.canClear && "disabled:cursor-default")}
          >
            {props.thumbnails ? (
              <PhotoEditingPresetThumbnail
                thumbnailKey={PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY}
                xmp={null}
                thumbnails={props.thumbnails}
                className={cn(TILE_SIZE_CLASS_NAME, "rounded-xl", noneSelected && "ring-2 ring-niho-text ring-offset-1 ring-offset-white")}
              />
            ) : (
              <span
                aria-hidden
                className={cn(TILE_SIZE_CLASS_NAME, "block rounded-xl bg-niho-pale", noneSelected && "ring-2 ring-niho-text ring-offset-1 ring-offset-white")}
              />
            )}
            <span className="w-full truncate">{PHOTO_EDITING_MOBILE_PRESET_NONE_LABEL}</span>
          </button>
          {/* 読んでいる間は、同じ大きさの中身の無いタイル */}
          {loading
            ? PLACEHOLDER_KEYS.map((key) => (
                <span
                  key={key}
                  aria-hidden
                  data-testid="photo-editing-mobile-preset-placeholder"
                  className={cn(TILE_SIZE_CLASS_NAME, "shrink-0 rounded-xl bg-niho-pale motion-safe:animate-pulse")}
                />
              ))
            : builtinTargets.map(tile)}
          {spotTargets.length > 0 ? (
            <>
              <span
                aria-hidden
                data-testid="photo-editing-mobile-presets-separator"
                className="mx-0.5 h-[4.25rem] w-px shrink-0 bg-niho-border max-[359px]:h-16"
              />
              {spotTargets.map(tile)}
            </>
          ) : null}
        </div>
        {props.amount != null && onAmountChange ? (
          <PhotoEditingRuler
            id="photo-editing-mobile-preset-amount"
            label="適用量"
            min={0}
            max={BROWSER_PRESET_AMOUNT_MAX}
            step={1}
            value={props.amount}
            valueText={`${props.amount}%`}
            disabled={props.amountDisabled === true}
            onChange={onAmountChange}
            onReset={() => onAmountChange(BROWSER_PRESET_AMOUNT_DEFAULT, "commit")}
          />
        ) : null}
      </div>
    </>
  );
}
