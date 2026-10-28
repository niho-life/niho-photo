"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import {
  browserPhotoBatchExportLine,
  browserPhotoExportChoice,
  browserPhotoExportLine,
  defaultBrowserPhotoExportFormat,
  effectiveBrowserPhotoExportSizeOption,
  isBrowserPhotoExportFullSizeOnly,
  type BrowserPhotoExportChoices,
  type BrowserPhotoExportFormat,
  type BrowserPhotoExportSizeOption,
} from "../browser-photo-export";
import {
  PHOTO_EDITING_CLOSE_LABEL,
  PHOTO_EDITING_EXPORT_DOWNLOAD_LABEL,
  PHOTO_EDITING_EXPORT_FORMAT_LABEL,
  PHOTO_EDITING_EXPORT_JPEG_LABEL,
  PHOTO_EDITING_EXPORT_LABEL,
  PHOTO_EDITING_EXPORT_ORIGINAL_LABEL,
  PHOTO_EDITING_EXPORT_PNG_LABEL,
  PHOTO_EDITING_EXPORT_SAVE_LABEL,
  PHOTO_EDITING_EXPORT_TO_FOLDER_LABEL,
} from "../photo-editing-copy";
import { usePhotoEditingExportSize } from "../photo-editing-local-settings";
import { cn } from "niho-ui/cn";

import { BrowserPhotoExportSizeCards } from "./browser-photo-editing-export-size";
import {
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";

/** 形式の並び（PNG は `choices.png` のあるシートだけ。背景除去。C4 移行元設計） */
const FORMATS: readonly { format: BrowserPhotoExportFormat; label: string }[] = [
  { format: "jpeg", label: PHOTO_EDITING_EXPORT_JPEG_LABEL },
  { format: "png", label: PHOTO_EDITING_EXPORT_PNG_LABEL },
  { format: "original", label: PHOTO_EDITING_EXPORT_ORIGINAL_LABEL },
];

/**
 * 「書き出す」のシート（ブラウザ版の写真編集、移行元設計・F7b 移行元設計・モック `idea/mock/photo-editing-browser-lightroom-v1.html` と
 * スマホのシート `idea/mock/photo-editing-mobile-v1.html`）。1 枚では下段の主ボタンの上、複数枚では一覧上段のボタンの下に出し、スマホのシートと同じ順で「大きさ」
 * （長辺 2048px / 幅 1080px。オリジナルを選んでいる間・段 2 で描かない JPEG では押せない。選んだ大きさはこの端末に覚える）→
 * 「形式」（JPEG / オリジナル）→ 1 行（JPEG は撮影日時を付けること、オリジナルはそのまま保存すること）を出して「ダウンロード」する。
 * 押せない形式は薄くして副文に理由を出す。Esc・「閉じる」・シートの外を押すと閉じる（開いた主ボタンを押したときは、主ボタンが開閉する）。
 *
 * 原寸の書き出しに対応した NIHO Desktop の口があれば（`choices.jpeg.fullSize`。K2-3a 移行元設計）、大きさに「原寸」（副文「この Mac に
 * 保存」）を足す。原寸の JPEG を選んでいる間は 1 行に「保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。」を足し、主ボタンを
 * 「保存」にする（押すとネイティブの保存ダイアログ）。
 *
 * NIHO camera で背景除去を重ねている写真（`choices.png`・`choices.cutout`。C4 移行元設計）は、形式を「JPEG（背景除去を反映）」→
 * 「PNG（背景除去を反映）」→「オリジナル」にし（括弧の中は副文）、PNG も JPEG と同じく大きさ（camera の口があれば原寸も）を選べる。1 行は PNG なら
 * 「（背景の透明をそのまま保存します。）撮影日時は付けません。」、JPEG の透明の背景は「透明の背景は白にします。」を足す。
 *
 * 複数枚のシートで大きさが原寸だけ（NIHO Desktop のフォルダへの書き出し。{@link isBrowserPhotoExportFullSizeOnly}。K2-3b 移行元設計）
 * なら、大きさは「原寸」のカード 1 枚だけを選んだまま出し、1 行を「選んだ N 枚を、選ぶフォルダへ原寸で書き出します（…）。」、
 * 主ボタンを「フォルダに書き出す」にする（押すとネイティブのフォルダの選択）。
 */
export function BrowserPhotoExportSheet(props: {
  choices: BrowserPhotoExportChoices;
  /** 複数枚を PC で ZIP にまとめる（NIHO Desktop はフォルダへ原寸で書き出す）シート。無ければ従来の 1 枚書き出し。 */
  batchCount?: number;
  /** 開いた主ボタン（外を押したかの判定から外し、閉じたらフォーカスを戻す） */
  anchorRef: RefObject<HTMLElement | null>;
  onDownload: (format: BrowserPhotoExportFormat, size: BrowserPhotoExportSizeOption) => void;
  onClose: () => void;
}) {
  const { choices, onClose } = props;
  const groupName = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<BrowserPhotoExportFormat | null>(() => defaultBrowserPhotoExportFormat(choices));
  // 写真の読み込みが終わるなどで選んだ形式が押せなくなったら、押せる形式へ移す
  const format =
    selected && browserPhotoExportChoice(choices, selected)?.enabled ? selected : defaultBrowserPhotoExportFormat(choices);
  const [storedSize, setStoredSize] = usePhotoEditingExportSize();
  const size = effectiveBrowserPhotoExportSizeOption(choices, storedSize);
  // 原寸だけのシート（複数枚のフォルダへの書き出し）は、JPEG を段 2 で描かなくても原寸のカードを押せる見た目のまま出す
  const fullSizeOnly = isBrowserPhotoExportFullSizeOnly(choices);
  // 大きさを使うのは描く形式（JPEG・背景除去の PNG）だけ
  const rendersImage = format === "jpeg" || format === "png";
  const sizeDisabled = !rendersImage || (!choices.jpeg.sizeSelectable && !fullSizeOnly);
  const fullSizeSelected = rendersImage && size === "full";
  const line = props.batchCount
    ? browserPhotoBatchExportLine(choices, format, props.batchCount)
    : browserPhotoExportLine(choices, format, size);

  useEffect(() => {
    const sheet = sheetRef.current;
    // 最初は形式の選んでいる行へ（大きさはその上）
    const formats = sheet?.querySelector<HTMLFieldSetElement>("[data-export-formats]");
    const radio =
      formats?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      formats?.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)') ??
      null;
    (radio ?? sheet?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, []);

  useEffect(() => {
    const anchor = props.anchorRef;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (sheetRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [onClose, props.anchorRef]);

  const close = () => {
    onClose();
    props.anchorRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div
      ref={sheetRef}
      role="dialog"
      aria-label={PHOTO_EDITING_EXPORT_LABEL}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute right-0 z-20 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-niho-border bg-white p-2 shadow-lg",
        props.batchCount ? "top-full mt-2" : "bottom-full mb-2",
      )}
    >
      <BrowserPhotoExportSizeCards
        size={size}
        disabled={sizeDisabled}
        large={choices.jpeg.large}
        fullSize={choices.jpeg.fullSize}
        fullSizeOnly={fullSizeOnly}
        onChange={setStoredSize}
        className="px-1 pb-1 pt-1"
      />
      <fieldset data-export-formats className="mt-1">
        <legend className="px-1 pb-0.5 text-xs font-bold text-niho-text-muted">{PHOTO_EDITING_EXPORT_FORMAT_LABEL}</legend>
        {FORMATS.map(({ format: value, label }) => {
          const choice = browserPhotoExportChoice(choices, value);
          if (!choice) return null;
          return (
            <label
              key={value}
              className={cn(
                "flex min-h-11 items-start gap-3 rounded-xl px-3 py-2.5",
                choice.enabled ? "cursor-pointer hover:bg-niho-pale/60" : "cursor-not-allowed opacity-50",
              )}
            >
              <input
                type="radio"
                name={groupName}
                value={value}
                checked={format === value}
                disabled={!choice.enabled}
                onChange={() => setSelected(value)}
                className="mt-1 h-4 w-4 shrink-0 accent-niho-accent-ink"
              />
              <span className="min-w-0">
                <span className="block text-body font-bold text-niho-text">{label}</span>
                <span className="mt-0.5 block break-all text-xs font-bold text-niho-text-muted">{choice.detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {line ? <p className="px-3 pb-1 text-xs text-niho-text-sub">{line}</p> : null}
      <div className="mt-1 flex justify-end gap-2 border-t border-niho-border px-1 pt-2">
        <button type="button" onClick={close} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}>
          {PHOTO_EDITING_CLOSE_LABEL}
        </button>
        <button
          type="button"
          disabled={format === null}
          onClick={() => {
            if (format) props.onDownload(format, size);
          }}
          className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-11")}
        >
          {props.batchCount
            ? fullSizeOnly
              ? PHOTO_EDITING_EXPORT_TO_FOLDER_LABEL
              : "ZIPをダウンロード"
            : fullSizeSelected
              ? PHOTO_EDITING_EXPORT_SAVE_LABEL
              : PHOTO_EDITING_EXPORT_DOWNLOAD_LABEL}
        </button>
      </div>
    </div>
  );
}
