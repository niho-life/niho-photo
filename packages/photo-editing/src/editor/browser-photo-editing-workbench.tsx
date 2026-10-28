"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactElement, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bandage, CircleDashed, Contrast, Crop, FolderOpen, History, Info, Laptop, Plus, Scissors, SlidersHorizontal, Trash2 } from "lucide-react";

import { formatPhotoCloudUsage } from "../photo-library-usage";
import { inertAttribute } from "niho-ui/inert-attribute";
import { BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE } from "../photo-original-files";
import {
  browserCloudListParams,
  browserCloudAlbumPlace,
  browserCloudPlaceAlbumId,
  browserFolderPlace,
  browserPlaceFolderId,
  browserCloudLockedReason,
  canFavoriteBrowserCloudPhoto,
  canFilterBrowserCloudPlace,
  isBrowserCloudPhotoInFilter,
  isBrowserCloudPhotoPlace,
  isBrowserSelectedPhotosPlace,
  isBrowserCloudRawPhoto,
} from "../browser-photo-cloud-source";
import {
  BROWSER_PHOTO_EXPORT_BATCH_LARGE_CHOICE,
  isBrowserPhotoCutoutFullSizeAvailable,
  isBrowserPhotoExportLargeWithinMobileMemory,
  browserPhotoExportJpegRoute,
  resolveBrowserPhotoBatchExportChoices,
  resolveBrowserPhotoExportChoices,
  type BrowserPhotoExportChoices,
  type BrowserPhotoExportJpegRoute,
} from "../browser-photo-export";
import {
  resolveBrowserPhotoBatchExportLimit,
  type BrowserPhotoBatchExportTarget,
} from "../browser-photo-batch-export";
import { hasDevelopGeometry, isNeutralDevelopColors, type DevelopSettings } from "../develop-engine/develop-settings";
import { photoEditingNativeExportBlockers, photoEditingNativeExportUnsupportedText } from "../photo-editing-native-export";
import { readWorkingCopyLensProfile } from "../photo-editing-lens";
import { isDevelopWorkTarget } from "../develop-engine/develop-work-target";
import {
  isWorkPending,
  pendingWorkStatusText,
  summarizePendingWork,
} from "../develop-engine/develop-work-wait";
import {
  setPhotoEditingBreadcrumb,
  type PhotoEditingBreadcrumbItem,
} from "../photo-editing-breadcrumb-store";
import { PHOTO_CLOUD_DELETING_NOTICE } from "../photo-library-messages";
import type { PhotoEditingCutoutHost } from "../photo-cutout";
import {
  BROWSER_PHOTO_EDITING_DEVELOP_RELOADING_TEXT,
  PHOTO_EDITING_CROP_BLOCKED_BY_CUTOUT_TEXT,
  PHOTO_EDITING_FLAG_FAILED_TEXT,
  PHOTO_EDITING_FOLDER_EMPTY_TEXT,
  PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT,
  PHOTO_EDITING_LOCAL_PHOTOS_LOAD_FAILED_TEXT,
  PHOTO_EDITING_LOCAL_PLACE_LABEL,
  PHOTO_EDITING_ADD_FOLDER_LABEL,
  PHOTO_EDITING_ADD_SELECTED_PHOTOS_LABEL,
  PHOTO_EDITING_PRESETS_TITLE,
  PHOTO_EDITING_SELECTED_PHOTOS_LABEL,
  PHOTO_EDITING_TOOL_ADJUST_LABEL,
  PHOTO_EDITING_TOOL_CROP_LABEL,
  PHOTO_EDITING_TOOL_CUTOUT_LABEL,
  PHOTO_EDITING_TOOL_HEAL_LABEL,
  PHOTO_EDITING_TOOL_INFO_LABEL,
  PHOTO_EDITING_TOOL_MASK_LABEL,
  PHOTO_EDITING_TOOL_VERSIONS_LABEL,
} from "../photo-editing-copy";
import { movePhotoEditingPhotoId } from "../photo-editing-selection";
import { photoEditingTileGeometry } from "../photo-editing-tile-geometry";
import { describePhotoCloudAddProgress } from "../photo-cloud-add-queue";
import { photoLibrarySectionDate } from "../photo-library-sections";
import { usePhotoEditingLayerHistory } from "../use-photo-editing-layer-history";
import { usePhotoCloudFavorite } from "../use-photo-cloud-favorite";
import { usePhotoLibraryFlags } from "../use-photo-library-flags";
import { usePhotoCloudAlbums } from "../use-photo-cloud-albums";
import { usePhotoCloudPhotos, type PhotoCloudCounts } from "../use-photo-cloud-photos";
import { usePhotoEditingRollout } from "../use-photo-editing-rollout";
import {
  usePhotoEditingHost,
  usePhotoLibrary,
  usePhotoLibraryCapabilities,
} from "../library/photo-library-context";
import { usePhotoEditingShortcuts, type PhotoEditingShortcut } from "../use-photo-editing-shortcuts";
import type { PhotoLibraryFlag } from "../library/photo-library";
import { PHOTO_SAVE_MAX_FILES } from "../save-photos-to-device";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import { cn } from "niho-ui/cn";

import {
  BrowserPhotoAlbumAddDialog,
  BrowserPhotoAlbumEditorDialog,
  type PhotoAlbumEditorRequest,
} from "./browser-photo-editing-albums";
import { BrowserPhotoEditingAdjustments } from "./browser-photo-editing-adjustments";
import { BrowserPhotoEditingBulkMenu } from "./browser-photo-editing-bulk-menu";
import { BrowserPhotoEditingInfo } from "./browser-photo-editing-info";
import {
  BrowserPhotoCloudShareSheet,
  type BrowserPhotoCloudSharingBinding,
} from "./browser-photo-cloud-share-sheet";
export type { BrowserPhotoCloudSharingBinding } from "./browser-photo-cloud-share-sheet";
import type { BrowserPhotoFavoriteControl } from "./browser-photo-editing-favorite-button";
import { BrowserPhotoListFilterControl } from "./browser-photo-editing-filter";
import type { BrowserPhotoFlagControl } from "./browser-photo-editing-flags";
import { BrowserPhotoEditingFolderTree } from "./browser-photo-editing-folder-tree";
import { BrowserPhotoEditingFooter, BrowserPhotoEditingStatusLine } from "./browser-photo-editing-footer";
import { BrowserPhotoExportSheet } from "./browser-photo-editing-export-sheet";
import {
  BrowserPhotoEditingGrid,
  BrowserPhotoListSortControl,
  type BrowserPhotoEditingGridHandle,
  type BrowserPhotoEditingGridItem,
} from "./browser-photo-editing-grid";
import { BrowserPhotoEditingFilmstrip } from "./browser-photo-editing-filmstrip";
import { BrowserPhotoEditingLoupe } from "./browser-photo-editing-loupe";
import {
  appendDevelopColorPoint,
  commitColorPickIfCurrent,
  PhotoEditingColorMixer,
} from "./photo-editing-color-mixer";
import { BrowserPhotoEditingMobileEditor } from "./browser-photo-editing-mobile-editor";
import { BrowserPhotoMobileExportSheet } from "./browser-photo-editing-mobile-export-sheet";
import {
  ADD_ACCEPT,
  BROWSER_CANVAS_ADJUSTMENT_KEYS,
  FAVORITE_FAILED_TEXT,
  browserAdjustmentKeys,
  browserMobileAdjustmentKeys,
  browserPhotoTileUrl,
  cloudKey,
  detailControlsAvailable,
  isBrowserItemInPlace,
  isWideWindow,
  type BrowserItem,
  type ArrowKeyEvent,
  type BrowserPhotoAccess,
  type BrowserPhotoOperation,
  type BrowserPhotoAdjustPanel,
  type BrowserPhotoOperationKind,
  type BrowserPhotoTool,
  type BrowserViewMode,
  type FooterStatus,
  type PhotoEditingLeaveGuardRegistrar,
} from "./browser-photo-editing-model";
import {
  BrowserPhotoEditingSelectionBar,
  BrowserPhotoEditingSelectModeButton,
  browserPhotoBatchFavoriteLabel,
} from "./browser-photo-editing-selection-bar";
import { BrowserPhotoEditingPresets } from "./browser-photo-editing-presets";
import { BrowserPhotoEditingToolRail, type BrowserPhotoEditingToolRailItem } from "./browser-photo-editing-tool-rail";
import { BrowserPhotoEditingVersions } from "./browser-photo-editing-versions";
import {
  BROWSER_VERSION_THUMBNAIL_MAX_DIMENSION,
  developVersionThumbnailFoundation,
  developVersionThumbnailSettings,
} from "./browser-photo-editing-versions-model";
import {
  BrowserPhotoEditingPlaceTabs,
  BrowserPhotoEditingTree,
  browserPhotoPlaceLabel,
  type BrowserPhotoTreeCounts,
} from "./browser-photo-editing-tree";
import {
  PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME,
  PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";
import { PhotoEditingCropTools } from "./photo-editing-crop-tools";
import { PhotoEditingCutoutTools } from "./photo-editing-cutout-tools";
import { PhotoEditingMaskMobileTools } from "./photo-editing-mask-mobile-tools";
import { BrowserPhotoEditingMaskLayer } from "./photo-editing-mask-overlay";
import { PhotoEditingMaskTools } from "./photo-editing-mask-tools";
import { PhotoEditingDropOverlay } from "./photo-editing-drop-overlay";
import { PhotoEditingHealTools } from "./photo-editing-heal-tools";
import { PhotoEditingAddFolderEmptyState, PhotoEditingAddPhotosEmptyState } from "./photo-editing-empty-states";
import { PhotoEditingGrid, countPhotoEditingGridColumns, type PhotoEditingGridItem } from "./photo-editing-grid";
import { PhotoEditingHistogram } from "./photo-editing-histogram";
import { PhotoEditingColorGrading, PhotoEditingColorGradingSection } from "./photo-editing-color-grading";
import { PhotoEditingHslMixer, PhotoEditingHslMixerSection } from "./photo-editing-hsl-mixer";
import { PhotoEditingLensSection } from "./photo-editing-lens";
import { PhotoEditingMenu, type PhotoEditingMenuItem } from "./photo-editing-menu";
import { PhotoEditingPresetsPanel } from "./photo-editing-presets-panel";
import { PhotoEditingToneCurveSection } from "./photo-editing-tone-curve";
import { useBrowserPhotoAdd } from "./use-browser-photo-add";
import { useBrowserPhotoAuto } from "./use-browser-photo-auto";
import { useBrowserPhotoBulk } from "./use-browser-photo-bulk";
import {
  nextBrowserPhotoCompareMode,
  useBrowserPhotoCompareView,
  type BrowserPhotoCompareMode,
} from "./use-browser-photo-compare-view";
import { useBrowserPhotoCutout } from "./use-browser-photo-cutout";
import { useBrowserPhotoDevelop } from "./use-browser-photo-develop";
import { useBrowserPhotoEditingKeys } from "./use-browser-photo-editing-keys";
import {
  useBrowserPhotoColorPointsSupport,
  useBrowserPhotoDetailSupport,
  useBrowserPhotoEffectsSupport,
  useBrowserPhotoLensSupport,
} from "./use-browser-photo-effects";
import { photoEditingMaskExportBlocked, useBrowserPhotoMasks, useBrowserPhotoMasksSupport } from "./use-browser-photo-masks";
import { useBrowserPhotoExportAndDelete } from "./use-browser-photo-export-delete";
import { useBrowserPhotoExportLargeSize } from "./use-browser-photo-export-large";
import { useBrowserPhotoFlagKeys } from "./use-browser-photo-flag-keys";
import { useBrowserPhotoFolders } from "./use-browser-photo-folders";
import { useBrowserPhotoHealKeys } from "./use-browser-photo-heal";
import { useBrowserPhotoHistogram, type PhotoEditingFrameSink } from "./use-browser-photo-histogram";
import { useBrowserPhotoItems, useBrowserPhotoListView } from "./use-browser-photo-items";
import { useBrowserPhotoLeaveGuards } from "./use-browser-photo-leave-guards";
import { useBrowserPhotoOpen } from "./use-browser-photo-open";
import { useBrowserPhotoSelection } from "./use-browser-photo-selection";
import { useBrowserPhotoPresetSupport } from "./use-browser-photo-preset-support";
import { useBrowserPhotoVersions } from "./use-browser-photo-versions";
import { useBrowserPresetThumbnails } from "./use-browser-preset-thumbnails";

export type BrowserPhotoPrepareForInsertResult =
  | { ok: true }
  | { ok: false; reason: "unresolved-draft" | "draft-check-failed" | "save-failed" };

/** この Mac の選択中の 1 枚を、trusted host が管理する個人クラウドへ明示的にコピーする口。 */
export type BrowserPhotoCopyToCloudBinding = {
  /** React から渡すのは不透明な写真 ID だけ。upload・冪等性・再開は実装側に閉じる。 */
  copyLocalPhoto(
    photoId: string,
    options: { signal: AbortSignal; onProgress: (fraction: number | null) => void },
  ): Promise<{ cloudPhotoId?: string | null }>;
  /** コピー結果にクラウド写真 ID があるときだけ、成功後の明示操作から呼ぶ。 */
  onOpenCloudPhoto(photoId: string): void;
};

/**
 * ブラウザ版の写真編集（移行元設計 → 移行元設計、移行時の設計文書・モック
 * `idea/mock/photo-editing-browser-lightroom-v1.html`）。Lightroom 型の語彙と構造にし、操作は「写真を追加」「書き出す
 * （JPEG / オリジナル）」「補正前」「クラウドから消す」に絞る。
 *
 * - 左の木は「クラウド」（選べない見出し）の下に「写真」（オリジナルのある行）・「お気に入り」（♥ の付いた写真。0 件でも出す）・
 *   「記事の画像」（オリジナルの無い行。0 件なら出さない）。場所と並び（撮影日 / 最近追加。一覧の上の行の左の切り替え・この端末に
 *   覚える）はサーバーで絞り、件数はサーバーの全件。一覧は日本時間の日ごとの見出しで分け、見えている行だけを描く（狭い幅は 3 列の
 *   正方形。F5a-1 移行元設計・F5a-2 移行元設計）
 * - お気に入り（♥。拠点のスタッフで共有）は、選んでいる 1 枚・開いている 1 枚に対する 1 つのボタンで付け外す（PC は下段、スマホの
 *   編集レイヤーは上の帯、編集レイヤーを使わない狭幅の loupe は右上。対象は「写真」だけ）。押した直後に一覧と件数へ反映し、失敗したら
 *   戻して状態欄に 1 行（F5b 移行元設計）
 * - 一覧の絞り込み（種類・補正済み）は、並びの切り替えのすぐ右のアイコンのボタンからパネルで選ぶ（「写真」「お気に入り」だけ。
 *   選んだらすぐサーバーで絞り、端末には覚えない）。条件のある空の一覧は「条件に合う写真はありません」と「絞り込みを解除」。
 *   補正済みで絞った一覧は、直している写真を外さず、1 枚の表示から戻ったときに読み直す（F5b 移行元設計 の画面 2 本目）
 * - 「写真」の見出しの「＋」で選んだファイルはそのままクラウドのオリジナルとプレビューになり、1 枚ずつ上げる（記事用の画像は付けない。
 *   K3 移行元設計）。上げている間も一覧に出し、タイルに追加中の印を重ねる
 * - NIHO Desktop の口（`desktop`。写真編集に対応した Desktop だけ。K2 移行元設計）があれば、「＋」と空状態の主ボタンは Desktop の
 *   面の「＋」と同じメニュー（「この Mac のフォルダ」「この Mac の写真」）になり、選んだ Mac の写真を作業コピーと一緒にクラウドへ
 *   入れる（`useBrowserPhotoAdd`）。ドロップは今までどおりファイルで入れる。原寸の書き出しに対応した Desktop なら、書き出すの
 *   シート（PC）の大きさに「原寸」を足し、Desktop の native の段 2 で描いてこの Mac に保存する（K2-3a）。書き出し先のフォルダの
 *   選択もある Desktop なら、選択バーの［書き出す］（ZIP の代わり）で選んだ写真をフォルダへ原寸で書き出す（K2-3b）
 * - 右パネル（基本補正）と「補正前」は、ブラウザで直せる写真（オリジナルが JPEG・10MiB 以下の PNG）を 1 枚で開いたときだけ。
 *   RAW・HEIC / HEIF・TIFF・大きな PNG と、作業コピーの上で直した・ブラウザで読めないほど大きい JPEG（K5-a 移行元設計）は作業コピー
 *   （移行元設計）を入力に直す（開いた瞬間はクラウドのプレビュー、揃ったら 1 回だけ描いた画に差し替える。まだなら「現像の準備中」、
 *   作れなかったら「再試行」）。ほかは右パネルの代わりに状態と次の一歩を 1 行出し、閲覧・書き出し・削除だけにする
 * - 補正は写真に 1 つで、ブラウザと NIHO Desktop で区別しない（owner 決定 2026-09-29）。新しく保存した方（ブラウザの
 *   `developSettings` か Desktop の Photo Bench の `settings`）から始める。写せない項目がある Photo Bench の補正は捨てて補正なしで
 *   開く（移行元設計）。閉じる理由は「新しい版の NIHO で補正された」と「準備ができなかった」の 2 つだけ（NIHO Desktop へ送らない）
 * - 補正は段 2 の wasm（Web Worker）で描き、`developSettings` として写真に自動保存する（S2 移行元設計。800ms まとめ・直列・成功は
 *   何も出さず、失敗だけ状態欄）。写真を離れる前に保存を送り終え、表示している画を縮めて補正後のプレビューとして上げる（待たない。
 *   記事用の画像は描かない＝使うときに描く。K3 移行元設計）。補正後のプレビューが無い・古い写真は、開いた 1 枚目の画を上げ直す。
 *   wasm を用意できなければ S1 の canvas（保存せず書き出しだけ・破棄の確認あり）に黙って戻る（補正のある写真は閲覧だけ）
 * - 保存には直し始めた版を付け、別の端末が先に保存していたら（409）黙って上書きせず、今の写真の補正で読み直して状態欄に 1 行出す。
 *   画面に戻ったときも、版が進んでいれば読み直す（移行元設計）
 * - 右パネルは NIHO Desktop と共通の群（ライト／カラー／効果）で、wasm で開いた写真は 13 項目、S1 の canvas は 5 項目。1 枚で
 *   見ている間は取り消し・やり直し（↶ ↷・⌘Z / ⇧⌘Z）と「初期化」の元に戻すが効き、\ を押している間だけ補正前を見せる
 *   （NIHO Photo 段 1 F1 移行元設計）。効果のある設定（v: 3）を読める wasm で開いた写真には、カラーの先頭に「白黒」、効果に
 *   「周辺光量補正」「粒子」「粒子のサイズ」も出す（E1b 移行元設計。読めない wasm は描画を断るので、読めると分かるまで出さない）
 *   （NIHO Photo 段 1 F1 移行元設計）
 * - 狭い幅（1024px 未満）は一覧・閲覧・写真を追加・書き出す（一覧の規則）・クラウドから消すだけ。スマホで直せる拠点
 *   （`mobileEditingAllowed`。親が `usePhotoEditingRollout` で読んで渡す。F6c 移行元設計）は、1 枚を全画面の編集の層（`BrowserPhotoEditingMobileEditor`）で開く
 * - 群の上に「プリセット」（wasm で開く写真だけ。「なし」→ NIHO の 3 本 → 拠点のプリセット）。押すと 100% で当て（取り消しの
 *   1 単位）、行にマウスを載せている間は写真に仮に見せる。見出しの「⋯」から今の補正をプリセットに保存・Lightroom のプリセット
 *   （.xmp・.dng）を拠点に取り込め、拠点のプリセットは行の「⋯」で名前を変え・消せる。口のある wasm では行の左に見本、選ばれて
 *   いる間は一覧の下に適用量（F2b 移行元設計。`browser-photo-editing-presets.tsx`）。スマホの層では先頭の道具として同じ状態・履歴を使う
 * - ライトの群の見出しの横に「自動」（F4b 移行元設計。口のある wasm で開いた写真だけ）: 押すとライト 6 本と自然な彩度を当て（取り消しの
 *   1 単位）、押された表示のときにもう一度押すと戻す（`useBrowserPhotoAuto`）
 * - 切り抜きの道具（F3b 移行元設計。受入まで拠点を絞る）: wasm で開いた写真は、右パネルの一番上の「補正 / 切り抜き」（`R`）で道具を
 *   切り替える。「切り抜き」の間は写真の上に枠を重ね（枠はまっすぐ・写真が回る）、右パネルは縦横比・角度補正・90° 回転・左右の
 *   反転。確定のたびに自動保存・取り消しの 1 単位。「初期化」は切り抜きだけを戻し、「補正前」とプリセットは効かない。`Esc` で
 *   「補正」に戻る
 * - 写真の出どころにフォルダ（`library.folders`。この Mac の写真を読む NIHO camera。C3 移行元設計）があれば、左の木は「この Mac」
 *   （選べない見出し。右に「＋」= フォルダを追加）の下に覚えたフォルダの木（`BrowserPhotoEditingFolderTree`・
 *   `useBrowserPhotoFolders`）にし、選んだフォルダを一覧の `folderId` で読む。並び・絞り込みはフォルダでも使う。狭い幅の上段の
 *   切り替えは出さない。置き場が「この Mac」（`library.place` が `local`）なら、クラウドから消す道具と、クラウドの文言を出さない。
 *   写真を足す「＋」・ドロップ、お気に入り、アルバムは、`capabilities` で足せる・使える写真の出どころだけに出す
 * - 一覧で選んだ複数枚への一括の補正（F5a-2 移行元設計。PC のブラウザ版だけ）: 選択バーの「補正」メニュー（補正を貼り付け・プリセット
 *   100%）と、一覧を見ている間の ⌥⇧⌘C / ⌥⇧⌘V。右パネルは出さず、一覧の列数を動かさない。処理中は `operation` が `bulk` で
 *   ほかの操作を止め、終わったら状態欄に 1 行と［元に戻す］（`useBrowserPhotoBulk`）
 * - 選別（niho-photo#47。`capabilities.flags` の写真の出どころだけ）: 一覧でも 1 枚でも P = 採用・X = 却下・U = 外す（PC だけ。
 *   一覧は選んでいる写真すべて）と下段の小さなボタン。絞り込みに「採用だけ」「却下を隠す」。却下した写真は薄く出すだけで消さない。
 *   書き出しの対象は今の一覧で選んだ写真なので、絞り込み中は絞った写真だけ（`usePhotoLibraryFlags`・`useBrowserPhotoFlagKeys`）
 *
 * 面の分け方（移行元設計）: ここは組み立ての根。一覧は `useBrowserPhotoItems`、段 2 の session・自動保存・離れるときは
 * `useBrowserPhotoDevelop`、1 枚を開く流れと補正は `useBrowserPhotoOpen`、追加・書き出しと削除・離れる前の確かめはそれぞれの
 * hook、左の木・1 枚・右パネル・下段は `browser-photo-editing-*.tsx`。型と純粋な関数は `browser-photo-editing-model.ts`。
 */
export function BrowserPhotoEditingWorkbench(props: {
  spotId: string;
  /** 認証済みユーザー。未確定・匿名では未保存補正を端末から読まず、書かない。 */
  actorId?: string | null;
  canEdit: boolean;
  cloudOriginalsAllowed: boolean;
  active: boolean;
  /**
   * スマホ（1024px 未満）で直せる拠点か（F9 移行元設計 のフラグ。親が読んで渡す。省略・読めるまでは false = 今までどおり閲覧だけ）。
   * 面の中では読まない（面のテストが拠点のフラグの読み取りに依らないように）
   */
  mobileEditingAllowed?: boolean;
  openCloudPhotoId: string | null;
  onOpenCloudPhotoHandled: () => void;
  registerRouteLeaveGuard?: PhotoEditingLeaveGuardRegistrar;
  /**
   * 背景除去の口（NIHO camera だけが渡す。C4 移行元設計。省略 = web。右パネルの切り替えに「背景除去」を出さず、今までどおり）。
   * 保存したレシピの読み書き・推論（sidecar の `detect`）・マスクの読み込みに使う。PC の面（1024px 以上）だけ
   */
  cutout?: PhotoEditingCutoutHost;
  /** 記事ダイアログで、描く前に現在の補正を保存し終えるための口。 */
  articlePrepareForInsert?: MutableRefObject<((photoIds: readonly string[]) => Promise<BrowserPhotoPrepareForInsertResult>) | null>;
  /** 記事へ写真を入れる間は、同じ編集面から対象のクラウド写真を消せないようにする。 */
  disableCloudDelete?: boolean;
  /** 公開クラウド共有のtrusted host接続口。省略時は共有操作を表示しない。Cameraはprivate integrationまで渡さない。 */
  cloudSharing?: BrowserPhotoCloudSharingBinding;
  /**
   * 外枠の見た目。`card`（既定）は web の写真編集タブ（角丸の枠・影・画面の高さから引いた固定の高さ）。`fill` は NIHO photo
   * （窓いっぱい。親の flex の高さに合わせ、枠と影を付けない。地は `--photo-editing-surface`。niho-photo#50）
   */
  appearance?: "card" | "fill";
  /** PC の左の木を出さない（NIHO photo の header の「左のパネル」。狭い幅には影響しない） */
  treeHidden?: boolean;
  /** PC の左の木の底に出す 1 行（NIHO photo の「版」） */
  treeFooter?: ReactNode;
  /** 個人クラウドへのコピー口。省略時はコピー操作を一切表示しない。 */
  copyToCloud?: BrowserPhotoCopyToCloudBinding;
}) {
  const queryClient = useQueryClient();
  // 写真の出どころ（接続口 PhotoLibrary。web は拠点のクラウドの写真置き場、NIHO camera はこの Mac のフォルダ。移行元設計）
  const library = usePhotoLibrary();
  // この Mac のフォルダの面（フォルダのある写真の出どころだけ。C3 移行元設計）。一覧はフォルダを選んでから読む
  const folderMode = library.folders !== undefined;
  // 置き場が「この Mac」: クラウドから消す道具を出さない（記事へ写真を入れる間の `disableCloudDelete` と同じ）
  const deleteDisabled = props.disableCloudDelete === true || library.place === "local";
  // 木の場所と並びと絞り込みはサーバーの一覧を絞る条件なので、一覧を読む前に決める
  const listView = useBrowserPhotoListView();
  const albumLibrary = usePhotoCloudAlbums({ spotId: props.spotId });
  const [viewMode, setViewMode] = useState<BrowserViewMode>("grid");
  const cloud = usePhotoCloudPhotos({
    spotId: props.spotId,
    // 補正済み / 未補正で絞った一覧は、1 枚で見ている間は読み直さない（作業コピーの待ちの読み直しも止める。直した写真の補正済みが
    // 変わっても一覧から外さない = 1 枚の表示を閉じない）。一覧へ戻ると、止めていた間に古くなった一覧を読み直す（staleTime 0）。
    // 条件が無ければ今までどおり（戻っても読み直さない）。選別（採用だけ / 却下を隠す。niho-photo#47）で絞った一覧も同じ（1 枚で
    // 却下した写真を、別の写真へ移るまで出したままにする）
    enabled:
      (!folderMode || browserPlaceFolderId(listView.place) !== null || isBrowserSelectedPhotosPlace(listView.place)) &&
      (viewMode !== "loupe" || (listView.filter.edited === null && !listView.filter.flag)),
    sort: listView.sort,
    ...browserCloudListParams(listView.place, listView.filter),
  });
  // 画面が開いているか（非同期の結果を反映する前に確かめる）。閉じるときは、各 hook の片付けより先に落とす
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [bulkPreservedSelectionKeys, setBulkPreservedSelectionKeys] = useState<ReadonlySet<string>>(() => new Set());
  const preserveBulkSelection = useCallback(
    (keys: readonly string[]) => setBulkPreservedSelectionKeys(new Set(keys)),
    [],
  );
  const latestAccessRef = useRef<BrowserPhotoAccess>({
    canEdit: props.canEdit,
    cloudOriginalsAllowed: props.cloudOriginalsAllowed,
    spotId: props.spotId,
  });
  latestAccessRef.current = {
    canEdit: props.canEdit,
    cloudOriginalsAllowed: props.cloudOriginalsAllowed,
    spotId: props.spotId,
  };
  const list = useBrowserPhotoItems(cloud.photos, listView, { preserveSelectedItem: viewMode === "loupe" });
  const { place, selectedKey, setSelectedKey, items, selectedItem } = list;
  // 一覧の複数選択（「写真」「お気に入り」「アルバム」。表示中の 1 枚の上に重ねる。追加中の写真は選べない。F5a-2 移行元設計 / F5b 移行元設計）
  const selectableKeys = useMemo(() => items.filter((item) => !item.adding).map((item) => item.key), [items]);
  const selection = useBrowserPhotoSelection({
    enabled: isBrowserCloudPhotoPlace(place),
    orderedKeys: selectableKeys,
    activeKey: selectedKey,
    setActiveKey: setSelectedKey,
    preservedKeys: bulkPreservedSelectionKeys,
  });
  const [albumEditorRequest, setAlbumEditorRequest] = useState<PhotoAlbumEditorRequest | null>(null);
  const [albumAddOpen, setAlbumAddOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const selectedItems = useMemo(() => {
    const itemsByKey = new Map(items.map((item) => [item.key, item]));
    return Array.from(selection.selectedKeys, (key) => itemsByKey.get(key)).filter(
      (item): item is BrowserItem => item !== undefined && !item.adding,
    );
  }, [items, selection.selectedKeys]);
  const batchExportTargets = useMemo<BrowserPhotoBatchExportTarget[]>(
    () =>
      selectedItems.map((item) => ({
        photoId: item.photo.id,
        fileName: item.photo.fileName,
        sizeBytes: item.photo.sizeBytes,
      })),
    [selectedItems],
  );
  const selectedBatchPhotos = useMemo(
    () => selectedItems.filter((item) => item.photo.hasOriginal).map((item) => item.photo),
    [selectedItems],
  );
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [operation, setOperation] = useState<BrowserPhotoOperation | null>(null);
  const operationRef = useRef<BrowserPhotoOperationKind | null>(null);
  const copyRunRef = useRef<{ controller: AbortController } | null>(null);
  const saveGenerationRef = useRef(0);
  const [status, setStatus] = useState<FooterStatus | null>(null);
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  /** スマホの編集面の書き出すのシートを開いている（「大きく」の長辺を読む間。niho-photo#134） */
  const [mobileExportSheetOpen, setMobileExportSheetOpen] = useState(false);
  const [cloudShareSheetOpen, setCloudShareSheetOpen] = useState(false);
  const batchExportFocusPendingRef = useRef(false);
  const [wide, setWide] = useState(isWideWindow);
  // アプリの都合
  const host = usePhotoEditingHost();
  // 写真の出どころのできること（NIHO Desktop の中のクラウドは「この Mac から追加」・原寸の書き出し・書き出し先のフォルダ。K2 移行元設計）
  const capabilities = usePhotoLibraryCapabilities();
  // 受入まで拠点を絞る機能（F9 移行元設計。読めるまで・読めなければ出さない）
  const rollout = usePhotoEditingRollout(library);
  // スマホ（1024px 未満）で直せる拠点か（F6c 移行元設計）。読めるまで・読めなかったときは今までどおり（閲覧だけ）
  const mobileEditingAllowed = props.mobileEditingAllowed === true;
  const editingAllowed = wide || mobileEditingAllowed;
  const mobileEditing = !wide && mobileEditingAllowed;
  // 1 枚を全画面の編集の層で出す（設定サブタブで面を隠している間は、層も出さない。層は document.body に出るので一緒には隠れない）
  const mobileLayer = mobileEditing && props.active;
  const rootRef = useRef<HTMLElement | null>(null);
  const mobileLayerRef = useRef<HTMLElement | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const batchExportButtonRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** wasm の画を描いた直後に重ねる係（背景除去の口があるときだけ入る） */
  const framePostProcessRef = useRef<((canvas: HTMLCanvasElement) => void) | null>(null);
  /** 描いた画を右パネルのヒストグラムへ渡す口（`useBrowserPhotoHistogram` が入れる。niho-photo#36） */
  const frameSinkRef = useRef<PhotoEditingFrameSink | null>(null);
  /** 補正前と補正後を見比べる間の、補正前を描く canvas（1 枚の表示が置く。niho-photo#41） */
  const [compareBeforeCanvas, setCompareBeforeCanvas] = useState<HTMLCanvasElement | null>(null);
  const gridRef = useRef<BrowserPhotoEditingGridHandle | null>(null);

  useEffect(() => {
    const onResize = () => setWide(isWideWindow());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const develop = useBrowserPhotoDevelop({
    spotId: props.spotId,
    actorId: props.actorId ?? null,
    queryClient,
    mountedRef,
    latestAccessRef,
    setStatus,
    replaceCloudPhoto: cloud.replacePhoto,
    markEditedPreviewPending: cloud.markEditedPreviewPending,
  });
  // フォルダを読めた後の idle に段2 engineを1個だけ起こす。RAWのdecode・全件先読みはしない。
  useEffect(() => {
    if (!editingAllowed || items.length === 0 || !items.some((item) => isDevelopWorkTarget(item.photo))) return;
    const timer = window.setTimeout(() => {
      void develop.readyDevelopEngine().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [develop.readyDevelopEngine, editingAllowed, items]);
  if (props.articlePrepareForInsert) {
    props.articlePrepareForInsert.current = async (photoIds) => {
      const checkDrafts = () => {
        const result = develop.draftRecovery.checkPhotoDrafts(photoIds);
        if (!result.ok) return { ok: false as const, reason: "draft-check-failed" as const };
        if (result.unresolved) {
          setStatus({
            kind: "error",
            text: "記事に入れる写真に未保存の補正があります。対象写真を開き、復元または破棄してください。",
          });
          return { ok: false as const, reason: "unresolved-draft" as const };
        }
        return { ok: true as const };
      };

      const beforeSave = checkDrafts();
      if (!beforeSave.ok) return beforeSave;
      if (!(await develop.leaveEditing({ release: false }))) return { ok: false, reason: "save-failed" };
      // The server save can yield while another tab writes a draft for a selected photo.
      return checkDrafts();
    };
  }
  useEffect(() => () => {
    if (props.articlePrepareForInsert) props.articlePrepareForInsert.current = null;
  }, [props.articlePrepareForInsert]);
  const open = useBrowserPhotoOpen({
    spotId: props.spotId,
    canEdit: props.canEdit,
    openCloudPhotoId: props.openCloudPhotoId,
    onOpenCloudPhotoHandled: props.onOpenCloudPhotoHandled,
    mountedRef,
    latestAccessRef,
    develop,
    items: list,
    refetchCloudPhotos: cloud.refetch,
    replaceCloudPhoto: cloud.replacePhoto,
    viewMode,
    setViewMode,
    cropRollout: rollout.crop,
    // 修復（niho-photo#44）は PC の面だけ（スマホの全画面の編集の層には出さない）
    healAllowed: wide && !mobileLayer,
    editingAllowed,
    canvasSurface: mobileLayer ? "layer" : "page",
    setExportSheetOpen,
    canvasRef,
    operationRef,
    busy: operation !== null,
    saveGenerationRef,
    setStatus,
    framePostProcessRef,
    onFramePaintedRef: frameSinkRef,
    compareCanvas: compareBeforeCanvas,
  });
  const {
    opened,
    opening,
    sourceError,
    settings,
    compareOriginal,
    openItem,
    showGrid,
    returnToGrid,
    selectPlace,
    staleReloading,
    cropSettling,
    presets,
    crop,
    heal,
  } = open;
  // 選択の前後1枚だけをidle prefetchする。cacheはcontent hash別で、canonical producerとは共有しない。
  useEffect(() => {
    if (!library.prefetchInteractivePreview || !selectedItem) return;
    const index = items.findIndex((item) => item.key === selectedItem.key);
    if (index < 0) return;
    const neighbors = [items[index - 1], items[index + 1]].filter(
      (item): item is BrowserItem => Boolean(item && !item.adding && isDevelopWorkTarget(item.photo)),
    );
    if (neighbors.length === 0) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      for (const item of neighbors) {
        void library.prefetchInteractivePreview?.(item.photo.id, {
          signal: abort.signal,
          maxDimension: 1600,
        }).catch(() => undefined);
      }
    }, 500);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [items, library, selectedItem]);
  const currentAlbumId = browserCloudPlaceAlbumId(place);
  // この Mac のフォルダの木と、選んでいるフォルダ（フォルダのある写真の出どころだけ。C3 移行元設計）
  const folders = useBrowserPhotoFolders({ library, spotId: props.spotId, place, selectPlace, setStatus, mountedRef });

  const deleteAlbum = async (albumId: string) => {
    if (albumId === currentAlbumId && !(await selectPlace("photos"))) throw new Error("could not leave album");
    await albumLibrary.deleteAlbum(albumId);
  };
  // wasm で開いて 1 枚で見ている写真（効果・プリセットの口を確かめる・見本を描く）
  const wasmPhotoKey = viewMode === "loupe" && opened?.mode === "wasm" ? opened.key : null;
  // 効果（白黒・周辺光量補正・粒子）を描ける wasm か（wasm で開いた写真を 1 枚で見ているときに 1 回確かめる）
  const effectsSupported = useBrowserPhotoEffectsSupport({
    mountedRef,
    engineRef: develop.engineRef,
    photoKey: wasmPhotoKey,
  });
  const colorPointsSupported = useBrowserPhotoColorPointsSupport({
    mountedRef,
    engineRef: develop.engineRef,
    photoKey: wasmPhotoKey,
  });
  // ディテール（シャープ・ノイズ軽減。v: 6。Issue #32）を描ける wasm か（同じく 1 回確かめる）。RAW を含む wasm の写真に出す
  const detailWasmSupported = useBrowserPhotoDetailSupport({
    mountedRef,
    engineRef: develop.engineRef,
    photoKey: wasmPhotoKey,
  });
  const detailSupported = detailWasmSupported && detailControlsAvailable(opened?.input);
  // 部分補正（マスク。M3 #67）を描ける wasm か（`capabilities()`。同じく 1 回確かめて覚える）
  const masksSupport = useBrowserPhotoMasksSupport({ mountedRef, engineRef: develop.engineRef, photoKey: wasmPhotoKey });
  const lensSupported = useBrowserPhotoLensSupport({ mountedRef, engineRef: develop.engineRef, photoKey: wasmPhotoKey });
  const lensProfile = readWorkingCopyLensProfile(opened?.input?.kind === "workingCopy" ? opened.input.metaJson : null);
  // プリセットの適用量・今の補正の保存・見本を出せる wasm か（同じく 1 回確かめて覚える。右パネルを閉じても行の形を変えない）
  const presetSupport = useBrowserPhotoPresetSupport({ mountedRef, engineRef: develop.engineRef, photoKey: wasmPhotoKey });
  const mobilePresetThumbnails = useBrowserPresetThumbnails({
    mountedRef,
    engineRef: develop.engineRef,
    supported: mobileEditing && presetSupport.thumbnails,
    photoKey: mobileEditing ? wasmPhotoKey : null,
    base: presets.selectedBase ?? settings,
    paused: opened?.input?.kind === "provisional" || open.dragging || presets.amountActive || presets.applyingPresetKey !== null,
    resolvePreset: presets.resolvePreset,
  });
  const add = useBrowserPhotoAdd({
    spotId: props.spotId,
    canEdit: props.canEdit,
    cloudOriginalsAllowed: props.cloudOriginalsAllowed,
    active: props.active,
    queryClient,
    mountedRef,
    latestAccessRef,
    items: list,
    replaceCloudPhoto: cloud.replacePhoto,
    usage: cloud.usage,
    viewModeRef,
    operation,
    operationRef,
    selectPlace,
    setStatus,
    capabilities,
  });
  const { adding, canAdd } = add;
  const {
    runExport,
    runMobileBatchExport,
    runBatchExport,
    runBatchFolderExport,
    stopBatchExport,
    batchStopping,
    batchFinalizing,
    deleteSelectedCloudPhoto,
    pendingShare,
    sharePending,
    clearPendingShare,
  } = useBrowserPhotoExportAndDelete({
    spotId: props.spotId,
    canEdit: props.canEdit && !deleteDisabled,
    mountedRef,
    latestAccessRef,
    selectedItem,
    selectedItems,
    pendingEdits: presets,
    operationRef,
    setOperation,
    saveGenerationRef,
    viewModeRef,
    setViewMode,
    setExportSheetOpen,
    setStatus,
    removeCloudPhotos: cloud.removePhotos,
    develop,
    open,
    items: list,
    capabilities,
  });
  // お気に入り（♥。F5b 移行元設計）。一覧の外の写真（URL で開いた・このタブで追加した）も同じく書き換え、失敗は状態欄に 1 行
  const { patchLocalPhoto } = list;
  const favorites = usePhotoCloudFavorite({
    spotId: props.spotId,
    applyLocal: (photoId, favorite) => patchLocalPhoto(photoId, { favorite }),
    onError: () => setStatus({ kind: "error", text: FAVORITE_FAILED_TEXT }),
  });
  // 選別のフラグ（採用 / 却下。niho-photo#47）。♥ と同じく押した直後に書き換え、送れなかったら戻して状態欄に 1 行
  const flags = usePhotoLibraryFlags({
    spotId: props.spotId,
    applyLocal: (photoId, flag) => patchLocalPhoto(photoId, { flag }),
    onError: () => setStatus({ kind: "error", text: PHOTO_EDITING_FLAG_FAILED_TEXT }),
  });
  // 一覧で選んだ写真への一括の補正（F5a-2 移行元設計。PC は「補正」メニューとキー、狭い幅は選択バーの「操作」。状態と実行は hook）
  const browserBulkRuntime =
    !host.isDesktopApp() && !host.isNativeViewport();
  const bulk = useBrowserPhotoBulk({
    spotId: props.spotId,
    canEdit: props.canEdit,
    wide,
    browserRuntime: browserBulkRuntime,
    active: props.active,
    viewMode,
    keysEnabled: props.active && viewMode === "grid" && isBrowserCloudPhotoPlace(place) && !exportSheetOpen,
    listKey: listView.listKey,
    rootRef,
    mountedRef,
    latestAccessRef,
    selectedItems,
    selectedKeys: Array.from(selection.selectedKeys),
    setPreservedSelectionKeys: preserveBulkSelection,
    operation,
    operationRef,
    setOperation,
    saveGenerationRef,
    setStatus,
    blocked: batchBusy || staleReloading || develop.draftRecovery.selectedDraft !== null,
    replaceCloudPhoto: cloud.replacePhoto,
    markEditedPreviewPending: cloud.markEditedPreviewPending,
    develop,
    open,
  });

  // 一覧に作業コピーの準備中の写真がある間は、読み直し中にも待ち時間を再評価して状態欄を更新する（W1 移行元設計）。
  const pendingWorkText = useMemo(
    () => {
      const pending = summarizePendingWork(cloud.photos, Date.now());
      // 構造共有された一覧でも、再取得中は現在時刻で待ち時間を更新するため依存を意図的に保つ。
      if (cloud.isFetching) return pendingWorkStatusText(pending);
      return pendingWorkStatusText(pending);
    },
    [cloud.isFetching, cloud.photos],
  );

  // このタブで足した写真のうち一覧にまだ載っていないもの（上げている途中を含む。URL で開いた写真は除く）は「今日」に出す
  const listSort = list.sort;
  const listedPhotoIds = useMemo(() => new Set(cloud.photos.map((photo) => photo.id)), [cloud.photos]);
  const deepLinkedPhotoId = list.deepLinkedPhoto?.id ?? null;
  const baseGridItems = useMemo<BrowserPhotoEditingGridItem[]>(
    () =>
      items.map((item) => {
        const url = browserPhotoTileUrl(item);
        const raw = isBrowserCloudRawPhoto(item.photo);
        const local = item.adding || (!listedPhotoIds.has(item.photo.id) && item.photo.id !== deepLinkedPhotoId);
        return {
          key: item.key,
          fileName: item.photo.fileName,
          thumbnail: { url, failed: url === null },
          raw,
          // 補正前のプレビューに、保存済みの切り抜き・回転を CSS で当てて見せる（移行元設計。補正後のプレビューは K3 移行元設計）
          geometry: photoEditingTileGeometry(item.photo),
          adding: item.adding ? { fraction: null } : undefined,
          favorite: item.photo.favorite === true,
          flag: item.photo.flag ?? null,
          pending: isWorkPending(item.photo) ? (raw ? "raw" : "other") : null,
          sectionDate: local ? null : photoLibrarySectionDate(item.photo, listSort),
        };
      }),
    [deepLinkedPhotoId, items, listSort, listedPhotoIds],
  );
  // 送った割合は上げている 1 枚にだけ当てる（進み具合のたびに一覧の全部を作り直さない）
  const addingKey = adding?.photoId ? cloudKey(adding.photoId) : null;
  const addingFraction = adding?.fraction ?? null;
  const gridItems = useMemo(
    () =>
      addingKey === null
        ? baseGridItems
        : baseGridItems.map((item) => (item.key === addingKey && item.adding ? { ...item, adding: { fraction: addingFraction } } : item)),
    [addingFraction, addingKey, baseGridItems],
  );

  // 木の件数はサーバーの全件（最初のページの値）。別の場所・並びを読んでいる間は前の値のまま出し（切り替えるたびに件数を
  // 消さない）、上げている途中の写真（まだ置き終えていないので counts に入っていない）を「写真」に足す。上げ終えた写真は、
  // 一覧を読み直すと counts に入る。一度も読めていなければ出さない
  const lastCountsRef = useRef<{ spotId: string; counts: PhotoCloudCounts } | null>(null);
  if (cloud.counts) lastCountsRef.current = { spotId: props.spotId, counts: cloud.counts };
  const serverCounts =
    cloud.counts ?? (lastCountsRef.current?.spotId === props.spotId ? lastCountsRef.current.counts : null);
  const { allItems } = list;
  const treeCounts = useMemo<BrowserPhotoTreeCounts>(() => {
    if (!serverCounts) return null;
    let addingPhotos = 0;
    for (const item of allItems) if (item.adding) addingPhotos += 1;
    return {
      photos: serverCounts.photos + addingPhotos,
      favorites: serverCounts.favorites,
      articleImages: serverCounts.articleImages,
    };
  }, [allItems, serverCounts]);

  const closeExportSheet = useCallback(() => setExportSheetOpen(false), []);
  const closeBatchExportSheet = useCallback(() => {
    if (operationRef.current === "export") return;
    setExportSheetOpen(false);
    clearPendingShare();
    batchExportFocusPendingRef.current = true;
  }, [clearPendingShare]);

  // 1 枚で表示中の写真。直せない写真は右パネルを出さず、状態と次の一歩を 1 行出す（開く前から分かる理由は開く前から）
  const loupeItem = viewMode === "loupe" ? selectedItem : null;
  const loupeOpened = loupeItem && opened?.key === loupeItem.key ? opened : null;
  // 作業コピーで直す写真（RAW など。移行元設計）は、段 2 の wasm を使えないと分かるまで理由を出さない
  const loupeLockedReason = loupeItem
    ? loupeOpened
      ? loupeOpened.lockedReason
      : isDevelopWorkTarget(loupeItem.photo) && !develop.developUnavailable
        ? null
        : browserCloudLockedReason(loupeItem.photo)
    : null;
  // 作業コピーを待っている間の状態（右パネルに 1 行）
  const loupeWork = loupeOpened?.work ?? null;
  // 1 枚で見せる写真（読み込み中はスピナー。作業コピーを待つ写真は、開いた瞬間からクラウドのプレビューを見せる）
  const openedVisible = opened !== null && (!opening || opened.work !== null);
  const showAdjustments = loupeItem !== null && loupeLockedReason === null;
  // 1 枚で補正の入力を開けている（wasm か S1 の canvas）。閲覧のみの operator も wasm なら保存済みの補正で描く
  const loupeEditing = loupeOpened !== null && (loupeOpened.mode === "wasm" || Boolean(loupeOpened.decoded));
  const editable = props.canEdit && loupeEditing;
  const draftRecoveryPending = develop.draftRecovery.selectedDraft !== null;
  const controlsDisabled =
    !editable || operation !== null || develop.leaving || staleReloading || cropSettling || draftRecoveryPending;
  // 切り抜きの道具（F3b 移行元設計）を開いている（1 枚で見ている wasm の写真）
  const cropping = crop.active && loupeOpened !== null && crop.source !== null;
  // 背景除去（NIHO camera が口を渡したときだけ。C4 移行元設計）。PC の面で wasm の写真を 1 枚で見ている間だけ使え、面が描いた画に
  // 重ねる（口が無ければ重ねる係は空のまま = web は今までどおり）
  const cutout = useBrowserPhotoCutout({
    mountedRef,
    // host を渡すのは camera だけだが、同梱 sidecar の probe が通った `capabilities.cutout` を最後のゲートにする。
    // web / Desktop は false（または host なし）のままなので、背景除去の道具を出さない。
    host: capabilities.cutout ? props.cutout : undefined,
    wide,
    photoKey: wasmPhotoKey,
    settings,
    disabled: controlsDisabled,
    setStatus,
    repaint: open.repaintLastFrame,
  });
  framePostProcessRef.current = cutout.available ? cutout.applyToCanvas : null;
  // beforeunload は未保存操作（送り終えていない背景除去の保存を含む）だけを止める。route guard は保存済みの wasm セッションでも
  // 離脱処理を通し、背景除去の保存も送り終えてから離れる。
  const unloadGuarded =
    operation !== null || adding !== null || add.macBusy || open.dirty || develop.saveState !== "idle" || cutout.saving;
  const guarded = unloadGuarded || opened?.mode === "wasm";
  const confirmRouteLeave = useBrowserPhotoLeaveGuards({
    unloadGuarded,
    guarded,
    dirty: open.dirty,
    operationRef,
    saveGenerationRef,
    addQueue: add.addRunning,
    developSessionRef: develop.developSessionRef,
    leaveEditing: develop.leaveEditing,
    flushPendingSaves: cutout.flush,
    registerRouteLeaveGuard: props.registerRouteLeaveGuard,
    active: props.active,
    openCloudPhotoId: props.openCloudPhotoId,
  });
  useEffect(() => () => copyRunRef.current?.controller.abort(), []);
  const cutoutActive = cutout.active && loupeOpened !== null;
  // 背景除去と切り抜き・回転は同時に使わない: 背景除去のある写真（幾何が恒等で重ねている）は切り抜きに入らず、「切り抜き」の
  // 場所に理由だけを出す（`cropBlockedKey`。写真を替えたら・ほかの道具を選んだら消す）
  const cutoutBlocksCrop = cutout.available && cutout.recipe !== null && !cutout.blockedByGeometry;
  const [cropBlockedKey, setCropBlockedKey] = useState<string | null>(null);
  const cropBlocked = cutoutBlocksCrop && !cropping && cropBlockedKey !== null && cropBlockedKey === wasmPhotoKey;
  useEffect(() => {
    setCropBlockedKey(null);
  }, [wasmPhotoKey]);
  // 保存したレシピを読み終えたのが切り抜きに入った後だったら、切り抜きを出て理由を出す
  useEffect(() => {
    if (!cropping || !cutoutBlocksCrop) return;
    crop.leave();
    setCropBlockedKey(wasmPhotoKey);
  }, [crop, cropping, cutoutBlocksCrop, wasmPhotoKey]);
  // 修復の道具（niho-photo#44）を開いている（1 枚で見ている wasm の写真）
  const healing = heal.active && loupeOpened !== null;
  // マスクの道具（部分補正。M3 #67。PC の面とスマホの全画面の編集の層〔niho-photo#93〕で、切り抜き・背景除去・修復とは同時に
  // 使わない）
  const maskTool = useBrowserPhotoMasks({
    mountedRef,
    engineRef: develop.engineRef,
    developSessionRef: develop.developSessionRef,
    wide: editingAllowed,
    photoKey: wasmPhotoKey,
    support: masksSupport,
    exportBlocked: photoEditingMaskExportBlocked(capabilities),
    otherToolActive: cropping || cutoutActive || healing,
    disabled: controlsDisabled,
    settings,
    settingsRef: open.settingsRef,
    changeSettings: open.changeSettings,
    commitEdit: open.commitEdit,
    // ブラシ（M4 #68）は面を保存できる写真の出どころだけ。面を読めなかったマスクは描画の失敗から知らせる
    saveMaskSurface:
      capabilities.maskSurfaces === true && library.saveMaskSurface
        ? (photoId: string, png: Uint8Array) => library.saveMaskSurface!(photoId, png)
        : null,
    surfaceIssue: open.maskSurfaceIssue,
    onRetrySurfaces: open.retryMaskSurfaces,
  });

  /** 右パネルの今の道具（理由だけを出している「切り抜き」も「切り抜き」） */
  const toolValue: BrowserPhotoTool = cropping
    ? "crop"
    : cutoutActive
      ? "cutout"
      : healing
        ? "heal"
        : cropBlocked
          ? "crop"
          : maskTool.active
            ? "mask"
            : "adjust";
  /** 道具が「補正」の間に右パネルに出す面（右端の帯の「プリセット」「補正」。写真を替えても保つ。niho-photo#51） */
  const [adjustPanel, setAdjustPanel] = useState<BrowserPhotoAdjustPanel>("adjust");
  /** この写真で使える道具（右端の帯に並べる） */
  const tools: BrowserPhotoTool[] = ["adjust"];
  if (crop.available) tools.push("crop");
  if (heal.available) tools.push("heal");
  if (cutout.available) tools.push("cutout");
  if (maskTool.available) tools.push("mask");
  /** 道具を選ぶ（切り替え・R・Esc）。背景除去の推論の途中は替えない */
  const chooseTool = (next: BrowserPhotoTool) => {
    if (cutout.running) return;
    open.clearResetDone();
    if (next === "mask") {
      cutout.leave();
      heal.leave();
      crop.leave();
      setCropBlockedKey(null);
      maskTool.enter();
      return;
    }
    maskTool.leave();
    if (next === "cutout") {
      crop.leave();
      heal.leave();
      setCropBlockedKey(null);
      open.setCompareOriginal(false);
      cutout.enter();
      return;
    }
    cutout.leave();
    // 修復（niho-photo#44）: 切り抜き・背景除去を閉じてから入る（同時には使わない）
    if (next === "heal") {
      crop.leave();
      setCropBlockedKey(null);
      heal.enter();
      return;
    }
    heal.leave();
    if (next === "crop" && cutoutBlocksCrop) {
      setCropBlockedKey(wasmPhotoKey);
      return;
    }
    setCropBlockedKey(null);
    if (next === "crop") crop.enter();
    else crop.leave();
  };
  // 「初期化」は色だけを戻す（切り抜き・回転は戻さない）ので、色の補正があるときだけ押せる。切り抜きの間は切り抜きだけを戻すので、
  // 幾何が恒等でないときだけ押せる。背景除去の間・理由だけの「切り抜き」の間は出さない
  const canReset =
    editable &&
    !cutoutActive &&
    !healing &&
    !cropBlocked &&
    (cropping ? hasDevelopGeometry(settings) : maskTool.active ? maskTool.canReset : !isNeutralDevelopColors(settings));
  // 「自動」（F4b 移行元設計）: wasm で開いた写真を 1 枚で見ている間だけ。押せない間・切り抜き / 背景除去の道具の間は押せない
  const auto = useBrowserPhotoAuto({
    mountedRef,
    engineRef: develop.engineRef,
    photoKey: wasmPhotoKey,
    disabled: controlsDisabled || crop.active || cutout.active || healing || maskTool.active,
    settingsKey: open.settingsKey,
    settingsRef: open.settingsRef,
    commitEdit: open.commitEdit,
    setStatus,
    editResetHandlerRef: open.autoResetRef,
  });
  // wasm で開いた写真は 13 項目を全部、S1 の canvas（段 2 を使えない）は 5 項目だけ見せる（開いている途中は、wasm を使えないと
  // 分かっていれば 5 項目）。効果を描ける wasm と分かっていれば、効果の項目も足す（開いている途中も。行を出し入れしない）
  const canvasOnly = loupeOpened ? loupeOpened.mode === "canvas" : develop.developUnavailable;
  const visibleAdjustmentKeys = canvasOnly
    ? BROWSER_CANVAS_ADJUSTMENT_KEYS
    : browserAdjustmentKeys({ effects: effectsSupported, detail: detailSupported });
  // ヒストグラム（niho-photo#36）: PC の右パネルで、段 2 の wasm が画を描いている写真だけ（S1 の canvas・スマホの層・閲覧の
  // 面では出さず、数えない）。描いた画（補正前・プリセットの仮の表示を含む）の分布なので、補正前を押している間は補正前の分布になる。
  // 切り抜き / 背景除去の道具の間も分布は出すが、写真の上へ重ねる印は使えない（その道具の見た目に従う）
  const histogramAvailable = wide && showAdjustments && wasmPhotoKey !== null && !canvasOnly;
  const histogram = useBrowserPhotoHistogram({
    sinkRef: frameSinkRef,
    photoKey: opened?.key ?? null,
    enabled: histogramAvailable,
  });
  const clipUnavailable = cropping || cutoutActive || healing || cropBlocked;
  const clipMask = histogram.histogram?.clipMask ?? null;
  const clipOverlay =
    histogramAvailable && !clipUnavailable && clipMask && (histogram.clip.shadows || histogram.clip.highlights)
      ? { mask: clipMask, shadows: histogram.clip.shadows, highlights: histogram.clip.highlights }
      : null;
  const { readyDevelopEngine } = develop;
  // 色ミキサーは v4 を描ける wasm の共通 workbench だけ。旧 canvas 面には
  // 動かない操作を出さない。写真・compare・crop・pending が変わると pick を破棄する。
  const [colorPicking, setColorPicking] = useState(false);
  const [colorPickError, setColorPickError] = useState<string | null>(null);
  const [colorPickPosition, setColorPickPosition] = useState({ x: 0.5, y: 0.5 });
  const colorPickGenerationRef = useRef(0);
  useEffect(() => {
    colorPickGenerationRef.current += 1;
    setColorPicking(false);
    setColorPickError(null);
  }, [wasmPhotoKey]);
  useEffect(() => {
    if (compareOriginal || cropping || cutoutActive || healing || maskTool.active || opened?.previewPending || presets.previewName !== null) {
      colorPickGenerationRef.current += 1;
      setColorPicking(false);
    }
  }, [compareOriginal, cropping, cutoutActive, healing, maskTool.active, opened?.previewPending, presets.previewName]);
  const colorMixerAvailable = wasmPhotoKey !== null && !canvasOnly && colorPointsSupported;
  const colorMixerDisabled = controlsDisabled || cropping || cutoutActive || healing || maskTool.active || compareOriginal || opened?.previewPending === true || presets.previewName !== null;
  const latestColorPickContextRef = useRef({
    photoKey: "",
    settingsJson: "",
    blocked: true,
  });
  latestColorPickContextRef.current = {
    photoKey: opened?.mode === "wasm" ? opened.key : "",
    settingsJson: JSON.stringify(open.settingsRef.current),
    blocked: colorMixerDisabled,
  };
  const pickColor = async (position: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!colorPicking || colorMixerDisabled || !canvas || wasmPhotoKey === null || opened?.key !== wasmPhotoKey || opened?.mode !== "wasm") {
      setColorPicking(false);
      setColorPickError("今の写真の表示が整ってから、もう一度お試しください。");
      return;
    }
    const generation = ++colorPickGenerationRef.current;
    const photoKey = wasmPhotoKey;
    const settingsAtPick = open.settingsRef.current as DevelopSettings;
    const settingsJson = JSON.stringify(settingsAtPick);
    try {
      const engine = await readyDevelopEngine();
      if (!engine) throw new Error("ポイントカラーを準備できませんでした。");
      const committed = await commitColorPickIfCurrent({
        sample: engine.sampleColor(settingsAtPick, {
          maxDimension: Math.max(canvas.width, canvas.height),
          x: position.x,
          y: position.y,
        }),
        snapshot: { generation, photoKey, settingsJson },
        current: () => ({
          generation: colorPickGenerationRef.current,
          ...latestColorPickContextRef.current,
        }),
        commit: (target) => open.changeSettings(
          (current) => appendDevelopColorPoint(current as DevelopSettings, target),
          "commit",
        ),
      });
      if (!committed) return;
      setColorPickError(null);
    } catch (error) {
      if (generation !== colorPickGenerationRef.current) return;
      const message = error instanceof Error ? error.message : "";
      setColorPickError(
        message.includes("outside the color point target contract")
          ? "この位置の色はポイントカラーで扱えません。別の色の部分を選んでください。"
          : "写真の色を取得できませんでした。表示が整ってから、もう一度お試しください。",
      );
    } finally {
      if (generation === colorPickGenerationRef.current) setColorPicking(false);
    }
  };
  const colorMixer = colorMixerAvailable ? (
    <PhotoEditingColorMixer
      settings={settings as DevelopSettings}
      disabled={colorMixerDisabled}
      picking={colorPicking}
      pickError={colorPickError}
      onPickStart={() => {
        open.setCompareOriginal(false);
        setColorPickError(null);
        setColorPickPosition({ x: 0.5, y: 0.5 });
        setColorPicking(true);
      }}
      onPickCancel={() => {
        colorPickGenerationRef.current += 1;
        setColorPicking(false);
      }}
      onSettingsChange={open.changeSettings}
    />
  ) : undefined;
  // 同梱のプリセットは段 2 の wasm（crate）の 3 本（右パネルに出すときには、写真を開く流れが wasm を起こしている）
  const builtinPresets = useMemo(
    () => ({
      queryKey: photoEditingQueryKeys.developBuiltinPresets(),
      load: async () => {
        const engine = await readyDevelopEngine();
        if (!engine) throw new Error("develop engine is not available");
        return engine.builtinPresets();
      },
    }),
    [readyDevelopEngine],
  );
  // 右パネルのプリセット（帯の「プリセット」と補正の面のプリセットの行）を出せる写真。S1 の canvas（段 2 を使えない）には出さない。
  // 狭い幅は右パネルを見せない（wasm も起こさない）ので、プリセットも読まない
  const presetsAvailable = !canvasOnly && wide;
  // 版（niho-photo#42）: プリセットと同じく PC の右パネルで段 2 の wasm を使える写真を 1 枚で見ている間だけ、置き場が版を残せる
  // （`capabilities.versions`）ときだけ出す
  const versionsAvailable =
    presetsAvailable &&
    loupeItem !== null &&
    capabilities.versions === true &&
    library.developVersions !== undefined &&
    library.saveDevelopVersions !== undefined;
  // プリセット・版を出せない写真は補正の面（選んだ面は覚えたままにし、出せる写真に戻ったらその面に戻す）。情報の面はどの写真でも出せる
  const shownAdjustPanel: BrowserPhotoAdjustPanel =
    adjustPanel === "info" || (adjustPanel === "versions" ? versionsAvailable : presetsAvailable) ? adjustPanel : "adjust";
  // 版の面を開いている間だけ版を読み、見えている版の小さな見た目を描く（版の補正を今の土台に載せた絵。写真と補正の JSON で覚える）
  const versionsShown = toolValue === "adjust" && shownAdjustPanel === "versions";
  const versions = useBrowserPhotoVersions({
    photo:
      versionsShown && loupeItem
        ? { id: loupeItem.photo.id, contentSha256: loupeOpened?.photo?.contentSha256 ?? loupeItem.photo.contentSha256 }
        : null,
    settings,
    settingsRef: open.settingsRef,
    commitEdit: open.commitEdit,
    disabled: controlsDisabled,
  });
  const versionThumbnailBase = useMemo(() => developVersionThumbnailFoundation(settings), [settings]);
  const versionThumbnails = useBrowserPresetThumbnails({
    mountedRef,
    engineRef: develop.engineRef,
    supported: presetSupport.thumbnails && versionsShown,
    photoKey: wasmPhotoKey,
    base: versionThumbnailBase,
    paused: opened?.input?.kind === "provisional" || open.dragging,
    maxDimension: BROWSER_VERSION_THUMBNAIL_MAX_DIMENSION,
    settingsOf: developVersionThumbnailSettings,
  });
  /** 道具が「補正」の間の面を選ぶ（ほかの道具の間は、補正の道具に戻してから） */
  const chooseAdjustPanel = (next: BrowserPhotoAdjustPanel) => {
    if (toolValue !== "adjust") chooseTool("adjust");
    setAdjustPanel(next);
  };
  // 右端の道具の帯（niho-photo#51）。切り抜き・背景除去に入る・出るのは今までの切り替えと同じ間だけ押せる。補正とプリセットの
  // 行き来は見せ方だけなので、補正の道具の間はいつでも押せる
  const toolSwitchDisabled = controlsDisabled || cutout.running;
  const toolRailItems: BrowserPhotoEditingToolRailItem[] = [];
  if (presetsAvailable) {
    toolRailItems.push({
      key: "presets",
      label: PHOTO_EDITING_PRESETS_TITLE,
      icon: Contrast,
      pressed: toolValue === "adjust" && shownAdjustPanel === "presets",
      disabled: toolValue !== "adjust" && toolSwitchDisabled,
      onSelect: () => chooseAdjustPanel("presets"),
    });
  }
  toolRailItems.push({
    key: "adjust",
    label: PHOTO_EDITING_TOOL_ADJUST_LABEL,
    icon: SlidersHorizontal,
    pressed: toolValue === "adjust" && shownAdjustPanel === "adjust",
    disabled: toolValue !== "adjust" && toolSwitchDisabled,
    onSelect: () => chooseAdjustPanel("adjust"),
  });
  if (tools.includes("crop")) {
    toolRailItems.push({
      key: "crop",
      label: PHOTO_EDITING_TOOL_CROP_LABEL,
      icon: Crop,
      pressed: toolValue === "crop",
      disabled: toolSwitchDisabled,
      onSelect: () => chooseTool("crop"),
    });
  }
  // 修復（niho-photo#44）。切り抜きの次に置き、押すと修復の道具、もう一度押すと補正へ戻る
  if (tools.includes("heal")) {
    toolRailItems.push({
      key: "heal",
      label: PHOTO_EDITING_TOOL_HEAL_LABEL,
      icon: Bandage,
      pressed: toolValue === "heal",
      disabled: toolSwitchDisabled,
      onSelect: () => chooseTool("heal"),
      onDeselect: () => chooseTool("adjust"),
    });
  }
  if (tools.includes("mask")) {
    toolRailItems.push({
      key: "mask",
      label: PHOTO_EDITING_TOOL_MASK_LABEL,
      icon: CircleDashed,
      pressed: toolValue === "mask",
      disabled: toolSwitchDisabled,
      onSelect: () => chooseTool("mask"),
    });
  }
  if (tools.includes("cutout")) {
    toolRailItems.push({
      key: "cutout",
      label: PHOTO_EDITING_TOOL_CUTOUT_LABEL,
      icon: Scissors,
      pressed: toolValue === "cutout",
      disabled: toolSwitchDisabled,
      onSelect: () => chooseTool("cutout"),
    });
  }
  // 版（niho-photo#42）。上の道具の末尾に置き、押すと右パネルを版の面にし（切り抜き・背景除去の間は補正の道具に戻してから）、
  // もう一度押すと補正の面へ戻る
  if (versionsAvailable) {
    toolRailItems.push({
      key: "versions",
      label: PHOTO_EDITING_TOOL_VERSIONS_LABEL,
      icon: History,
      pressed: versionsShown,
      disabled: toolValue !== "adjust" && toolSwitchDisabled,
      onSelect: () => chooseAdjustPanel("versions"),
      onDeselect: () => chooseAdjustPanel("adjust"),
    });
  }
  // 情報（niho-photo#43）。1 枚で見ている写真があるときだけ、帯の下端に置く。押すと右パネルを情報の面にし（切り抜き・背景除去の
  // 間は補正の道具に戻してから）、もう一度押すと補正の面へ戻る
  if (loupeItem) {
    toolRailItems.push({
      key: "info",
      label: PHOTO_EDITING_TOOL_INFO_LABEL,
      icon: Info,
      placement: "end",
      pressed: toolValue === "adjust" && shownAdjustPanel === "info",
      disabled: toolValue !== "adjust" && toolSwitchDisabled,
      onSelect: () => chooseAdjustPanel("info"),
      onDeselect: () => chooseAdjustPanel("adjust"),
    });
  }
  // スマホで直せる拠点の狭い幅は、直せる写真の 1 枚を全画面の編集の層で開く（F6c 移行元設計）。直せない写真は今の表示のまま
  const mobileEditorItem = mobileLayer && showAdjustments ? loupeItem : null;
  // 1 枚の面の下のフィルムストリップ（L5 #54）。PC の広い幅で 1 枚を見ている間だけ（一覧・狭い幅・スマホの層には出さない）
  const filmstripVisible = wide && loupeItem !== null && mobileEditorItem === null;
  // 補正前と補正後を見比べる（niho-photo#41）。1 枚で直せる写真を開いている間だけ使え、切り抜き / 背景除去の道具の間は閉じる
  // （道具を抜けても開き直さない）。写真・面（PC ⇄ スマホの層）が替わったら閉じる。比較の間は「補正前」（押している間）を使わない
  const compareAvailable = editable && !cropping && !cutoutActive && !healing && !cropBlocked;
  const compareView = useBrowserPhotoCompareView({
    scopeKey: loupeOpened ? `${mobileEditorItem ? "layer" : "page"}:${loupeOpened.key}` : null,
    available: compareAvailable,
  });
  const compareMode = compareView.mode;
  const changeCompareView = (next: BrowserPhotoCompareMode) => {
    if (next !== "off") open.setCompareOriginal(false);
    compareView.change(next);
  };

  const moveByArrow = (fromKey: string | null, event: ArrowKeyEvent & { shiftKey?: boolean }) => {
    if (event.altKey || event.metaKey || event.ctrlKey || operationRef.current || batchBusy) return;
    const keys = selectableKeys;
    if (viewModeRef.current === "loupe") {
      // 切り抜き・背景除去の道具の間は写真を替えない（L5 #54）
      if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || toolValue !== "adjust") return;
      event.preventDefault();
      const targetKey = movePhotoEditingPhotoId(keys, fromKey, event.key === "ArrowRight" ? 1 : -1);
      const target = targetKey && targetKey !== fromKey ? items.find((item) => item.key === targetKey) : undefined;
      if (target) void openItem(target);
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    // ↑↓ は見出しを飛ばして上下の行の同じ列（何も選んでいなければ先頭）。描いていないタイルは見える位置まで送ってからフォーカスする
    const targetKey =
      fromKey !== null && keys.includes(fromKey) ? (gridRef.current?.neighborKey(fromKey, event.key) ?? null) : (keys[0] ?? null);
    if (!targetKey) return;
    setExportSheetOpen(false);
    // ⇧＋矢印は複数選択できる場所で選択を伸ばす（起点は今の起点）。そうでなければ、移り先の 1 枚だけを選ぶ
    if (event.shiftKey && isBrowserCloudPhotoPlace(place)) selection.extend(targetKey);
    else setSelectedKey(targetKey);
    gridRef.current?.revealKey(targetKey, { focus: true });
  };

  // 1 枚の編集のキー（`useBrowserPhotoEditingKeys`）を聞いている（PC で補正を開けている。書き出しのシート・操作中は聞かない）
  const editingKeysEnabled = props.active && wide && !controlsDisabled && !exportSheetOpen;
  // J は写真への表示切替だけなので、閲覧専用でも押せるヒストグラムのボタンと同じ条件で聞く。
  const clippingKeysEnabled =
    props.active && wide && !exportSheetOpen && histogramAvailable && !clipUnavailable && histogram.histogram !== null;

  // Esc（シート → 1 枚 → 一覧の選択）・Enter・← →・⌫ / Delete・G / E。設定サブタブで隠している間は効かせない
  usePhotoEditingShortcuts({
    rootRef,
    additionalRootRef: mobileLayerRef,
    handleEscape: true,
    enabled: props.active,
    onShortcut: (shortcut: PhotoEditingShortcut, event: globalThis.KeyboardEvent) => {
      if (batchBusy) return;
      if (exportSheetOpen) {
        if (shortcut === "escape") {
          event.preventDefault();
          if (mobileBatchExport) closeBatchExportSheet();
          else closeExportSheet();
        }
        return;
      }
      // マスクの道具の間は Esc（選択を外す）と ⌫ / Delete（選んだマスクを削除。写真は消さない）を先に扱う
      if (viewModeRef.current === "loupe" && toolValue === "mask" && maskTool.handleShortcut(shortcut, event)) return;
      switch (shortcut) {
        case "grid":
          event.preventDefault();
          showGrid();
          return;
        case "loupe":
          if (operationRef.current || !selectedItem || selectedItem.adding) return;
          event.preventDefault();
          selection.collapse();
          void openItem(selectedItem);
          return;
        case "escape":
          // PC で 1 枚の編集のキーを聞いている間の切り抜きの Esc は［キャンセル］（`useBrowserPhotoEditingKeys` の
          // `onCropCancel` が入ったときの幾何に戻して「補正」へ戻す。ここでは扱わない）
          if (viewModeRef.current === "loupe" && cropping && editingKeysEnabled) return;
          event.preventDefault();
          // 切り抜き・背景除去の間は「補正」に戻る（もう一度で一覧へ。一覧では選択をすべて解く）。修復の間は、印を選んでいれば
          // 選択を外し、選んでいなければ「補正」に戻る（niho-photo#44）
          if (viewModeRef.current === "loupe" && healing) {
            if (heal.selectedId !== null) heal.select(null);
            else chooseTool("adjust");
          } else if (viewModeRef.current === "loupe" && cropping) crop.leave();
          else if (viewModeRef.current === "loupe" && (cutoutActive || cropBlocked || toolValue === "mask")) chooseTool("adjust");
          else if (viewModeRef.current === "loupe") showGrid();
          // 書き出し・一括の補正の途中は選択を解かない（［キャンセル］と同じく止める）
          else if (!operationRef.current) selection.clear();
          return;
        case "selectAll":
          // ⌘A（Ctrl+A）: 一覧の「写真」（この Mac はフォルダ）で、今読み込んである分をすべて選ぶ（1 枚で見ている間・記事の画像は
          // ブラウザの全選択のまま）
          if (
            viewModeRef.current !== "grid" ||
            (place !== "photos" && !isBrowserSelectedPhotosPlace(place) && browserPlaceFolderId(place) === null)
          ) return;
          event.preventDefault();
          if (!operationRef.current) selection.selectAll();
          return;
        case "open":
          if (operationRef.current || viewModeRef.current !== "grid" || !selectedItem || selectedItem.adding) return;
          event.preventDefault();
          selection.collapse();
          void openItem(selectedItem);
          return;
        case "arrow":
          moveByArrow(selectedKey, event);
          return;
        case "delete":
          // 修復の間（niho-photo#44）の ⌫ / Delete は選んでいる印を消す（写真は消さない）
          if (viewModeRef.current === "loupe" && healing) {
            event.preventDefault();
            if (editingKeysEnabled) heal.removeSelected();
            return;
          }
          // 2 枚以上選んでいる間・スマホの選択モードの間は消さない（一括削除は入れない。消すのは 1 枚だけ）
          if (selection.barVisible) return;
          if (
            deleteDisabled ||
            !props.canEdit ||
            staleReloading ||
            draftRecoveryPending ||
            !selectedItem ||
            selectedItem.adding
          ) return;
          event.preventDefault();
          void deleteSelectedCloudPhoto();
          return;
        default:
          return;
      }
    },
  });

  // ⌘Z / ⇧⌘Z（取り消す / やり直す）と、\ を押している間だけ補正前。1 枚の表示で補正を開けているときだけ（書き出しのシートを
  // 開いている間・操作中・設定サブタブで隠している間は効かせない）。R で「補正 / 切り抜き」を切り替える（切り抜きの間は補正前を
  // 見せない）
  // 背景除去の間（C4 移行元設計）は ⌘Z / ⇧⌘Z が背景除去の履歴に効き、補正前・コピー / 貼り付けは効かない。R は「切り抜き」と「補正」を
  // 行き来する（背景除去の間に押すと「切り抜き」へ）。切り抜きの間は Enter =［完了］・Esc =［キャンセル］（#52）
  useBrowserPhotoEditingKeys({
    rootRef,
    enabled: editingKeysEnabled,
    clippingEnabled: clippingKeysEnabled,
    clipboardEnabled:
      props.active &&
      wide &&
      open.clipboard.canCopy &&
      !staleReloading &&
      !draftRecoveryPending &&
      !cropping &&
      !cutoutActive &&
      !healing &&
      !cropBlocked &&
      !exportSheetOpen,
    onUndo: cutoutActive ? cutout.undo : open.undo,
    onRedo: cutoutActive ? cutout.redo : open.redo,
    onCopy: open.clipboard.copy,
    onPaste: open.clipboard.paste,
    onCompareOriginalChange: open.setCompareOriginal,
    // 補正前と補正後を並べている間は、補正前（押している間）を使わない（niho-photo#41）
    compareEnabled: !cropping && !cutoutActive && !healing && compareMode === "off",
    // Y: 並べる ⇄ 戻す、⇧Y: 分割 ⇄ 戻す（niho-photo#41。切り抜き / 背景除去の道具の間は扱わない）
    onToggleCompareView: compareAvailable
      ? (key) => changeCompareView(nextBrowserPhotoCompareMode(compareMode, key))
      : null,
    onToggleTool: crop.available
      ? cutout.available || heal.available
        ? () => chooseTool(toolValue === "crop" ? "adjust" : "crop")
        : crop.toggle
      : null,
    // J: 黒つぶれ・白飛びの印をまとめて重ねる / 外す（ヒストグラムを出していて、印を使える道具の間だけ）
    onToggleClipping: histogramAvailable && !clipUnavailable ? histogram.toggleBoth : null,
    // 切り抜きの間の Enter =［完了］・Esc =［キャンセル］（#52）
    onCropDone: cropping ? crop.leave : null,
    onCropCancel: cropping ? crop.cancel : null,
  });
  // 修復の間（niho-photo#44）の `[` `]`（ブラシの大きさ）と `O`（印の表示）
  useBrowserPhotoHealKeys({
    rootRef,
    enabled: editingKeysEnabled && healing,
    onKey: (key) => {
      if (key === "marks") heal.toggleShowMarks();
      else heal.stepRadius(key === "larger" ? 1 : -1);
    },
  });

  // 写真を足す操作（見出しの「＋」と空状態の主ボタンで同じ）。ブラウザはファイル選択。NIHO Desktop の口（K2 移行元設計）があれば、
  // Desktop の面の「＋」と同じメニュー（「この Mac のフォルダ」「この Mac の写真」）を出す。フォルダの一覧（v14〜）の無い Desktop は
  // メニューを出さず、押すと写真の選択ダイアログを開く。オリジナル設定がオフでも、クラウドに既にある写真を続けて使える。
  const macAdd = add.mac;
  const macAddMenuItems: PhotoEditingMenuItem[] | null = macAdd?.folders
    ? [
        {
          key: "folder",
          label: "この Mac のフォルダ",
          icon: <FolderOpen className="h-4 w-4" aria-hidden />,
          disabled: !macAdd.canAdd,
          onSelect: () => void macAdd.addFromMac("folder"),
        },
        {
          key: "mac",
          label: "この Mac の写真",
          icon: <Laptop className="h-4 w-4" aria-hidden />,
          disabled: !macAdd.canAdd,
          onSelect: () => void macAdd.addFromMac("photos"),
        },
      ]
    : null;
  const addAction = macAdd
    ? {
        disabled: !macAdd.canAdd,
        blockedReason: !props.cloudOriginalsAllowed ? BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE : null,
        onClick: macAddMenuItems ? undefined : () => void macAdd.addFromMac("photos"),
      }
    : {
        disabled: !canAdd,
        blockedReason: props.cloudOriginalsAllowed ? null : BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE,
        onClick: add.openAddPicker,
      };
  const withAddMenu = (trigger: ReactElement, align?: "start" | "end") =>
    macAddMenuItems ? (
      <PhotoEditingMenu items={macAddMenuItems} align={align}>
        {trigger}
      </PhotoEditingMenu>
    ) : (
      trigger
    );

  // 写真を足せる写真の出どころか（ファイルの追加か、NIHO Desktop の「この Mac から追加」）。足せなければ「＋」も空状態の主ボタンも
  // 出さない（この Mac のフォルダを読む NIHO camera はフォルダを足す）
  const addAvailable = macAdd !== null || capabilities.addFiles;
  const addIconButton = !addAvailable ? null : withAddMenu(
    <button
      type="button"
      aria-label="写真を追加"
      title={addAction.blockedReason ?? add.addTitle}
      aria-haspopup={macAddMenuItems ? "menu" : undefined}
      disabled={addAction.disabled}
      onClick={addAction.onClick}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-accent-ink transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Plus className="h-5 w-5" aria-hidden />
    </button>,
    "end",
  );

  const mobileBatchExport = !wide && viewMode === "grid" && selection.multiple;
  const batchExportKey = selectedItems.map((item) => item.key).join("\u001f");
  const batchResolvedChoices = mobileBatchExport
    ? selectedItems.map((item) => ({
        item,
        choices: resolveBrowserPhotoExportChoices({
          photo: item.photo,
          loupe: false,
          editing: null,
          locked: false,
          wide: editingAllowed,
          engineUsable: !develop.developUnavailable,
        }),
      }))
    : [];
  const batchWithinLimit = selectedItems.length >= 2 && selectedItems.length <= PHOTO_SAVE_MAX_FILES;
  const batchJpegEnabled = batchWithinLimit && batchResolvedChoices.every(({ choices }) => choices.jpeg.enabled);
  const batchSizeSelectable = batchJpegEnabled && batchResolvedChoices.every(({ choices }) => choices.jpeg.route === "engine");
  const mobileBatchExportChoices: BrowserPhotoExportChoices | null = mobileBatchExport
    ? {
        jpeg: {
          enabled: batchJpegEnabled,
          detail: !batchWithinLimit
            ? `一度に保存できるのは ${PHOTO_SAVE_MAX_FILES} 枚までです`
            : batchJpegEnabled
              ? `${selectedItems.length} 枚・補正を反映`
              : "書き出せない写真が含まれています",
          route: batchJpegEnabled ? "engine" : null,
          sizeSelectable: batchSizeSelectable,
          // スマホの複数枚は、どの写真も wasm のメモリに収まる見込みのときだけ「大きく」を出す
          ...(batchSizeSelectable &&
          selectedItems.every((item) =>
            isBrowserPhotoExportLargeWithinMobileMemory(item.photo.developSettings ?? {}, null, isDevelopWorkTarget(item.photo)),
          )
            ? { large: BROWSER_PHOTO_EXPORT_BATCH_LARGE_CHOICE }
            : {}),
          // 一部だけに付くとき「撮影日時を付けます」と全枚数へ読める文を出さない。
          captureExif: batchResolvedChoices.every(({ choices }) => choices.jpeg.captureExif),
        },
        original: { enabled: false, detail: "複数枚は JPEG で保存します" },
      }
    : null;
  const batchJpegRoutes = new Map<string, BrowserPhotoExportJpegRoute>(
    batchResolvedChoices.flatMap(({ item, choices }) =>
      choices.jpeg.route ? ([[item.key, choices.jpeg.route]] as [string, BrowserPhotoExportJpegRoute][]) : [],
    ),
  );

  // 作業コピーを待っている写真は、待っている間も記事用の画像・オリジナルを書き出せる。スマホの複数選択は選択順の最大 10 枚を
  // ZIP にせず、同じ保存シートから JPEG の File 配列として渡す。
  const canExportSingle =
    selectedItem !== null &&
    !selectedItem.adding &&
    selection.count <= 1 &&
    operation === null &&
    !staleReloading &&
    !draftRecoveryPending &&
    !(viewMode === "loupe" && opening && !opened?.work);
  const canExportBatch =
    // 一括JPEGが使えない場合もシートは開けるようにし、10枚上限や対象外写真の理由を見せる。
    mobileBatchExport && selectedItems.length > 1 && operation === null && !staleReloading && !draftRecoveryPending;
  const canExport = canExportSingle || canExportBatch;
  const keepBatchExportSheetOpen =
    mobileBatchExport && (operation?.kind === "export" || pendingShare?.key === batchExportKey);
  // 書き出しに背景除去を当てる写真（NIHO camera。1 枚で見ている写真に重ねている間だけ。C4 移行元設計）。web は口が無いので null
  const cutoutExportCandidate =
    viewMode === "loupe" && selectedItem !== null && cutout.exportable?.photoKey === selectedItem.key ? cutout.exportable : null;
  const cutoutFullSizeAvailable =
    cutoutExportCandidate !== null &&
    selectedItem !== null &&
    isBrowserPhotoCutoutFullSizeAvailable(selectedItem.photo, {
      hostExport: cutoutExportCandidate.exportFullSize !== undefined,
      nativeExport: capabilities.nativeExport,
      nativeExportRaster: capabilities.nativeExportRaster,
    });
  const cutoutExport = (() => {
    if (!cutoutExportCandidate || cutoutFullSizeAvailable) return cutoutExportCandidate;
    const withoutFullSize = { ...cutoutExportCandidate };
    delete withoutFullSize.exportFullSize;
    return withoutFullSize;
  })();
  const selectedExportSettings =
    selectedItem && viewMode === "loupe" && opened?.key === selectedItem.key
      ? open.settingsRef.current
      : selectedItem?.photo.developSettings ?? {};
  const nativeExportBlockers = photoEditingNativeExportBlockers(selectedExportSettings, capabilities.nativeExportRenderer);
  const nativeFullSizeUnsupported = nativeExportBlockers.length > 0;
  // 「大きく」（niho-photo#134）で書き出す画の寸法（1 枚で wasm で開いた写真の今の切り抜き。書き出すのシートを開いている間だけ読む）
  const exportLargeSize = useBrowserPhotoExportLargeSize({
    mountedRef,
    engineRef: develop.engineRef,
    developSessionRef: develop.developSessionRef,
    photoKey: wasmPhotoKey,
    settingsKey: open.settingsKey,
    settingsRef: open.settingsRef,
    active: exportSheetOpen || mobileExportSheetOpen,
  });
  const exportLargeOutput = selectedItem && wasmPhotoKey === selectedItem.key ? exportLargeSize : null;
  const exportChoices = selectedItem
    ? resolveBrowserPhotoExportChoices({
        photo: selectedItem.photo,
        loupe: viewMode === "loupe",
        largeLongEdge: exportLargeOutput ? Math.max(exportLargeOutput.width, exportLargeOutput.height) : null,
        // スマホは wasm のメモリに収まる見込みの写真だけ（PC の幅は出す）
        large:
          wide ||
          isBrowserPhotoExportLargeWithinMobileMemory(
            selectedExportSettings,
            exportLargeOutput,
            isDevelopWorkTarget(selectedItem.photo),
          ),
        editing: loupeEditing ? (loupeOpened?.mode === "wasm" ? "wasm" : "canvas") : null,
        locked: loupeOpened?.lockedReason != null,
        wide: editingAllowed,
        engineUsable: !develop.developUnavailable,
        // 原寸（K2-3a 移行元設計）は、原寸の書き出しに対応した NIHO Desktop の口があるときだけ（PC のシートに出す）
        desktopFullSize: capabilities.nativeExport || capabilities.nativeExportUpdateRequired,
        nativeFullSizeUnsupported,
        nativeFullSizeUnsupportedText: photoEditingNativeExportUnsupportedText(nativeExportBlockers, capabilities.place),
        // HEIC / HEIF・TIFF の原寸は、描ける口（NIHO camera）だけ
        desktopFullSizeRaster: capabilities.nativeExportRaster === true,
        // 背景除去（C4 移行元設計）: PNG を足し、原寸は camera の口があるときだけ
        ...(cutoutExport
          ? {
              cutout: {
                transparent: cutoutExport.recipe.background.kind === "transparent",
                fullSize: cutoutFullSizeAvailable,
              },
            }
          : {}),
      })
    : null;

  const canBatchExport = wide && selection.multiple && operation === null && !staleReloading && !draftRecoveryPending;
  const batchZipSaveAvailable = browserBulkRuntime;
  // ZIP を保存できない NIHO Desktop のうち、原寸の書き出しとフォルダの選択の両方ができる（更新が要る版は押すと更新の 1 行）
  // Desktop は、選択バーの［書き出す］のシートを「フォルダへ原寸で書き出す」にする（K2-3b 移行元設計。ブラウザの ZIP は変えない）
  const batchFolderExportAvailable =
    !batchZipSaveAvailable && (capabilities.exportFolder || capabilities.nativeExportUpdateRequired);
  const batchExportChoices = resolveBrowserPhotoBatchExportChoices({
    engineUsable: !develop.developUnavailable,
    zipSaveAvailable: batchZipSaveAvailable,
    desktopFolderExport: batchFolderExportAvailable,
  });
  useEffect(() => {
    if (!canExport && !canBatchExport && !keepBatchExportSheetOpen) setExportSheetOpen(false);
  }, [canBatchExport, canExport, keepBatchExportSheetOpen]);

  useEffect(() => {
    if (exportSheetOpen || !batchExportFocusPendingRef.current) return;
    if (canExport) {
      exportButtonRef.current?.focus({ preventScroll: true });
      batchExportFocusPendingRef.current = false;
    } else if (operation === null) {
      batchExportFocusPendingRef.current = false;
    }
  }, [canExport, exportSheetOpen, operation]);

  // 一覧の複数書き出しにも「戻る」を積む。最初の戻るはシートを閉じて選択を保つ。
  usePhotoEditingLayerHistory(closeBatchExportSheet, mobileBatchExport && exportSheetOpen);

  // ♥ の対象（選んでいる 1 枚・1 枚で開いている 1 枚）。元の写真のある「写真」だけ（記事の画像・追加している途中は押せない）。
  // 2 枚以上選んでいる間は押せない（複数のときの ♥ は、複数選択の操作として別に足す。F5b 移行元設計）
  const favoriteItem =
    selectedItem && !selectedItem.adding && selection.count <= 1 && canFavoriteBrowserCloudPhoto(selectedItem.photo)
      ? selectedItem
      : null;
  const toggleFavorite = () => {
    const item = favoriteItem;
    if (!item) return;
    const next = item.photo.favorite !== true;
    // 前に出した失敗の 1 行は、押し直したら消す
    setStatus((current) => (current?.kind === "error" && current.text === FAVORITE_FAILED_TEXT ? null : current));
    if (isBrowserItemInPlace({ ...item, photo: { ...item.photo, favorite: next } }, place)) {
      void favorites.setFavorite(item.photo, next);
      return;
    }
    // 今の場所（お気に入り）から外れる写真は、消したときと同じく選択を外す。1 枚の表示は一覧へ戻ってから外す（写真の無い 1 枚の
    // 表示を挟まない。保存を送り終えられず戻れなければ、外さない）
    const leave = () => {
      setSelectedKey((current) => (current === item.key ? null : current));
      void favorites.setFavorite(item.photo, next);
    };
    if (viewModeRef.current === "grid") {
      leave();
      return;
    }
    void returnToGrid().then((left) => {
      if (left && mountedRef.current) leave();
    });
  };
  const favoriteControl: BrowserPhotoFavoriteControl = {
    photoId: favoriteItem?.photo.id ?? null,
    favorite: favoriteItem?.photo.favorite === true,
    // 送っている間・1 枚から一覧へ戻っている間は 2 回目を受けない
    busy: favoriteItem !== null && (favorites.pendingIds.has(favoriteItem.photo.id) || develop.leaving),
    disabled: !props.canEdit || operation !== null || batchBusy,
    onToggle: toggleFavorite,
  };

  // お気に入り・アルバムを持たない写真の出どころ（`capabilities` が false。この Mac）には、その道具を出さない
  const favoritesAvailable = capabilities.favorites && library.favorites !== undefined;
  const albumsAvailable = capabilities.albums && library.albums !== undefined;
  const shownFavoriteControl = favoritesAvailable ? favoriteControl : undefined;

  // 選別（採用 / 却下。niho-photo#47。♥ とは別の印）。対象は一覧で選んでいる写真（複数選択なら全部）か、1 枚で開いている写真（元の
  // 写真のある写真だけ。追加中・記事の画像は対象にしない）。キー P / X / U と下段のボタンが同じ写真に効く。却下しても写真は消さない
  const flagsAvailable = capabilities.flags === true && library.flags !== undefined;
  const flagTargets = (viewMode === "loupe" ? (loupeItem ? [loupeItem] : []) : selectedItems).filter(
    (item) => !item.adding && item.photo.hasOriginal,
  );
  const flagsDisabled = !props.canEdit || operation !== null || batchBusy;
  const applyFlag = (flag: PhotoLibraryFlag | null) => {
    if (!flagsAvailable || flagsDisabled || flagTargets.length === 0) return;
    // 前に出した失敗の 1 行は、押し直したら消す
    setStatus((current) => (current?.kind === "error" && current.text === PHOTO_EDITING_FLAG_FAILED_TEXT ? null : current));
    // 一覧で選んでいる 1 枚が今の絞り込み（採用だけ / 却下を隠す）から外れるなら、隣の写真を選んでフォーカスを移す（続けて選別
    // できる）。1 枚の表示では、別の写真へ移るまで出したまま
    const [target] = flagTargets;
    if (
      viewModeRef.current === "grid" &&
      flagTargets.length === 1 &&
      target &&
      !flags.isPending(target.photo.id) &&
      (target.photo.flag ?? null) !== flag &&
      !isBrowserCloudPhotoInFilter({ ...target.photo, flag }, listView.filter)
    ) {
      const index = selectableKeys.indexOf(target.key);
      const neighbor = selectableKeys[index + 1] ?? (index > 0 ? selectableKeys[index - 1] : undefined) ?? null;
      setSelectedKey(neighbor);
      if (neighbor) gridRef.current?.revealKey(neighbor, { focus: true });
    }
    void flags.setFlag(flagTargets.map((item) => item.photo), flag);
  };
  const flagValues = flagTargets.map((item) => item.photo.flag ?? null);
  const flagControl: BrowserPhotoFlagControl | undefined = flagsAvailable
    ? {
        flag: flagValues.every((value) => value === flagValues[0]) ? (flagValues[0] ?? null) : "mixed",
        available: flagTargets.length > 0,
        busy: flagTargets.some((item) => flags.pendingIds.has(item.photo.id)),
        disabled: flagsDisabled,
        onSet: applyFlag,
      }
    : undefined;
  // P / X / U（PC だけ。一覧でも 1 枚でも。書き出しのシート・操作中・閲覧のみの間は聞かない）。修復など写真の上のキーを使う道具の
  // キーを先に扱う（この listener は後から足し、道具が使ったキーは `defaultPrevented` で飛ばす）
  useBrowserPhotoFlagKeys({
    rootRef,
    enabled: props.active && wide && flagsAvailable && !flagsDisabled && !exportSheetOpen,
    onFlag: applyFlag,
  });

  // 複数選択の操作対象は、既存 selection が指す置き終えた元写真だけ。混在時は「追加」にし、全枚に同じ結果を適用する。
  const selectedPhotoIds = selectedBatchPhotos.map((photo) => photo.id);
  const selectedAreAllFavorite = selectedBatchPhotos.length > 0 && selectedBatchPhotos.every((photo) => photo.favorite === true);
  const batchFavoriteLabel = browserPhotoBatchFavoriteLabel(
    selectedBatchPhotos.map((photo) => photo.favorite === true),
  );
  const runBatchFavorite = async () => {
    if (batchBusy || operationRef.current || selectedPhotoIds.length === 0 || !props.canEdit) return;
    setBatchBusy(true);
    setStatus(null);
    try {
      await albumLibrary.setPhotosFavorite(selectedPhotoIds, !selectedAreAllFavorite);
      selection.clear();
      setStatus({ kind: "notice", text: selectedAreAllFavorite ? "お気に入りから外しました。" : "お気に入りに追加しました。" });
    } catch {
      setStatus({ kind: "error", text: "お気に入りを変更できませんでした。" });
    } finally {
      if (mountedRef.current) setBatchBusy(false);
    }
  };
  const addSelectedToAlbum = async (albumId: string) => {
    if (batchBusy || operationRef.current || selectedPhotoIds.length === 0 || !props.canEdit) throw new Error("no selectable photos");
    setBatchBusy(true);
    setStatus(null);
    try {
      await albumLibrary.addPhotosToAlbum(albumId, selectedPhotoIds);
      selection.clear();
      setStatus({ kind: "notice", text: "アルバムに追加しました。" });
    } catch (error) {
      setStatus({ kind: "error", text: "アルバムに追加できませんでした。" });
      throw error;
    } finally {
      if (mountedRef.current) setBatchBusy(false);
    }
  };
  const removeSelectedFromCurrentAlbum = async () => {
    if (!currentAlbumId || batchBusy || operationRef.current || selectedPhotoIds.length === 0 || !props.canEdit) return;
    setBatchBusy(true);
    setStatus(null);
    try {
      await albumLibrary.removePhotosFromAlbum(currentAlbumId, selectedPhotoIds);
      selection.clear();
      setStatus({ kind: "notice", text: "アルバムから外しました。" });
    } catch {
      setStatus({ kind: "error", text: "アルバムから外せませんでした。" });
    } finally {
      if (mountedRef.current) setBatchBusy(false);
    }
  };

  // ヘッダーのパンくず（クラウド › 写真 / お気に入り / 記事の画像 › <写真名>）。一覧では場所まで（今いる場所は押せない）。1 枚では
  // 場所の段を押すと一覧へ戻る（場所を選び直すのと同じく、保存を送り終えてから）
  const breadcrumbActionsRef = useRef({ showGrid });
  breadcrumbActionsRef.current = { showGrid };
  const breadcrumbPhotoId = viewMode === "loupe" && selectedItem ? selectedItem.photo.id : null;
  const breadcrumbFileName = viewMode === "loupe" && selectedItem ? selectedItem.photo.fileName : null;
  // この Mac のフォルダの面は「この Mac › <フォルダ名>」（フォルダを選んでいなければ「この Mac」だけ）
  const breadcrumbFolderName = folderMode
    ? folders.selected
      ? PHOTO_EDITING_SELECTED_PHOTOS_LABEL
      : folders.selectedFolderId === null
        ? null
        : browserPhotoPlaceLabel(place, [], folders.tree ?? [])
    : undefined;
  useEffect(() => {
    if (breadcrumbFolderName !== undefined) {
      const breadcrumb: PhotoEditingBreadcrumbItem[] = [{ key: "local", label: PHOTO_EDITING_LOCAL_PLACE_LABEL, icon: "folder" }];
      if (breadcrumbFolderName !== null) {
        const folderItem: PhotoEditingBreadcrumbItem = { key: place, label: breadcrumbFolderName };
        if (breadcrumbPhotoId === null || breadcrumbFileName === null) breadcrumb.push(folderItem);
        else {
          breadcrumb.push(
            { ...folderItem, onSelect: () => breadcrumbActionsRef.current.showGrid() },
            { key: `photo:${breadcrumbPhotoId}`, label: breadcrumbFileName },
          );
        }
      }
      setPhotoEditingBreadcrumb(breadcrumb);
      return;
    }
    const placeItem: PhotoEditingBreadcrumbItem = { key: place, label: browserPhotoPlaceLabel(place, albumLibrary.albums) };
    const breadcrumb: PhotoEditingBreadcrumbItem[] = [{ key: "cloud", label: "クラウド", icon: "cloud" }];
    if (breadcrumbPhotoId === null || breadcrumbFileName === null) {
      breadcrumb.push(placeItem);
    } else {
      breadcrumb.push(
        { ...placeItem, onSelect: () => breadcrumbActionsRef.current.showGrid() },
        { key: `photo:${breadcrumbPhotoId}`, label: breadcrumbFileName },
      );
    }
    setPhotoEditingBreadcrumb(breadcrumb);
  }, [albumLibrary.albums, breadcrumbFileName, breadcrumbFolderName, breadcrumbPhotoId, place]);
  useEffect(() => () => setPhotoEditingBreadcrumb(null), []);

  const deleteButton =
    !deleteDisabled && selectedItem && !selectedItem.adding && selection.count <= 1 ? (
      <button
        type="button"
        onClick={() => void deleteSelectedCloudPhoto()}
        disabled={!props.canEdit || operation !== null || staleReloading || draftRecoveryPending}
        // 狭い幅はアイコンだけ（右上の行に並びの切り替え・使用量と並べて 320px に収める。読み上げと title は残す）
        aria-label={wide ? undefined : "クラウドから消す"}
        title={wide ? undefined : "クラウドから消す"}
        className={cn(
          PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME,
          // 行の高さ（32px）は変えず、押せる範囲だけ 44px にする
          "relative after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
          !wide && "w-8 justify-center px-0 after:-inset-x-1.5",
        )}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        {wide ? "クラウドから消す" : null}
      </button>
    ) : null;
  const usageText = cloud.usage ? <span className="truncate">{formatPhotoCloudUsage(cloud.usage)}</span> : null;
  // 一覧の上の行。2 枚以上選んでいる間とスマホの選択モードの間は、左を選択バーに替える（並びの切り替えと「クラウドから消す」は出さない。
  // 並びを変えると読み直しで選択が欠ける・消すのは 1 枚だけ）。右は、広い幅は使用量だけ、狭い幅は空（バーが行いっぱいに広がる）。
  // そうでなければ、左は並びの切り替えとそのすぐ右の絞り込み（「写真」「お気に入り」だけ。記事の画像は撮影日・種類・補正済みを持たず、
  // 並びが変わらない）、右は「クラウドから消す」と使用量
  const metaStart = selection.barVisible ? (
    <div className="relative flex min-w-0 items-center">
      <BrowserPhotoEditingSelectionBar
        count={selection.count}
        compact={!wide}
        allSelected={selection.allSelected}
        favoriteLabel={!favoritesAvailable || (!wide && bulk.menu) ? undefined : batchFavoriteLabel}
        albumLabel={
          !albumsAvailable || (!wide && bulk.menu) ? undefined : currentAlbumId ? "アルバムから外す" : "アルバムに追加"
        }
        actionsDisabled={!props.canEdit || batchBusy || selectedPhotoIds.length === 0 || operation !== null}
        selectionDisabled={batchBusy || operation !== null}
        onFavorite={() => void runBatchFavorite()}
        onAlbum={() => (currentAlbumId ? void removeSelectedFromCurrentAlbum() : setAlbumAddOpen(true))}
        onSelectAll={selection.selectAll}
        onCancel={selection.clear}
        exportAction={
          wide && selection.multiple && (batchZipSaveAvailable || batchFolderExportAvailable)
            ? {
                buttonRef: batchExportButtonRef,
                exporting: operation?.kind === "export",
                stopping: batchStopping,
                finalizing: batchFinalizing,
                // 一括の補正の途中は押せない（同じ場所の「補正」が「止める」になっている）
                disabled: operation?.kind === "bulk",
                onExport: () => {
                  // ZIP の 50 枚・500MB の上限は ZIP だけ（フォルダへは Desktop が 1 枚ずつ直接書く）
                  const limit = batchZipSaveAvailable ? resolveBrowserPhotoBatchExportLimit(batchExportTargets) : null;
                  if (limit && !limit.allowed) {
                    setStatus({ kind: "error", text: limit.message });
                    setExportSheetOpen(false);
                    return;
                  }
                  setStatus(null);
                  setExportSheetOpen(true);
                },
                onStop: stopBatchExport,
              }
            : undefined
        }
        bulkAction={
          bulk.menu && ((wide && selection.multiple) || (!wide && selection.selecting)) ? (
            <BrowserPhotoEditingBulkMenu
              {...bulk.menu}
              compactActions={
                !wide
                  ? [
                      ...(favoritesAvailable
                        ? [
                            {
                              key: "favorite",
                              label: batchFavoriteLabel,
                              disabled: !props.canEdit || batchBusy || selectedPhotoIds.length === 0 || operation !== null,
                              onSelect: () => void runBatchFavorite(),
                            },
                          ]
                        : []),
                      ...(albumsAvailable
                        ? [
                            {
                              key: "album",
                              label: currentAlbumId ? "アルバムから外す" : "アルバムに追加",
                              disabled: !props.canEdit || batchBusy || selectedPhotoIds.length === 0 || operation !== null,
                              opensDialog: currentAlbumId === null,
                              onSelect: () => (currentAlbumId ? void removeSelectedFromCurrentAlbum() : setAlbumAddOpen(true)),
                            },
                          ]
                        : []),
                    ]
                  : undefined
              }
            />
          ) : undefined
        }
        exportUnavailableMessage={
          wide && selection.multiple && !batchZipSaveAvailable && !batchFolderExportAvailable
            ? "ZIP は NIHO Desktop と NIHO アプリでは保存できません。ブラウザで開いてください。"
            : undefined
        }
      />
      {exportSheetOpen && canBatchExport ? (
        <BrowserPhotoExportSheet
          choices={batchExportChoices}
          batchCount={selection.count}
          anchorRef={batchExportButtonRef}
          onDownload={(format, size) => {
            // 原寸はフォルダへの書き出し（NIHO Desktop だけ。K2-3b）、ほかの大きさは ZIP
            if (size === "full") {
              if (format === "jpeg" && batchFolderExportAvailable) void runBatchFolderExport();
            } else {
              void runBatchExport(format, size);
            }
          }}
          onClose={closeExportSheet}
        />
      ) : null}
    </div>
  ) : isBrowserCloudPhotoPlace(place) ? (
    <div className="flex shrink-0 items-center gap-0.5">
      {!isBrowserSelectedPhotosPlace(place) ? <BrowserPhotoListSortControl value={listSort} onChange={list.setSort} /> : null}
      {canFilterBrowserCloudPlace(place) ? (
        <BrowserPhotoListFilterControl
          filter={listView.filter}
          count={listView.filterCount}
          flags={flagsAvailable}
          onChange={listView.changeFilter}
          onClear={listView.clearFilter}
        />
      ) : null}
    </div>
  ) : null;
  const meta = selection.barVisible ? (
    wide ? usageText : null
  ) : (
    <>
      {deleteButton}
      {cloud.usage ? (
        // 狭い幅で「クラウドから消す」と並ぶときは、絞り込みのボタンの分で使用量が「0.0…」と切れるので、360px 未満は隠す
        // （写真を選んでいないときは全部入るので出す。設定の「クラウド」にも出る）
        <span className={cn("truncate", deleteButton && "max-[359px]:hidden")}>{formatPhotoCloudUsage(cloud.usage)}</span>
      ) : null}
    </>
  );
  // スマホの「選択」（複数選択に入る）。上段（場所の切り替え）の「＋」の左に置く。一覧に写真があるときだけ、選択モードの間は出さない
  // （一覧の上に残る行は、並びの切り替え・使用量・消すで 320px がいっぱい。使用量が潰れるので、そこには置かない）
  const selectModeButton =
    !wide && isBrowserCloudPhotoPlace(place) && selectableKeys.length > 0 && !selection.selecting ? (
      <BrowserPhotoEditingSelectModeButton
        onClick={() => {
          if (!operationRef.current && !batchBusy) selection.startSelecting();
        }}
      />
    ) : null;

  const progressText = adding
    ? describePhotoCloudAddProgress(adding)
    : add.macBusy
      ? "この Mac の写真を追加中…"
      : operation?.kind === "copy"
        ? (operation.progressText ?? "クラウドにコピー中…")
        : operation?.kind === "export"
          ? (operation.progressText ?? `${operation.fileName} を書き出し中…`)
          : operation?.kind === "bulk"
            ? (operation.progressText ?? null)
            : operation?.kind === "delete" && operation.deleting
              ? PHOTO_CLOUD_DELETING_NOTICE
              : null;
  const recoveryControl = develop.draftRecovery.selectedDraft
    ? {
        count: develop.draftRecovery.count,
        conflict: develop.draftRecovery.selectedDraft.conflicted,
        busy: develop.draftRecovery.busy,
        message: develop.draftRecovery.message,
        onRestore: () => void open.restoreDraft(),
        onDiscard: develop.draftRecovery.discardSelectedDraft,
      }
    : null;

  // この Mac のフォルダの面で、フォルダを選んでいない（木を読み込み中・読めなかった・フォルダが無い・木を読んで選び直している途中）
  const folderUnselected = folderMode && !folders.selected && folders.selectedFolderId === null;
  const folderPlaceholder = !folderUnselected ? null : folders.error ? (
    <div className="space-y-3 text-center">
      <p className="text-sub text-niho-danger">{PHOTO_EDITING_FOLDERS_LOAD_FAILED_TEXT}</p>
      <button type="button" onClick={folders.retry} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}>
        もう一度読み込む
      </button>
    </div>
  ) : folders.tree !== null && folders.tree.length === 0 && folders.selectedCount === 0 ? (
    library.selectedPhotos ? <PhotoEditingAddPhotosEmptyState
      action={
        <PhotoEditingMenu
          variant="browser"
          items={[
            {
              key: "folder",
              label: PHOTO_EDITING_ADD_FOLDER_LABEL,
              icon: <FolderOpen className="h-4 w-4" aria-hidden />,
              disabled: folders.busy || operation !== null || batchBusy,
              onSelect: () => void folders.addFolder(),
            },
            {
              key: "photos",
              label: PHOTO_EDITING_ADD_SELECTED_PHOTOS_LABEL,
              icon: <Laptop className="h-4 w-4" aria-hidden />,
              disabled: folders.busy || operation !== null || batchBusy,
              onSelect: () => void folders.addPhotos(),
            },
          ]}
        >
          <button
            type="button"
            aria-haspopup="menu"
            disabled={folders.busy || operation !== null || batchBusy}
            className={cn(PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME, "min-h-11")}
          >
            フォルダや写真を追加
          </button>
        </PhotoEditingMenu>
      }
    /> : <PhotoEditingAddFolderEmptyState
      disabled={folders.busy || operation !== null || batchBusy}
      onAdd={() => void folders.addFolder()}
    />
  ) : null;
  const placeholder = folderPlaceholder ? (
    folderPlaceholder
  ) : cloud.isError ? (
    <div className="space-y-3 text-center">
      <p className="text-sub text-niho-danger">
        {library.place === "local" ? PHOTO_EDITING_LOCAL_PHOTOS_LOAD_FAILED_TEXT : "クラウドの写真を読み込めませんでした。"}
      </p>
      <button type="button" onClick={cloud.refetch} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}>
        もう一度読み込む
      </button>
    </div>
  ) : listView.filterCount > 0 ? (
    // 絞り込みの条件があるときは、場所によらず 1 行と文字のボタン（主ボタンにしない）
    <div className="space-y-3 text-center">
      <p className="text-sub text-niho-text-muted">条件に合う写真はありません</p>
      <button type="button" onClick={listView.clearFilter} className={PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME}>
        絞り込みを解除
      </button>
    </div>
  ) : browserPlaceFolderId(place) !== null ? (
    // この Mac のフォルダは 1 行だけ（クラウドの「写真を追加」の導線は出さない）
    <p className="text-center text-sub text-niho-text-muted">{PHOTO_EDITING_FOLDER_EMPTY_TEXT}</p>
  ) : place === "photos" && !addAvailable ? (
    <p className="text-center text-sub text-niho-text-muted">写真はありません</p>
  ) : place === "photos" ? (
    <div className="space-y-3 text-center">
      <p className="text-sub text-niho-text-muted">写真を追加すると、ここで明るさや色を直して書き出せます</p>
      {withAddMenu(
        <button
          type="button"
          disabled={addAction.disabled}
          title={addAction.blockedReason ?? undefined}
          aria-haspopup={macAddMenuItems ? "menu" : undefined}
          onClick={addAction.onClick}
          className={cn(PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME, "min-h-11")}
        >
          写真を追加
        </button>,
      )}
      {wide ? <p className="text-xs text-niho-text-muted">ここにドロップしても追加できます</p> : null}
    </div>
  ) : currentAlbumId ? (
    <p className="text-center text-sub text-niho-text-muted">アルバムに写真はありません</p>
  ) : (
    // 「お気に入り」「記事の画像」は 1 行だけ（説明・主ボタンは置かない）
    <p className="text-center text-sub text-niho-text-muted">
      {place === "favorites" ? "お気に入りの写真はありません" : "記事の画像はありません"}
    </p>
  );

  return (
    <section
      ref={rootRef}
      aria-label="ブラウザ写真編集"
      className={cn(
        "overflow-hidden bg-[var(--photo-editing-surface,white)]",
        props.appearance === "fill" ? "flex min-h-0 flex-1 flex-col" : "rounded-2xl border border-white/70 shadow-sm",
      )}
      // スマホの 1 枚の編集の層を出している間、後ろの面は操作も読み上げもさせない（層は document.body に出る）
      inert={inertAttribute(mobileEditorItem !== null)}
      {...add.fileDrop.zoneProps}
    >
      <input
        ref={add.fileInputRef}
        type="file"
        multiple
        accept={ADD_ACCEPT}
        disabled={!canAdd}
        onChange={add.onFilesChosen}
        tabIndex={-1}
        className="sr-only"
        aria-label="追加する写真を選ぶ"
      />
      {folderMode ? null : (
        // 狭い幅の上段（クラウドの場所の切り替え）。この Mac のフォルダの面は出さない（NIHO camera は狭い幅の面を出さない）
        <BrowserPhotoEditingPlaceTabs
          place={place}
          counts={treeCounts}
          albums={albumLibrary.albums}
          albumsPending={albumLibrary.isPending}
          albumsError={albumLibrary.isError}
          addButton={addIconButton}
          selectButton={selectModeButton}
          onSelectPlace={(next) => { if (!batchBusy) void selectPlace(next); }}
          onCreateAlbum={props.canEdit && !batchBusy ? () => setAlbumEditorRequest({ kind: "create" }) : undefined}
          onManageAlbum={props.canEdit && !batchBusy ? (album) => setAlbumEditorRequest({ kind: "edit", album }) : undefined}
          onRetryAlbums={() => void albumLibrary.refetch()}
        />
      )}
      <div
        className={cn(
          "grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto]",
          // web の写真編集タブは画面の高さから引いた固定の高さ。NIHO photo（fill）は親の flex に合わせて窓の底まで
          props.appearance === "fill" ? "min-h-0 flex-1" : "min-h-[520px] lg:h-[calc(100dvh-12rem)] lg:min-h-[620px]",
          // 右パネルがあるときは、その右に道具の帯（niho-photo#51）。PC の幅では左の木・右パネル・道具の帯が 2 段（面と下段）を
          // 貫き、下段は中央の列の下だけ（niho-photo#49）
          props.treeHidden
            ? showAdjustments
              ? "lg:grid-cols-[minmax(0,1fr)_15.5rem_2.75rem]"
              : "lg:grid-cols-[minmax(0,1fr)]"
            : showAdjustments
              ? "lg:grid-cols-[14rem_minmax(0,1fr)_15.5rem_2.75rem]"
              : "lg:grid-cols-[14rem_minmax(0,1fr)]",
        )}
      >
        {props.treeHidden ? null : folderMode ? (
          <BrowserPhotoEditingFolderTree
            footer={props.treeFooter}
            folders={folders.tree}
            error={folders.error}
            selectedFolderId={folders.selectedFolderId}
            selectedPhotos={folders.selected}
            selectedPhotoCount={folders.selectedCount}
            disabled={folders.busy || operation !== null || batchBusy}
            onAddFolder={() => void folders.addFolder()}
            onAddPhotos={library.selectedPhotos ? () => void folders.addPhotos() : undefined}
            onSelectFolder={(folderId) => { if (!batchBusy) void selectPlace(browserFolderPlace(folderId)); }}
            onSelectSelectedPhotos={library.selectedPhotos ? () => { if (!batchBusy) void selectPlace("selected"); } : undefined}
            onForgetFolder={(folder) => void folders.forgetFolder(folder)}
            onForgetSelectedPhotos={library.selectedPhotos ? () => void folders.forgetSelectedPhotos() : undefined}
            onRetry={folders.retry}
          />
        ) : (
          <BrowserPhotoEditingTree
            footer={props.treeFooter}
            place={place}
            counts={treeCounts}
            albums={albumLibrary.albums}
            albumsPending={albumLibrary.isPending}
            albumsError={albumLibrary.isError}
            addButton={addIconButton}
            onSelectPlace={(next) => { if (!batchBusy) void selectPlace(next); }}
            onCreateAlbum={props.canEdit && !batchBusy ? () => setAlbumEditorRequest({ kind: "create" }) : undefined}
            onManageAlbum={props.canEdit && !batchBusy ? (album) => setAlbumEditorRequest({ kind: "edit", album }) : undefined}
            onRetryAlbums={() => void albumLibrary.refetch()}
          />
        )}

        {/* 中央の列: 面（一覧か 1 枚）と、1 枚のときだけその下のフィルムストリップ（L5 #54） */}
        <div className="relative flex min-h-0 flex-col bg-[var(--photo-editing-surface,white)]">
          <div className="relative min-h-0 flex-1">
            {viewMode === "grid" ? (
              <BrowserPhotoEditingGrid
                ref={gridRef}
                items={gridItems}
                listKey={listView.listKey}
                compact={!wide}
                selectedKeys={selection.selectedKeys}
                selecting={selection.selecting}
                activeKey={selectedKey}
                // この Mac のフォルダの面は、フォルダを選ぶまで（木を読み込み中・選び直している途中）も読み込み中にする
                loading={cloud.isPending || (folderUnselected && folderPlaceholder === null)}
                metaStart={metaStart}
                // 条件のある空の一覧でも上の行を残す（絞り込みのパネルを開いたまま選び直せる）
                metaWhenEmpty={listView.filterCount > 0}
                meta={meta}
                placeholder={placeholder}
                more={{
                  hasMore: cloud.hasNextPage,
                  loading: cloud.isFetchingNextPage,
                  failedMessage: cloud.isFetchNextPageError ? "続きを読み込めませんでした。" : null,
                  onLoad: cloud.fetchNextPage,
                }}
                onTileClick={(key, event) => {
                  if (operationRef.current || batchBusy) return;
                  const item = items.find((candidate) => candidate.key === key);
                  if (!item || item.adding) return;
                  setExportSheetOpen(false);
                  // スマホの選択モード: 足す・外す（開かない。外して 0 枚になってもモードは続く）
                  if (selection.selecting) {
                    selection.select(key, { toggle: true, range: false });
                    return;
                  }
                  // PC: クリック = その 1 枚だけ・⌘ / Ctrl = 足す・外す・⇧ = 範囲。スマホ: 修飾キーを無視して、選んで 1 枚で開く
                  const compactTap = !isWideWindow();
                  selection.select(
                    key,
                    compactTap ? { toggle: false, range: false } : { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey },
                  );
                  if (compactTap) void openItem(item);
                }}
                onTileOpen={(key) => {
                  if (operationRef.current || batchBusy) return;
                  // 選択モードの間は、タップを続けても（ダブルタップが dblclick になっても）開かない
                  if (selection.selecting) return;
                  const item = items.find((candidate) => candidate.key === key);
                  if (!item) return;
                  selection.collapse();
                  void openItem(item);
                }}
                onTileKeyDown={(key, event) => {
                  if (operationRef.current || batchBusy) return;
                  if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                    event.preventDefault();
                    const item = items.find((candidate) => candidate.key === key);
                    if (item) {
                      selection.collapse();
                      void openItem(item);
                    }
                    return;
                  }
                  moveByArrow(key, event);
                }}
                onTileLongPress={
                  // スマホの「写真」だけ（長押しで選択モードに入って、その 1 枚を選ぶ）
                  !wide && place === "photos"
                    ? (key) => {
                        if (operationRef.current || batchBusy) return;
                        const item = items.find((candidate) => candidate.key === key);
                        if (!item || item.adding) return;
                        setExportSheetOpen(false);
                        // 選択モードの間の長押しは、ゆっくり押しただけ（1 回押したのと同じ。選んでいた写真を捨てない）
                        if (selection.selecting) selection.select(key, { toggle: true, range: false });
                        else selection.startSelecting(key);
                      }
                    : undefined
                }
              />
            ) : mobileEditorItem ? null : (
              <BrowserPhotoEditingLoupe
                opened={opened}
                opening={opening}
                openedVisible={openedVisible}
                onPreviewLoaded={open.onPreviewLoaded}
                onPreviewFailed={open.onPreviewFailed}
                previewGeneration={open.previewGeneration}
                previewAccurate={open.previewAccurate}
                compareOriginal={compareOriginal}
                presetPreviewName={presets.previewName}
                crop={
                  cropping && crop.source
                    ? {
                        geometry: crop.geometry,
                        source: crop.source,
                        liveAngle: crop.liveAngle,
                        disabled: controlsDisabled,
                        onCommit: crop.commit,
                    }
                    : null
                }
                cutout={
                  cutout.available
                    ? {
                        brushing: cutoutActive && cutout.canBrush,
                        transparent: cutout.transparent,
                        radius: cutout.brush.radius,
                        disabled: controlsDisabled || cutout.running || cutout.loading,
                        onLiveStroke: cutout.setLiveStroke,
                        onCommitStroke: cutout.commitStroke,
                      }
                    : null
                }
                // 修復（niho-photo#44）: 面が幾何なしの画を描き終えるまでブラシを受けない
                heal={
                  healing
                    ? {
                        disabled: controlsDisabled || !heal.ready || opened?.previewPending === true,
                        marks: heal.marks,
                        paintedMarks: heal.paintedMarks,
                        selectedId: heal.selectedId,
                        showMarks: heal.showMarks,
                        brush: heal.newBrush,
                        pointLimit: heal.pointLimit,
                        onCommitStroke: heal.addMark,
                        onSelect: heal.select,
                        onSourceChange: heal.changeSource,
                      }
                    : null
                }
                clipOverlay={clipOverlay}
                compare={
                  compareMode !== "off"
                    ? {
                        mode: compareMode,
                        // 狭い幅（PC の面のまま）は上下に並べる
                        direction: wide ? "row" : "column",
                        beforeCanvasRef: setCompareBeforeCanvas,
                        split: compareView.split,
                        onSplitChange: compareView.setSplit,
                      }
                    : null
                }
                maskOverlay={
                  toolValue === "mask" ? <BrowserPhotoEditingMaskLayer tool={maskTool} targetRef={canvasRef} /> : undefined
                }
                canvasRef={canvasRef}
                colorPicker={colorMixerAvailable ? {
                  active: colorPicking,
                  position: colorPickPosition,
                  onMove: setColorPickPosition,
                  onPick: pickColor,
                  onCancel: () => {
                    colorPickGenerationRef.current += 1;
                    setColorPicking(false);
                  },
                } : undefined}
                lockedReason={loupeLockedReason}
                sourceError={sourceError}
                onReload={selectedItem
                  ? () => void (opened?.input?.kind === "provisional" ? open.retryCanonical() : openItem(selectedItem, { reload: true }))
                  : null}
                favorite={!wide && !mobileEditorItem ? (shownFavoriteControl ?? null) : null}
              />
            )}
          </div>
          {filmstripVisible ? (
            <BrowserPhotoEditingFilmstrip
              items={gridItems}
              activeKey={selectedKey}
              onOpen={(key) => {
                if (operationRef.current || batchBusy) return;
                const item = items.find((candidate) => candidate.key === key);
                if (!item || item.adding) return;
                // 一覧のダブルクリックと同じ: その 1 枚だけにして 1 枚のまま開く（選択は、今の写真の保存を送り終えてから替わる）
                selection.collapse();
                return openItem(item);
              }}
              onArrowKey={(event) => moveByArrow(selectedKey, event)}
            />
          ) : null}
          <PhotoEditingDropOverlay state={add.fileDrop.overlay} />
        </div>
        {mobileEditorItem ? (
          // スマホの 1 枚の編集（全画面の層）。1 枚の表示（canvas）は同時に 1 つだけ置く: 上の面の代わりに、層の写真の面へ渡す
          <BrowserPhotoEditingMobileEditor
            onLayerRef={(element) => {
              mobileLayerRef.current = element;
            }}
            photoKey={mobileEditorItem.key}
            photo={
              <BrowserPhotoEditingLoupe
                opened={opened}
                opening={opening}
                openedVisible={openedVisible}
                onPreviewLoaded={open.onPreviewLoaded}
                onPreviewFailed={open.onPreviewFailed}
                previewGeneration={open.previewGeneration}
                previewAccurate={open.previewAccurate}
                compareOriginal={compareOriginal}
                presetPreviewName={null}
                crop={
                  cropping && crop.source
                    ? {
                        geometry: crop.geometry,
                        source: crop.source,
                        liveAngle: crop.liveAngle,
                        disabled: controlsDisabled,
                        onCommit: crop.commit,
                      }
                    : null
                }
                // スマホの層は上下に並べるだけ（分割は PC の面だけ）。拡大は同じ値を両方の画が読むので揃う
                compare={
                  compareMode !== "off"
                    ? {
                        mode: "side",
                        direction: "column",
                        beforeCanvasRef: setCompareBeforeCanvas,
                        split: compareView.split,
                        onSplitChange: compareView.setSplit,
                      }
                    : null
                }
                canvasRef={canvasRef}
                colorPicker={colorMixerAvailable ? {
                  active: colorPicking,
                  position: colorPickPosition,
                  onMove: setColorPickPosition,
                  onPick: pickColor,
                  onCancel: () => {
                    colorPickGenerationRef.current += 1;
                    setColorPicking(false);
                  },
                } : undefined}
                lockedReason={loupeLockedReason}
                sourceError={sourceError}
                onReload={selectedItem
                  ? () => void (opened?.input?.kind === "provisional" ? open.retryCanonical() : openItem(selectedItem, { reload: true }))
                  : null}
                // マスクの道具（niho-photo#93）: PC の 1 枚の面と同じ写真の上の操作（拡大に合わせて測り直す）
                maskOverlay={
                  toolValue === "mask" ? <BrowserPhotoEditingMaskLayer tool={maskTool} targetRef={canvasRef} /> : undefined
                }
                unclipped
              />
            }
            statusLine={
              <BrowserPhotoEditingStatusLine
                progressText={progressText}
                saveState={develop.saveState}
                onRetrySave={() => void develop.developSessionRef.current?.saver?.retry()}
                status={status}
                canAdd={canAdd}
                onRetryAdd={add.retryAdd}
                canStopAdd={macAdd?.busy === true}
                onStopAdd={macAdd?.stop ?? (() => undefined)}
                gridSourceError={null}
                // 一覧の準備中の枚数は出さない（この写真の準備の状態は、層がすぐ下の行に出す）
                pendingWorkText={null}
                showWideOnlyNote={false}
                recovery={recoveryControl}
              />
            }
            settings={settings}
            colorMixer={colorMixer ? <div className="px-3 pb-2">{colorMixer}</div> : undefined}
            // カラーミキサー（HSL。niho-photo#38）: 段 2 の wasm が画を描いている写真だけ（S1 の canvas には出さない）
            hslMixer={
              wasmPhotoKey !== null && !canvasOnly ? (
                <PhotoEditingHslMixer reset settings={settings} disabled={controlsDisabled} onSettingsChange={open.changeSettings} />
              ) : undefined
            }
            // カラーグレーディング（niho-photo#39）: カラーミキサーと同じ写真だけ。段の中では色相環を少し小さくする
            colorGrading={
              wasmPhotoKey !== null && !canvasOnly ? (
                <PhotoEditingColorGrading
                  reset
                  compact
                  settings={settings}
                  disabled={controlsDisabled}
                  onSettingsChange={open.changeSettings}
                />
              ) : undefined
            }
            colorPicking={colorPicking}
            visibleKeys={canvasOnly ? BROWSER_CANVAS_ADJUSTMENT_KEYS : browserMobileAdjustmentKeys({ detail: detailSupported })}
            presets={
              // PC の右パネルと同じ: S1 の canvas（段 2 を使えない）の写真には出さない。閲覧のみ・操作の途中は押せない
              canvasOnly
                ? undefined
                : {
                    spotId: props.spotId,
                    builtinPresets,
                    // 別の端末の補正を読み直している間は当てない（読み直した補正が入る）
                    canApply: presets.canApply && !staleReloading && !draftRecoveryPending,
                    appliedPresetKey: presets.appliedPresetKey,
                    applyingPresetKey: presets.applyingPresetKey,
                    applyError: presets.applyError,
                    onApply: (preset) => void presets.apply(preset),
                    canClear: presets.canClear && !staleReloading && !draftRecoveryPending,
                    onClear: presets.clear,
                    thumbnails: mobilePresetThumbnails,
                    amount: presetSupport.amount ? presets.amount : null,
                    amountDisabled:
                      !presets.canApply || staleReloading || draftRecoveryPending || presets.applyingPresetKey !== null,
                    onAmountChange: presets.changeAmount,
                  }
            }
            auto={
              auto.supported && !canvasOnly
                ? {
                    pressed: auto.pressed,
                    disabled: !auto.canToggle,
                    onToggle: auto.toggle,
                    onWarm: auto.warm,
                  }
                : undefined
            }
            crop={
              crop.available && !canvasOnly
                ? {
                    active: crop.active,
                    disabled: controlsDisabled,
                    geometry: crop.geometry,
                    source: crop.source,
                    liveAngle: crop.liveAngle,
                    exportLongEdge: crop.exportLongEdge,
                    enter: crop.enter,
                    leave: crop.leave,
                    commit: crop.commit,
                    reset: crop.reset,
                    setLiveAngle: crop.setLiveAngle,
                  }
                : undefined
            }
            // マスク（部分補正。niho-photo#93）: PC と同じ hook。「初期化」はマスクの道具の間はマスクだけを外す
            mask={
              maskTool.available
                ? {
                    active: maskTool.active,
                    edited: maskTool.masks.length > 0,
                    disabled: controlsDisabled,
                    enter: () => chooseTool("mask"),
                    leave: maskTool.leave,
                    band: (
                      <PhotoEditingMaskMobileTools
                        {...maskTool}
                        disabled={controlsDisabled}
                        canReset={canReset}
                        onReset={maskTool.reset}
                      />
                    ),
                  }
                : undefined
            }
            canEdit={props.canEdit}
            canCompare={editable && !cropping}
            compareView={
              compareAvailable
                ? { active: compareMode !== "off", onToggle: () => changeCompareView(compareMode === "off" ? "side" : "off") }
                : null
            }
            controlsDisabled={controlsDisabled}
            canReset={canReset}
            canUndo={open.canUndo}
            canRedo={open.canRedo}
            favorite={shownFavoriteControl}
            work={loupeWork}
            raw={isBrowserCloudRawPhoto(mobileEditorItem.photo)}
            busy={operation !== null}
            compareOriginal={compareOriginal}
            canExport={canExport}
            exportChoices={exportChoices}
            exporting={operation?.kind === "export"}
            exportReady={pendingShare !== null && pendingShare.key === mobileEditorItem.key}
            onBack={showGrid}
            onUndo={open.undo}
            onRedo={open.redo}
            onReset={toolValue === "mask" ? maskTool.reset : open.resetSettings}
            onRetryWork={() => void open.retryWork()}
            onSettingsChange={open.changeSettings}
            onCompareOriginalChange={open.setCompareOriginal}
            onExport={(format, saveRoute, size) =>
              runExport(format, { saveRoute, size, jpegRoute: exportChoices?.jpeg.route ?? null })
            }
            onSharePending={sharePending}
            onExportSheetOpened={() => setMobileExportSheetOpen(true)}
            onExportSheetClosed={() => {
              setMobileExportSheetOpen(false);
              clearPendingShare();
            }}
          />
        ) : null}

        {showAdjustments && !mobileEditorItem ? (
          <BrowserPhotoEditingAdjustments
            canEdit={props.canEdit}
            canReset={canReset}
            resetDone={open.resetDone && !cutoutActive && !healing && !cropBlocked}
            canUndo={cutoutActive ? cutout.canUndo : open.canUndo}
            canRedo={cutoutActive ? cutout.canRedo : open.canRedo}
            controlsDisabled={controlsDisabled || (cutoutActive && (cutout.running || cutout.loading))}
            busy={operation !== null}
            work={loupeWork}
            raw={loupeItem !== null && isBrowserCloudRawPhoto(loupeItem.photo)}
            settings={settings}
            colorMixer={colorMixer}
            // ライトの群の下の「カーブ」（niho-photo#37）とカラーの群の下の「カラーミキサー」（niho-photo#38）: ヒストグラムと同じく PC の
            // 右パネルで、段 2 の wasm が画を描いている写真だけ（S1 の canvas・スマホの層・閲覧の面には出さない）。カーブの背後の輝度は
            // ヒストグラムの度数を使う（数え直さない）。カラーミキサーの節の下に「カラーグレーディング」（niho-photo#39）を続け、
            // ポイントカラー（`colorMixer`）はその下に並ぶ
            afterGroup={
              histogramAvailable
                ? {
                    light: (
                      <PhotoEditingToneCurveSection
                        settings={settings}
                        histogram={histogram.histogram}
                        disabled={controlsDisabled}
                        onSettingsChange={open.changeSettings}
                      />
                    ),
                    color: (
                      <>
                        <PhotoEditingHslMixerSection
                          settings={settings}
                          disabled={controlsDisabled}
                          onSettingsChange={open.changeSettings}
                        />
                        <PhotoEditingColorGradingSection
                          settings={settings}
                          disabled={controlsDisabled}
                          onSettingsChange={open.changeSettings}
                        />
                      </>
                    ),
                    ...(lensSupported
                      ? {
                          effects: (
                            <PhotoEditingLensSection
                              settings={settings}
                              disabled={controlsDisabled}
                              profile={lensProfile}
                              onSettingsChange={open.changeSettings}
                            />
                          ),
                        }
                      : {}),
                  }
                : undefined
            }
            histogram={
              histogramAvailable ? (
                <PhotoEditingHistogram
                  data={histogram.histogram}
                  clip={histogram.clip}
                  clipDisabled={clipUnavailable}
                  onToggleShadows={histogram.toggleShadows}
                  onToggleHighlights={histogram.toggleHighlights}
                />
              ) : undefined
            }
            visibleKeys={visibleAdjustmentKeys}
            // 口のある wasm と分かってから出す（確かめている間・無い wasm・S1 の canvas の写真には出さない）
            auto={
              auto.supported && !canvasOnly
                ? { pressed: auto.pressed, disabled: !auto.canToggle, onToggle: auto.toggle, onWarm: auto.warm }
                : undefined
            }
            presets={
              // S1 の canvas（段 2 を使えない）の写真・狭い幅には出さない（`presetsAvailable`）。作業コピーを待っている間・閲覧のみ・
              // 操作の途中は押せない。補正の面の 1 行（row）とプリセットの面（panel）のどちらか一方だけを描く
              presetsAvailable
                ? (view) => (
                    <BrowserPhotoEditingPresets
                      spotId={props.spotId}
                      canEdit={props.canEdit}
                      builtinPresets={builtinPresets}
                      presets={presets}
                      // 別の端末の補正を読み直している間は当てない（読み直した補正が入る）
                      staleReloading={staleReloading || draftRecoveryPending}
                      mountedRef={mountedRef}
                      engineRef={develop.engineRef}
                      photoKey={wasmPhotoKey}
                      settings={settings}
                      dragging={open.dragging}
                      provisional={opened?.input?.kind === "provisional"}
                      support={presetSupport}
                      variant={view.variant}
                      onOpenPanel={view.onOpenPanel}
                      actionsSlot={view.actionsSlot}
                    />
                  )
                : undefined
            }
            tool={toolValue}
            panel={shownAdjustPanel}
            info={
              loupeItem ? (
                <BrowserPhotoEditingInfo photo={loupeItem.photo} infoAvailable={capabilities.info === true} />
              ) : undefined
            }
            versions={
              versionsShown && loupeItem ? (
                // 写真を替えたら、開いていた入力・確かめのダイアログを閉じる（ほかの写真の版に当てない）
                <BrowserPhotoEditingVersions
                  key={loupeItem.photo.id}
                  status={versions.status}
                  versions={versions.versions}
                  selectedId={versions.selectedId}
                  defaultName={versions.defaultName}
                  full={versions.full}
                  disabled={controlsDisabled}
                  manageDisabled={!props.canEdit}
                  saveFailed={versions.saveFailed}
                  thumbnails={versionThumbnails}
                  onCreate={versions.create}
                  onRename={versions.rename}
                  onDelete={versions.remove}
                  onSwitch={versions.switchTo}
                  onRetrySave={versions.retrySave}
                  onReload={versions.reload}
                />
              ) : undefined
            }
            onOpenPresets={() => setAdjustPanel("presets")}
            cropTools={
              cropping && crop.source ? (
                <PhotoEditingCropTools
                  geometry={crop.geometry}
                  source={crop.source}
                  disabled={controlsDisabled}
                  liveAngle={crop.liveAngle}
                  exportLongEdge={crop.exportLongEdge}
                  onLiveAngleChange={crop.setLiveAngle}
                  onCommit={crop.commit}
                  onDone={crop.leave}
                  onCancel={crop.cancel}
                  perspective={crop.perspective}
                  onGeometryChange={crop.changeGeometry}
                  upright={crop.upright}
                />
              ) : cropBlocked ? (
                <p className="pt-1 text-xs leading-relaxed text-niho-text-sub">{PHOTO_EDITING_CROP_BLOCKED_BY_CUTOUT_TEXT}</p>
              ) : undefined
            }
            cutoutTools={
              cutoutActive ? (
                <PhotoEditingCutoutTools
                  recipe={cutout.recipe}
                  running={cutout.running}
                  failureText={cutout.failureText}
                  maskFailed={cutout.maskFailed}
                  blockedByGeometry={cutout.blockedByGeometry}
                  disabled={controlsDisabled || cutout.loading}
                  brush={cutout.brush}
                  onRun={cutout.run}
                  onCancel={cutout.cancel}
                  onSelectSubject={cutout.selectSubject}
                  onBackgroundChange={cutout.setBackground}
                  onBrushModeChange={cutout.setBrushMode}
                  onBrushRadiusChange={cutout.setBrushRadius}
                  onRemove={cutout.remove}
                />
              ) : undefined
            }
            healTools={
              healing ? (
                <PhotoEditingHealTools
                  marks={heal.marks}
                  selectedId={heal.selectedId}
                  brush={heal.brush}
                  disabled={controlsDisabled}
                  canAdd={heal.canAdd}
                  showMarks={heal.showMarks}
                  hasGeometry={hasDevelopGeometry(settings)}
                  onModeChange={heal.setMode}
                  onRadiusChange={heal.setRadius}
                  onFeatherChange={heal.setFeather}
                  onSelect={heal.select}
                  onRemove={heal.remove}
                  onClear={heal.clear}
                  onShowMarksChange={heal.setShowMarks}
                />
              ) : undefined
            }
            maskTools={toolValue === "mask" ? <PhotoEditingMaskTools {...maskTool} disabled={controlsDisabled} /> : undefined}
            clipboard={
              // 別の端末の補正を読み直している間は当てない（読み直した補正が入る）。写すのは閲覧のみでもできる。切り抜き・背景除去・
              // 修復の道具の間は出さない（写す・当てるのは色の補正）
              canvasOnly || cropping || cutoutActive || healing || maskTool.active || cropBlocked
                ? undefined
                : {
                    canCopy: open.clipboard.canCopy && !staleReloading && !draftRecoveryPending,
                    canPaste: open.clipboard.canPaste && !staleReloading && !draftRecoveryPending,
                    onCopy: open.clipboard.copy,
                    onPaste: open.clipboard.paste,
                  }
            }
            onReset={cropping ? crop.reset : toolValue === "mask" ? maskTool.reset : open.resetSettings}
            onUndo={cutoutActive ? cutout.undo : open.undo}
            onRedo={cutoutActive ? cutout.redo : open.redo}
            onRetryWork={() => void open.retryWork()}
            onSettingsChange={open.changeSettings}
          />
        ) : null}
        {/* 右パネルの右の道具の帯（grid の 4 列目。押した道具で右パネルを丸ごと入れ替える） */}
        {showAdjustments && !mobileEditorItem ? <BrowserPhotoEditingToolRail items={toolRailItems} /> : null}

        <BrowserPhotoEditingFooter
          // 中央の列の下だけ（左の木・右パネル・道具の帯は 2 段を貫いて窓の底まで。Lightroom とモックの並び。niho-photo#49）
          className={props.treeHidden ? "lg:col-span-1 lg:col-start-1" : "lg:col-span-1 lg:col-start-2"}
          viewMode={viewMode}
          canOpenLoupe={selectedItem !== null && !selectedItem.adding && !selection.selecting && !batchBusy && operation === null}
          onShowGrid={showGrid}
          onShowLoupe={() => {
            if (operationRef.current || !selectedItem) return;
            selection.collapse();
            void openItem(selectedItem);
          }}
          statusLine={
            <BrowserPhotoEditingStatusLine
              progressText={progressText}
              saveState={develop.saveState}
              onRetrySave={() => void develop.developSessionRef.current?.saver?.retry()}
              status={
                staleReloading ? { kind: "notice", text: BROWSER_PHOTO_EDITING_DEVELOP_RELOADING_TEXT } : status
              }
              canAdd={canAdd}
              onRetryAdd={add.retryAdd}
              canStopAdd={macAdd?.busy === true}
              onStopAdd={macAdd?.stop ?? (() => undefined)}
              gridSourceError={viewMode === "grid" ? sourceError : null}
              pendingWorkText={pendingWorkText}
              showWideOnlyNote={viewMode === "loupe" && loupeLockedReason === null && !mobileEditing}
              recovery={recoveryControl}
            />
          }
          favorite={shownFavoriteControl}
          flag={flagControl}
          albumAction={selectedPhotoIds.length === 1 && albumsAvailable ? {
            label: currentAlbumId ? "アルバムから外す" : "アルバムに追加",
            disabled: !props.canEdit || batchBusy || operation !== null,
            onClick: () => currentAlbumId ? void removeSelectedFromCurrentAlbum() : setAlbumAddOpen(true),
          } : undefined}
          shareAction={props.cloudSharing && library.place === "cloud" ? {
            disabled:
              props.cloudSharing.access === "unavailable" ||
              selectedItem === null ||
              selectedItem.adding ||
              selection.count > 1 ||
              batchBusy ||
              operation !== null,
            onClick: () => setCloudShareSheetOpen(true),
          } : undefined}
          copyToCloudAction={props.copyToCloud && library.place === "local" && selectedItem && !selectedItem.adding && selection.count <= 1 ? {
            disabled: operation !== null || batchBusy || staleReloading || draftRecoveryPending,
            onClick: () => {
              if (copyRunRef.current || operationRef.current || !selectedItem || !props.copyToCloud) return;
              const binding = props.copyToCloud;
              const photoId = selectedItem.photo.id;
              const fileName = selectedItem.photo.fileName;
              const controller = new AbortController();
              copyRunRef.current = { controller };
              void confirmRouteLeave({ release: false }).then(async (canLeave) => {
                if (!canLeave || controller.signal.aborted || !mountedRef.current) return;
                operationRef.current = "copy";
                setOperation({ kind: "copy", fileName, deleting: false });
                try {
                  const result = await binding.copyLocalPhoto(photoId, {
                    signal: controller.signal,
                    onProgress: (fraction) => {
                      if (
                        controller.signal.aborted ||
                        !mountedRef.current ||
                        copyRunRef.current?.controller !== controller ||
                        operationRef.current !== "copy"
                      ) return;
                      const percent = fraction === null || !Number.isFinite(fraction)
                        ? null
                        : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
                      setOperation({
                        kind: "copy",
                        fileName,
                        deleting: false,
                        progressText: percent === null ? "クラウドにコピー中…" : `クラウドにコピー中… ${percent}%`,
                      });
                    },
                  });
                  if (controller.signal.aborted || !mountedRef.current) return;
                  const cloudPhotoId = result.cloudPhotoId;
                  setStatus({
                    kind: "notice",
                    text: "クラウドにコピーしました。",
                    ...(cloudPhotoId
                      ? { action: { label: "クラウドで開く", onClick: () => binding.onOpenCloudPhoto(cloudPhotoId) } }
                      : {}),
                  });
                } catch {
                  if (!controller.signal.aborted && mountedRef.current) {
                    setStatus({ kind: "error", text: "クラウドにコピーできませんでした。もう一度お試しください。" });
                  }
                } finally {
                  if (copyRunRef.current?.controller === controller) copyRunRef.current = null;
                  if (operationRef.current === "copy") operationRef.current = null;
                  if (mountedRef.current) setOperation((current) => current?.kind === "copy" ? null : current);
                }
              }).catch(() => {
                if (!controller.signal.aborted && mountedRef.current) {
                  setStatus({ kind: "error", text: "クラウドへコピーする前の保存を完了できませんでした。" });
                }
              }).finally(() => {
                if (operationRef.current !== "copy" && copyRunRef.current?.controller === controller) copyRunRef.current = null;
              });
            },
          } : undefined}
          showCompare={editable}
          // 切り抜き・背景除去の間・補正前と補正後を並べている間は補正前を見せない（押せない表示）
          compareDisabled={controlsDisabled || cropping || cutoutActive || healing || compareMode !== "off"}
          compareOriginal={compareOriginal}
          onCompareOriginalChange={open.setCompareOriginal}
          // 「比較」（niho-photo#41）: 並べる（左右）/ 分割 / 比較しない
          compareView={
            editable
              ? { mode: compareMode, disabled: controlsDisabled || !compareAvailable, onChange: changeCompareView }
              : undefined
          }
          exportButtonRef={exportButtonRef}
          exportSheetOpen={exportSheetOpen && !mobileBatchExport}
          exportButtonExpanded={exportSheetOpen}
          canExport={canExport}
          exportChoices={exportChoices}
          onToggleExportSheet={() => setExportSheetOpen((isOpen) => !isOpen)}
          onExport={(format, size) =>
            void runExport(format, {
              size,
              jpegRoute: exportChoices ? browserPhotoExportJpegRoute(exportChoices, size) : null,
              cutout: exportChoices?.cutout ? cutoutExport : null,
            })
          }
          onCloseExportSheet={closeExportSheet}
        />
        {mobileBatchExport && exportSheetOpen && mobileBatchExportChoices ? (
          <BrowserPhotoMobileExportSheet
            fixed
            count={selectedItems.length}
            choices={mobileBatchExportChoices}
            exporting={operation?.kind === "export"}
            ready={pendingShare?.key === batchExportKey}
            onExport={(format, saveRoute, size) =>
              format === "jpeg"
                ? runMobileBatchExport({ size, saveRoute, jpegRoutes: batchJpegRoutes })
                : Promise.resolve("skipped")
            }
            onSharePending={sharePending}
            onClose={closeBatchExportSheet}
          />
        ) : null}
      </div>
      <BrowserPhotoAlbumEditorDialog
        request={albumEditorRequest}
        onOpenChange={(open) => { if (!open) setAlbumEditorRequest(null); }}
        onCreate={albumLibrary.createAlbum}
        onCreated={(album) => void selectPlace(browserCloudAlbumPlace(album.id))}
        onRename={albumLibrary.renameAlbum}
        onDelete={deleteAlbum}
      />
      <BrowserPhotoAlbumAddDialog
        open={albumAddOpen}
        albums={albumLibrary.albums}
        albumsPending={albumLibrary.isPending}
        albumsError={albumLibrary.isError}
        onRetryAlbums={() => { void albumLibrary.refetch(); }}
        selectedCount={selectedPhotoIds.length}
        onOpenChange={setAlbumAddOpen}
        onAdd={addSelectedToAlbum}
        onCreate={albumLibrary.createAlbum}
      />
      {cloudShareSheetOpen && props.cloudSharing && selectedItem && !selectedItem.adding ? (
        <BrowserPhotoCloudShareSheet
          binding={props.cloudSharing}
          photoId={selectedItem.photo.id}
          onClose={() => setCloudShareSheetOpen(false)}
        />
      ) : null}
    </section>
  );
}
