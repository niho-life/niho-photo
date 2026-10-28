"use client";

import { useId } from "react";

import {
  BROWSER_PHOTO_EXPORT_SIZE_OPTIONS,
  type BrowserPhotoExportChoice,
  type BrowserPhotoExportSizeOption,
} from "../browser-photo-export";
import {
  PHOTO_EDITING_EXPORT_FULL_SIZE_LABEL,
  PHOTO_EDITING_EXPORT_LARGE_LABEL,
  PHOTO_EDITING_EXPORT_SIZE_LABEL,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

/**
 * 書き出すのシートの「大きさ」（F7b 移行元設計・モック `idea/mock/photo-editing-mobile-v1.html`）。2 枚のカード（長辺 2048px / 標準、
 * 幅 1080px / Instagram）の radio で、PC とスマホのシートが同じものを使う。`disabled`（オリジナルを選んでいる間・段 2 で描かない
 * JPEG）の間は薄くして押せない（選んでいる大きさは見せたまま）。`busy`（書き出している間）は薄くせずに押せなくする。
 *
 * `fullSize`（原寸の書き出しに対応した NIHO Desktop の PC のシートだけ。K2-3a 移行元設計）があれば、2 枚の下に同じ書式の「原寸」の
 * カードを幅いっぱいに足す（副文は「この Mac に保存」、押せない写真では理由）。`fullSizeOnly`（複数枚のフォルダへの書き出し。
 * K2-3b）は 2 枚を出さず「原寸」のカードだけにする（ZIP でしか書き出せない大きさを、理由の無い薄いカードで見せない）。
 *
 * `large`（「大きく」。niho-photo#134。段 2 の wasm で描く JPEG で、スマホで wasm のメモリに収まる写真だけ）があれば、2 枚の下に
 * 同じ書式のカードを幅いっぱいに足す（副文は書き出す長辺「長辺 4,096px」か上限「長辺 2,560px まで」）。「原寸」はその下。
 */
export function BrowserPhotoExportSizeCards(props: {
  size: BrowserPhotoExportSizeOption;
  disabled: boolean;
  /** 書き出している間（形式のカードと同じく、薄くせずに押せなくする） */
  busy?: boolean;
  /** 大きさの「大きく」（無ければカードを出さない） */
  large?: BrowserPhotoExportChoice;
  /** 大きさの「原寸」（無ければカードを出さない） */
  fullSize?: BrowserPhotoExportChoice;
  /** 大きさが「原寸」だけ（長辺 2048px・幅 1080px のカードを出さない） */
  fullSizeOnly?: boolean;
  onChange: (size: BrowserPhotoExportSizeOption) => void;
  className?: string;
}) {
  const groupName = useId();
  const standardOptions: readonly (typeof BROWSER_PHOTO_EXPORT_SIZE_OPTIONS)[number][] =
    props.fullSizeOnly && props.fullSize ? [] : BROWSER_PHOTO_EXPORT_SIZE_OPTIONS;
  const cards: { size: BrowserPhotoExportSizeOption; label: string; detail: string; enabled: boolean; wide?: boolean }[] = [
    ...standardOptions.map((option) => ({ ...option, enabled: true })),
    ...(props.large && standardOptions.length > 0
      ? [
          {
            size: "large" as const,
            label: PHOTO_EDITING_EXPORT_LARGE_LABEL,
            detail: props.large.detail,
            enabled: props.large.enabled,
            wide: true,
          },
        ]
      : []),
    ...(props.fullSize
      ? [
          {
            size: "full" as const,
            label: PHOTO_EDITING_EXPORT_FULL_SIZE_LABEL,
            detail: props.fullSize.detail,
            enabled: props.fullSize.enabled,
            wide: true,
          },
        ]
      : []),
  ];
  return (
    <fieldset className={props.className}>
      <legend className="mb-1.5 text-xs font-bold text-niho-text-muted">{PHOTO_EDITING_EXPORT_SIZE_LABEL}</legend>
      <div className="grid grid-cols-2 gap-2">
        {cards.map(({ size, label, detail, enabled, wide }) => {
          const checked = props.size === size;
          const disabled = props.disabled || !enabled;
          return (
            <label
              key={size}
              className={cn(
                "flex min-h-14 min-w-0 flex-col justify-center gap-0.5 rounded-2xl border px-3 py-2 focus-within:ring-2 focus-within:ring-niho-accent-ink",
                wide && "col-span-2",
                checked ? "border-niho-accent-ink bg-niho-accent-soft" : "border-niho-border bg-white",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              )}
            >
              <input
                type="radio"
                name={groupName}
                value={size}
                checked={checked}
                disabled={disabled || props.busy}
                onChange={() => props.onChange(size)}
                className="sr-only"
              />
              <span className={cn("text-sub font-bold", checked ? "text-niho-accent-ink" : "text-niho-text")}>{label}</span>
              <span className="text-xs text-niho-text-sub">{detail}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
