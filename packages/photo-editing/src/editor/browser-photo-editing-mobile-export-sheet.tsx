"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

import {
  browserPhotoExportLine,
  defaultBrowserPhotoExportFormat,
  effectiveBrowserPhotoExportSize,
  type BrowserPhotoExportChoices,
  type BrowserPhotoExportFormat,
  type BrowserPhotoExportSize,
} from "../browser-photo-export";
import {
  PHOTO_EDITING_CLOSE_LABEL,
  PHOTO_EDITING_EXPORT_DOWNLOAD_LABEL,
  PHOTO_EDITING_EXPORT_FORMAT_LABEL,
  PHOTO_EDITING_EXPORT_JPEG_LABEL,
  PHOTO_EDITING_EXPORT_LABEL,
  PHOTO_EDITING_EXPORT_ORIGINAL_LABEL,
  PHOTO_EDITING_EXPORT_READY_TEXT,
  PHOTO_EDITING_EXPORTING_LABEL,
} from "../photo-editing-copy";
import { usePhotoEditingExportSize } from "../photo-editing-local-settings";
import {
  photoSaveActionLabel,
  photoSaveEnv,
  resolvePhotoSaveRoute,
  type PhotoSaveRoute,
} from "../save-photos-to-device";
import { usePhotoEditingHost } from "../library/photo-library-context";
import { cn } from "niho-ui/cn";

import { BrowserPhotoExportSizeCards } from "./browser-photo-editing-export-size";
import { PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";
import type { BrowserPhotoExportResult } from "./use-browser-photo-export-delete";

// スマホのシートは JPEG / オリジナルだけ（PNG は PC の背景除去だけ。C4 移行元設計）
const FORMATS: readonly { format: Exclude<BrowserPhotoExportFormat, "png">; label: string }[] = [
  { format: "jpeg", label: PHOTO_EDITING_EXPORT_JPEG_LABEL },
  { format: "original", label: PHOTO_EDITING_EXPORT_ORIGINAL_LABEL },
];

const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * スマホの「書き出す」のシート（NIHO Photo 段 1 F6c 移行元設計・モック `idea/mock/photo-editing-mobile-v1.html`）。1 枚の編集の層の
 * 中に下から出し、モックどおり「大きさ」（長辺 2048px / 幅 1080px。F7b 移行元設計）→「形式」（JPEG / オリジナル）→ 1 行（JPEG は
 * 「撮影日時を付けます。位置情報は付けません。」、オリジナルは「オリジナルをそのまま保存します。」）の順に選んで保存する。押せない
 * 形式は薄くして副文に理由を出す（PC のシートと同じ規則。大きさはオリジナルを選んでいる間・段 2 で描かない JPEG では押せない。
 * 選んだ大きさはこの端末に覚える）。
 *
 * - 主ボタンは、JPEG なら端末の保存のしかたに合わせた文言（iPhone「写真に保存」・Android「端末に保存」。共有シートも端末の保存も
 *   無い環境は PC と同じ「ダウンロード」）、オリジナルは「ダウンロード」。
 * - 共有シートは押してから約 5 秒しか出せない。描くのに時間がかかったら「準備ができました。もう一度押してください」を出し、
 *   同じボタンの 2 回目で、描き終えた写真をそのまま渡す（`ready`）。描いた後に大きさを選び直したら、2 回目も描き直す。
 * - Esc・「閉じる」・幕のタップで閉じる。保存した・失敗した（状態欄に出る）ら閉じ、保存先の選択をやめたら開いたまま。
 */
export function BrowserPhotoMobileExportSheet(props: {
  choices: BrowserPhotoExportChoices;
  /** 一覧の複数選択から開くときの枚数。 */
  count?: number;
  /** 編集レイヤー外（一覧）から開くときは viewport に固定する。 */
  fixed?: boolean;
  /** 書き出している途中（主ボタンを「書き出し中…」にして押せなくする） */
  exporting: boolean;
  /** 描き終えて、同じボタンをもう一度押すのを待っている（JPEG） */
  ready: boolean;
  onExport: (
    format: BrowserPhotoExportFormat,
    saveRoute: PhotoSaveRoute,
    size: BrowserPhotoExportSize,
  ) => Promise<BrowserPhotoExportResult>;
  /** 描き終えた写真を共有シートへ渡す（押した操作の中で呼ぶ） */
  onSharePending: () => Promise<BrowserPhotoExportResult>;
  onClose: () => void;
}) {
  const { choices, onClose } = props;
  const requestClose = () => {
    if (props.exporting) return;
    onClose();
  };
  const groupName = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // この端末で写真をどう保存するか（シートを開いたときに 1 回確かめる）
  // 端末への保存（スマホアプリの保存先を選ぶ画面）を使えるかはアプリの都合（移行元設計）
  const host = usePhotoEditingHost();
  const [saveRoute] = useState<PhotoSaveRoute>(() => resolvePhotoSaveRoute(photoSaveEnv(host)));
  const [selected, setSelected] = useState<BrowserPhotoExportFormat | null>(() => defaultBrowserPhotoExportFormat(choices));
  // 写真の読み込みが終わるなどで選んだ形式が押せなくなったら、押せる形式へ移す
  const format = selected && choices[selected]?.enabled ? selected : defaultBrowserPhotoExportFormat(choices);
  const [storedSize, setStoredSize] = usePhotoEditingExportSize();
  const size = effectiveBrowserPhotoExportSize(choices, storedSize);
  const sizeDisabled = format !== "jpeg" || !choices.jpeg.sizeSelectable;
  const line = browserPhotoExportLine(choices, format);
  // 描き終えて待っている写真は、描いたときの大きさのまま（選び直したら描き直す）
  const [requestedSize, setRequestedSize] = useState<BrowserPhotoExportSize | null>(null);
  const ready = props.ready && format === "jpeg" && requestedSize === size;

  useEffect(() => {
    const sheet = sheetRef.current;
    // 最初は形式の選んでいるカードへ（大きさはその上）
    const formats = sheet?.querySelector<HTMLFieldSetElement>("[data-export-formats]");
    const radio =
      formats?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      formats?.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)') ??
      null;
    (radio ?? sheet?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    // Tab はシートの中を回る（後ろの層の操作へ出ない）
    const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = () => {
    if (!format || props.exporting) return;
    // 描き終えている写真は、押した操作の中でそのまま共有シートへ渡す（描き直さない）
    if (!ready && format === "jpeg") setRequestedSize(size);
    const result = ready ? props.onSharePending() : props.onExport(format, saveRoute, size);
    void result.then(
      (outcome) => {
        // 保存した・失敗した（状態欄に出ている）ら閉じる。やめた・もう一度押すのを待つ間は開いたまま
        if (outcome === "done" || outcome === "failed") onClose();
      },
      () => undefined,
    );
  };

  const saveLabel = props.exporting
    ? PHOTO_EDITING_EXPORTING_LABEL
    : format === "jpeg" && saveRoute !== "download"
      ? photoSaveActionLabel(saveRoute)
      : PHOTO_EDITING_EXPORT_DOWNLOAD_LABEL;
  const title = props.count && props.count > 1 ? `${props.count} 枚を書き出す` : PHOTO_EDITING_EXPORT_LABEL;

  return (
    <div className={cn(props.fixed ? "fixed" : "absolute", "inset-0 z-[160] flex flex-col justify-end")}>
      <div aria-hidden data-testid="photo-editing-mobile-export-scrim" onClick={requestClose} className="absolute inset-0 bg-black/30" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
        className="relative rounded-t-[20px] bg-white pb-[var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))] shadow-lg"
      >
        <div className="flex h-12 items-center pl-4 pr-1">
          <h2 className="min-w-0 flex-1 text-body font-bold text-niho-text">{title}</h2>
          <button
            type="button"
            aria-label={PHOTO_EDITING_CLOSE_LABEL}
            onClick={requestClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <BrowserPhotoExportSizeCards
          size={size}
          disabled={sizeDisabled}
          large={choices.jpeg.large}
          busy={props.exporting}
          onChange={setStoredSize}
          className="px-4"
        />
        <fieldset data-export-formats className="mt-3 px-4">
          <legend className="mb-1.5 text-xs font-bold text-niho-text-muted">{PHOTO_EDITING_EXPORT_FORMAT_LABEL}</legend>
          <div className="grid grid-cols-2 gap-2">
            {FORMATS.map(({ format: value, label }) => {
              const choice = choices[value];
              const checked = format === value;
              return (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-14 min-w-0 flex-col justify-center gap-0.5 rounded-2xl border px-3 py-2 focus-within:ring-2 focus-within:ring-niho-accent-ink",
                    checked ? "border-niho-accent-ink bg-niho-accent-soft" : "border-niho-border bg-white",
                    choice.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-50",
                  )}
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={value}
                    checked={checked}
                    disabled={!choice.enabled || props.exporting}
                    onChange={() => setSelected(value)}
                    className="sr-only"
                  />
                  <span className={cn("text-sub font-bold", checked ? "text-niho-accent-ink" : "text-niho-text")}>{label}</span>
                  <span className="break-all text-xs text-niho-text-sub">{choice.detail}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {line ? <p className="mt-3 px-4 text-xs text-niho-text-sub">{line}</p> : null}
        <div className="flex flex-col gap-2 px-4 pb-3 pt-3">
          <button
            type="button"
            disabled={format === null || props.exporting}
            onClick={save}
            className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-12 w-full justify-center text-body")}
          >
            {saveLabel}
          </button>
          <p role="status" className="min-h-[18px] text-center text-xs font-bold text-niho-text-sub">
            {ready && !props.exporting ? PHOTO_EDITING_EXPORT_READY_TEXT : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
