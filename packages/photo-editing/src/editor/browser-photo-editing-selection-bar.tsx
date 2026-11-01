"use client";

import { CircleCheck, FolderMinus, FolderPlus, Heart } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import {
  PHOTO_EDITING_SELECT_ALL_LABEL,
  PHOTO_EDITING_SELECT_CANCEL_LABEL,
  PHOTO_EDITING_SELECT_LABEL,
  photoEditingSelectionCountText,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

/**
 * ブラウザ版の一覧の複数選択の面（F5a-2 移行元設計）。選択バーは、複数枚（2 枚以上）を選んでいる間と、スマホの選択モードの間、一覧の
 * 上に残る行（並びの切り替え・使用量の行）の代わりに出す。広い幅は左から「N 枚を選択」・お気に入り・アルバム・［すべて］・
 * ［補正 ▾］（直せる operator だけ。一括の補正のメニュー。`browser-photo-editing-bulk-menu.tsx`）・［書き出す］・［キャンセル］
 * （PCブラウザ以外は書き出し案内。使用量は右に残る）、狭い幅は［操作］へ補正コピー／貼り付け・お気に入り・アルバムを畳む。
 */

/**
 * 囲みなしの字だけのボタン。行の高さ（32px）は変えず、押せる範囲だけ 44px にする（`BrowserPhotoListSortControl` と同じ）。
 */
export const BROWSER_PHOTO_SELECTION_BAR_BUTTON_CLASS_NAME =
  "relative inline-flex h-8 shrink-0 items-center rounded-full px-2 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40 after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";
const BAR_BUTTON_CLASS_NAME = BROWSER_PHOTO_SELECTION_BAR_BUTTON_CLASS_NAME;
const SELECT_ALL_CLASS_NAME = cn(BAR_BUTTON_CLASS_NAME, "text-niho-accent-ink");
const CANCEL_CLASS_NAME = cn(BAR_BUTTON_CLASS_NAME, "text-niho-text-muted hover:text-niho-text");
const EXPORT_CLASS_NAME = cn(BAR_BUTTON_CLASS_NAME, "text-niho-accent-ink");

/** 全枚がお気に入りなら外し、混在（または全枚が未設定）なら全枚を追加する。 */
export function browserPhotoBatchFavoriteLabel(favorites: readonly boolean[]): string {
  return favorites.length > 0 && favorites.every(Boolean) ? "お気に入りから外す" : "お気に入りに追加";
}

/** 選択バー。［すべて］は、読み込んである写真をすべて選んでいるとき（`allSelected`）は押せない。 */
export function BrowserPhotoEditingSelectionBar(props: {
  count: number;
  /** 狭い幅（1024px 未満）。行いっぱいに左右へ分ける */
  compact: boolean;
  allSelected: boolean;
  favoriteLabel?: string;
  albumLabel?: string;
  actionsDisabled?: boolean;
  selectionDisabled?: boolean;
  onFavorite?: () => void;
  onAlbum?: () => void;
  onSelectAll: () => void;
  onCancel: () => void;
  /** ZIP 保存に対応しない runtime では実行入口を置かず、短い案内だけを表示する。 */
  exportUnavailableMessage?: string;
  /** PC の複数枚書き出し。狭い幅では渡さず、F6c の共有シート経路を変えない。 */
  exportAction?: {
    buttonRef: RefObject<HTMLButtonElement | null>;
    exporting: boolean;
    stopping: boolean;
    finalizing?: boolean;
    /** ほかの操作（一括の補正）の途中で押せない */
    disabled?: boolean;
    onExport: () => void;
    onStop: () => void;
  };
  /**
   * 一括の補正メニュー（F5a-2 移行元設計）。広い幅は［補正］、狭い幅は［操作］として［すべて］の前に置く。
   * 閲覧のみでは渡さない。
   */
  bulkAction?: ReactNode;
}) {
  const countText = photoEditingSelectionCountText(props.count);
  const exporting = props.exportAction?.exporting === true;
  const selectAll = (
    <button
      type="button"
      disabled={props.selectionDisabled || props.allSelected || exporting}
      onClick={props.onSelectAll}
      className={SELECT_ALL_CLASS_NAME}
    >
      {PHOTO_EDITING_SELECT_ALL_LABEL}
    </button>
  );
  const cancel = (
    <button type="button" disabled={props.selectionDisabled || exporting} onClick={props.onCancel} className={CANCEL_CLASS_NAME}>
      {PHOTO_EDITING_SELECT_CANCEL_LABEL}
    </button>
  );
  const favoriteAction = props.favoriteLabel && props.onFavorite ? (
    <button
      type="button"
      aria-label={props.favoriteLabel}
      title={props.favoriteLabel}
      disabled={props.actionsDisabled || exporting}
      onClick={props.onFavorite}
      className={cn(BAR_BUTTON_CLASS_NAME, "text-niho-accent-ink", props.compact && "w-8 justify-center px-0")}
    >
      {props.compact ? <Heart className="h-4 w-4" aria-hidden /> : props.favoriteLabel}
    </button>
  ) : null;
  const albumAction = props.albumLabel && props.onAlbum ? (
    <button
      type="button"
      aria-label={props.albumLabel}
      title={props.albumLabel}
      disabled={props.actionsDisabled || exporting}
      onClick={props.onAlbum}
      className={cn(BAR_BUTTON_CLASS_NAME, "text-niho-accent-ink", props.compact && "w-8 justify-center px-0")}
    >
      {props.compact ? (
        props.albumLabel.includes("外す") ? <FolderMinus className="h-4 w-4" aria-hidden /> : <FolderPlus className="h-4 w-4" aria-hidden />
      ) : props.albumLabel}
    </button>
  ) : null;
  const exportButton = props.exportAction ? (
    <button
      ref={props.exportAction.buttonRef as RefObject<HTMLButtonElement>}
      type="button"
      disabled={props.exportAction.stopping || props.exportAction.finalizing || props.exportAction.disabled}
      onClick={props.exportAction.exporting ? props.exportAction.onStop : props.exportAction.onExport}
      className={EXPORT_CLASS_NAME}
    >
      {props.exportAction.finalizing
        ? "まとめ中…"
        : props.exportAction.stopping
          ? "停止中…"
          : props.exportAction.exporting
            ? "止める"
            : "書き出す"}
    </button>
  ) : null;

  if (props.compact) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        {cancel}
        <p role="status" className="min-w-0 flex-1 truncate text-center text-sub font-bold tabular-nums text-niho-text">
          {countText}
        </p>
        {favoriteAction}
        {albumAction}
        {props.bulkAction}
        {selectAll}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-3">
      <p role="status" className="text-sub font-bold tabular-nums text-niho-text">
        {countText}
      </p>
      {favoriteAction}
      {albumAction}
      {selectAll}
      {props.bulkAction}
      {exportButton}
      {!exportButton && props.exportUnavailableMessage ? (
        <span title={props.exportUnavailableMessage} className="max-w-48 truncate text-xs text-niho-text-muted">
          ZIP はブラウザで保存できます
        </span>
      ) : null}
      {cancel}
    </div>
  );
}

/**
 * スマホの上段（場所の切り替え）の右端、「＋」（写真を追加）の左の「選択」ボタン（アイコンだけ。読み上げと title は「選択」）。
 * 押すと選択モードに入る。「＋」と同じ 44px の丸。一覧の上に残る行（並びの切り替え・使用量・消す）には置かない（320px で
 * 使用量が潰れるため）。
 */
export function BrowserPhotoEditingSelectModeButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={PHOTO_EDITING_SELECT_LABEL}
      title={PHOTO_EDITING_SELECT_LABEL}
      onClick={props.onClick}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-accent-ink transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
    >
      <CircleCheck className="h-5 w-5" aria-hidden />
    </button>
  );
}
