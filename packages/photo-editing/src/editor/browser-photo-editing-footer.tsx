"use client";

import type { KeyboardEvent, MutableRefObject, ReactNode } from "react";
import { Columns2, FolderMinus, FolderPlus, ImageIcon, LayoutGrid } from "lucide-react";

import type {
  BrowserPhotoExportChoices,
  BrowserPhotoExportFormat,
  BrowserPhotoExportSizeOption,
} from "../browser-photo-export";
import type { DevelopSettingsSaverState } from "../develop-engine/develop-settings-autosave";
import {
  BROWSER_PHOTO_EDITING_WIDE_ONLY_TEXT,
  PHOTO_EDITING_COMPARE_OFF_LABEL,
  PHOTO_EDITING_COMPARE_ORIGINAL_LABEL,
  PHOTO_EDITING_COMPARE_SIDE_LABEL,
  PHOTO_EDITING_COMPARE_SPLIT_LABEL,
  PHOTO_EDITING_COMPARE_VIEW_LABEL,
  PHOTO_EDITING_COMPARE_VIEW_TITLE,
  PHOTO_EDITING_RETRY_LABEL,
  photoEditingCompareViewButtonLabel,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import { BrowserPhotoExportSheet } from "./browser-photo-editing-export-sheet";
import { BrowserPhotoFavoriteButton, type BrowserPhotoFavoriteControl } from "./browser-photo-editing-favorite-button";
import { BrowserPhotoFlagButtons, type BrowserPhotoFlagControl } from "./browser-photo-editing-flags";
import {
  DEVELOP_SAVE_FAILED_TEXT,
  type AddRetry,
  type BrowserViewMode,
  type FooterStatus,
} from "./browser-photo-editing-model";
import {
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";
import { PhotoEditingMenu } from "./photo-editing-menu";
import type { BrowserPhotoCompareMode } from "./use-browser-photo-compare-view";

/** ブラウザ版の下段（一覧 ⇄ 1 枚の切り替え・状態欄・お気に入りの ♥・選別・「補正前」・「比較」・「書き出す」）。 */

/** 状態欄・右パネルの「再試行」（字だけ。押せる範囲は 44px） */
const RETRY_BUTTON_CLASS_NAME = PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME;
const STATUS_LINE_CLASS_NAME = "min-w-0 truncate text-xs font-bold";

function viewSwitchClassName(pressed: boolean): string {
  return cn(
    "inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-35",
    pressed
      ? "bg-niho-accent-soft text-niho-accent-ink"
      : "text-niho-text-muted enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text-sub",
  );
}

/**
 * 状態欄の 1 行。進み具合（追加・書き出し・消している途中）> 自動保存の失敗（「再試行」）> 追加の失敗（「再試行」）> 失敗 >
 * 一覧の読み込みの失敗 > 知らせ > 一覧にある準備中の写真 > 狭い幅の 1 枚の「基本補正はPCで使えます」。補正後のプレビューを
 * 上げている間は何も出さない（K3 移行元設計）。
 */
export function BrowserPhotoEditingStatusLine(props: {
  progressText: string | null;
  saveState: DevelopSettingsSaverState;
  onRetrySave: () => void;
  status: FooterStatus | null;
  canAdd: boolean;
  /** 追加できなかった写真をもう一度入れる（ファイルか、この Mac の写真。K2 移行元設計） */
  onRetryAdd: (retry: AddRetry) => void;
  /** この Mac の写真の追加を止められる */
  canStopAdd: boolean;
  onStopAdd: () => void;
  /** 一覧で出す、開けなかった理由 */
  gridSourceError: string | null;
  /** 一覧にある作業コピー待ちの写真の状態 */
  pendingWorkText: string | null;
  /** 狭い幅で直せる写真を 1 枚で見ている */
  showWideOnlyNote: boolean;
  /** 現在の写真に残っている端末内の未保存補正。PC / mobile の同じ状態欄で明示操作を求める。 */
  recovery?: {
    count: number;
    conflict: boolean;
    busy: boolean;
    message?: string | null;
    onRestore: () => void;
    onDiscard: () => void;
    /** durable cloud復旧は同じ状態欄に、固定された比較選択などの明示操作を渡す。 */
    actions?: readonly { label: string; onClick: () => void; disabled?: boolean }[];
  } | null;
}) {
  const status = props.status;
  if (props.progressText) {
    return (
      <>
        <p role="status" className={cn(STATUS_LINE_CLASS_NAME, "text-niho-text-sub")}>{props.progressText}</p>
        {props.canStopAdd ? (
          <button type="button" onClick={props.onStopAdd} className={RETRY_BUTTON_CLASS_NAME}>
            止める
          </button>
        ) : null}
      </>
    );
  }
  const recovery = props.recovery;
  if (recovery) {
    const extra = recovery.count > 1 ? `（ほか${recovery.count - 1}件）` : "";
    const actions = recovery.actions;
    return (
      <>
        <p role="status" className={cn(STATUS_LINE_CLASS_NAME, "text-niho-text-sub")}>
          {recovery.message ??
            (recovery.conflict ? "別の端末の編集後に、未保存の補正があります" : "未保存の補正があります")}
          {extra}
        </p>
        {actions ? actions.map((action) => (
          <button
            key={action.label}
            type="button"
            disabled={recovery.busy || action.disabled}
            onClick={action.onClick}
            className={RETRY_BUTTON_CLASS_NAME}
          >
            {action.label}
          </button>
        )) : (
          <>
            <button type="button" disabled={recovery.busy} onClick={recovery.onRestore} className={RETRY_BUTTON_CLASS_NAME}>
              復元
            </button>
            <button type="button" disabled={recovery.busy} onClick={recovery.onDiscard} className={RETRY_BUTTON_CLASS_NAME}>
              破棄
            </button>
          </>
        )}
      </>
    );
  }
  if (props.saveState === "failed") {
    // 自動保存の失敗は薄く出し、その場で送り直せる（成功は何も出さない）
    return (
      <>
        <p role="status" className={cn(STATUS_LINE_CLASS_NAME, "text-niho-text-sub")}>{DEVELOP_SAVE_FAILED_TEXT}</p>
        <button type="button" onClick={props.onRetrySave} className={RETRY_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_RETRY_LABEL}
        </button>
      </>
    );
  }
  if (status?.kind === "addFailed") {
    const retry = status.retry;
    return (
      <>
        <p role="alert" className={cn(STATUS_LINE_CLASS_NAME, "text-niho-danger")}>{status.text}</p>
        <button
          type="button"
          disabled={!props.canAdd}
          onClick={() => props.onRetryAdd(retry)}
          className={RETRY_BUTTON_CLASS_NAME}
        >
          {PHOTO_EDITING_RETRY_LABEL}
        </button>
      </>
    );
  }
  // 1 行の後ろの文字のボタン（一括の補正の［元に戻す］。F5a-2 移行元設計）。行は切れても title で全文を読める
  const statusAction =
    (status?.kind === "error" || status?.kind === "notice") && status.action ? (
      <button type="button" onClick={status.action.onClick} className={RETRY_BUTTON_CLASS_NAME}>
        {status.action.label}
      </button>
    ) : null;
  if (status?.kind === "error") {
    return (
      <>
        <p role="alert" title={status.text} className={cn(STATUS_LINE_CLASS_NAME, "text-niho-danger")}>{status.text}</p>
        {statusAction}
      </>
    );
  }
  if (props.gridSourceError) {
    return <p role="alert" className={cn(STATUS_LINE_CLASS_NAME, "text-niho-danger")}>{props.gridSourceError}</p>;
  }
  if (status?.kind === "notice") {
    return (
      <>
        <p role="status" title={status.text} className={cn(STATUS_LINE_CLASS_NAME, "text-niho-text-sub")}>{status.text}</p>
        {statusAction}
      </>
    );
  }
  if (props.pendingWorkText) {
    return <p role="status" className={cn(STATUS_LINE_CLASS_NAME, "text-niho-text-sub")}>{props.pendingWorkText}</p>;
  }
  if (props.showWideOnlyNote) {
    return <p className={cn(STATUS_LINE_CLASS_NAME, "text-niho-text-muted lg:hidden")}>{BROWSER_PHOTO_EDITING_WIDE_ONLY_TEXT}</p>;
  }
  return null;
}

/**
 * 下段の「比較」（niho-photo#41。PC だけ）。押すと 1 つを選ぶメニュー（並べる（左右）/ 分割 / 比較しない）。比較している間は
 * ボタンを押した色にし、読み上げ名に今の見せ方を含める（「比較：分割」）。キーは Y（並べる）/ ⇧Y（分割）で、title で案内する。
 */
function BrowserPhotoCompareViewMenu(props: {
  mode: BrowserPhotoCompareMode;
  disabled: boolean;
  onChange: (mode: BrowserPhotoCompareMode) => void;
}) {
  const { mode, onChange } = props;
  return (
    <PhotoEditingMenu
      variant="browser"
      align="end"
      items={[
        { key: "side", label: PHOTO_EDITING_COMPARE_SIDE_LABEL, checked: mode === "side", onSelect: () => onChange("side") },
        { key: "split", label: PHOTO_EDITING_COMPARE_SPLIT_LABEL, checked: mode === "split", onSelect: () => onChange("split") },
        { key: "off", label: PHOTO_EDITING_COMPARE_OFF_LABEL, checked: mode === "off", onSelect: () => onChange("off") },
      ]}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={photoEditingCompareViewButtonLabel(mode)}
        title={PHOTO_EDITING_COMPARE_VIEW_TITLE}
        disabled={props.disabled}
        className={cn(
          PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
          "hidden h-11 lg:inline-flex",
          mode !== "off" && "border-niho-accent-ink bg-niho-accent-soft text-niho-accent-ink",
        )}
      >
        <Columns2 className="h-4 w-4" aria-hidden />
        {PHOTO_EDITING_COMPARE_VIEW_LABEL}
      </button>
    </PhotoEditingMenu>
  );
}

export function BrowserPhotoEditingFooter(props: {
  viewMode: BrowserViewMode;
  /** 1 枚を開ける（選んでいて、追加している途中でない） */
  canOpenLoupe: boolean;
  onShowGrid: () => void;
  onShowLoupe: () => void;
  statusLine: ReactNode;
  /** お気に入りの ♥（選んでいる 1 枚・開いている 1 枚。PC の一覧でも 1 枚でも出す。F5b 移行元設計） */
  favorite?: BrowserPhotoFavoriteControl;
  /**
   * 選別の採用・却下・外す（niho-photo#47。一覧で選んでいる写真・開いている 1 枚。PC だけ・♥ の隣）。選別を持たない写真の出どころは
   * 渡さない
   */
  flag?: BrowserPhotoFlagControl;
  /** PC の一覧で 1 枚を選んだときのアルバム操作 */
  albumAction?: { label: string; disabled: boolean; onClick: () => void };
  /** Trusted host が明示的にクラウド共有を接続したときだけ出す。 */
  shareAction?: { disabled: boolean; onClick: () => void };
  /** Trusted host が個人クラウドを接続した、この Mac の選択中の 1 枚だけに出す。 */
  copyToCloudAction?: { disabled: boolean; onClick: () => void };
  /** 「補正前」を出す（1 枚で補正の入力を開けている） */
  showCompare: boolean;
  compareDisabled: boolean;
  compareOriginal: boolean;
  onCompareOriginalChange: (compare: boolean) => void;
  /**
   * 「比較」（補正前と補正後を並べる・分割する。niho-photo#41。PC だけ・「補正前」の右）。押すとメニュー（並べる（左右）/ 分割 /
   * 比較しない）。渡さない間は出さない
   */
  compareView?: { mode: BrowserPhotoCompareMode; disabled: boolean; onChange: (mode: BrowserPhotoCompareMode) => void };
  exportButtonRef: MutableRefObject<HTMLButtonElement | null>;
  exportSheetOpen: boolean;
  /** 一覧の複数選択のシートも同じボタンで開く */
  exportButtonExpanded?: boolean;
  canExport: boolean;
  exportChoices: BrowserPhotoExportChoices | null;
  onToggleExportSheet: () => void;
  /** シートで選んだ形式と大きさ（原寸は NIHO Desktop の口があるときだけ。K2-3a 移行元設計） */
  onExport: (format: BrowserPhotoExportFormat, size: BrowserPhotoExportSizeOption) => void;
  onCloseExportSheet: () => void;
  /** 置く列（PC の幅。狭い幅は全幅）。Lightroom と同じく中央の列の下だけに置き、左右のパネルは窓の底まで伸ばす（niho-photo#49） */
  className?: string;
}) {
  const setCompareOriginal = props.onCompareOriginalChange;
  return (
    <footer className={cn("col-span-full flex min-h-14 items-center gap-2 border-t border-niho-border px-2 max-[479px]:flex-wrap lg:px-3 lg:max-xl:flex-wrap lg:max-xl:gap-y-1 lg:max-xl:py-1", props.className)}>
      <div role="group" aria-label="表示" className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label="一覧"
          title="一覧"
          aria-pressed={props.viewMode === "grid"}
          onClick={props.onShowGrid}
          className={viewSwitchClassName(props.viewMode === "grid")}
        >
          <LayoutGrid className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="1枚"
          title="1枚"
          aria-pressed={props.viewMode === "loupe"}
          disabled={!props.canOpenLoupe}
          onClick={props.onShowLoupe}
          className={viewSwitchClassName(props.viewMode === "loupe")}
        >
          <ImageIcon className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 max-[479px]:w-full max-[479px]:flex-none max-[479px]:justify-between max-[479px]:empty:hidden">
        {props.statusLine}
      </div>
      {props.albumAction ? (
        <button
          type="button"
          disabled={props.albumAction.disabled}
          onClick={props.albumAction.onClick}
          className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "hidden h-11 shrink-0 lg:inline-flex")}
        >
          {props.albumAction.label === "アルバムから外す" ? (
            <FolderMinus className="h-4 w-4" aria-hidden />
          ) : (
            <FolderPlus className="h-4 w-4" aria-hidden />
          )}
          {props.albumAction.label}
        </button>
      ) : null}
      {props.favorite ? (
        // PC だけ（「補正前」と同じ）。狭い幅はスマホの 1 枚の層の上の帯に置き、下段は状態欄の幅を残す
        <BrowserPhotoFavoriteButton {...props.favorite} className="hidden lg:flex" />
      ) : null}
      {props.flag ? <BrowserPhotoFlagButtons {...props.flag} className="hidden lg:flex" /> : null}
      {props.shareAction ? (
        <button
          type="button"
          disabled={props.shareAction.disabled}
          onClick={props.shareAction.onClick}
          className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}
        >
          共有
        </button>
      ) : null}
      {props.copyToCloudAction ? (
        <button
          type="button"
          disabled={props.copyToCloudAction.disabled}
          onClick={props.copyToCloudAction.onClick}
          className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}
        >
          クラウドにコピー
        </button>
      ) : null}
      {props.showCompare ? (
        <button
          type="button"
          disabled={props.compareDisabled}
          aria-pressed={props.compareOriginal}
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
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (event.key === " " || event.key === "Enter") setCompareOriginal(true);
          }}
          onKeyUp={() => setCompareOriginal(false)}
          className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "hidden h-11 lg:inline-flex")}
        >
          {PHOTO_EDITING_COMPARE_ORIGINAL_LABEL}
        </button>
      ) : null}
      {props.compareView ? <BrowserPhotoCompareViewMenu {...props.compareView} /> : null}
      <div className="relative shrink-0">
        <button
          ref={props.exportButtonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={props.exportButtonExpanded ?? props.exportSheetOpen}
          disabled={!props.canExport}
          onClick={props.onToggleExportSheet}
          className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-11")}
        >
          書き出す
        </button>
        {props.exportSheetOpen && props.canExport && props.exportChoices ? (
          <BrowserPhotoExportSheet
            choices={props.exportChoices}
            anchorRef={props.exportButtonRef}
            onDownload={props.onExport}
            onClose={props.onCloseExportSheet}
          />
        ) : null}
      </div>
    </footer>
  );
}
