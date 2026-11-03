"use client";

import type { ReactNode } from "react";
import { Cloud, FileText, Folder, FolderPlus, Heart, Images, MoreHorizontal, type LucideIcon } from "lucide-react";

import type { PhotoLibraryAlbum, PhotoLibraryFolder } from "../library/photo-library";
import {
  browserCloudAlbumPlace,
  browserCloudPlaceAlbumId,
  browserPlaceFolderId,
  type BrowserCloudPlace,
} from "../browser-photo-cloud-source";
import { PHOTO_EDITING_FOLDER_FALLBACK_LABEL, PHOTO_EDITING_SELECTED_PHOTOS_LABEL } from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import { findPhotoLibraryFolder } from "./use-browser-photo-folders";
import { usePhotoEditingImageCors } from "./photo-editing-image-cors";

/**
 * ブラウザ版の左の木（「クラウド」の下に「写真」「お気に入り」「記事の画像」）と、狭い幅でその代わりに出す上段の切り替え。件数は
 * サーバーが数えた全件（読むまでは出さない）。「お気に入り」は 0 件でも出す（F5b 移行元設計）。「記事の画像」は最後に置き、0 件なら
 * 出さない（写真ライブラリは汎用で、記事は反映先の 1 つ。Epic 移行元設計 の決めごと 9・移行元設計）。見ている最中に 0 件になっても、
 * 見ている間は残す。場所を足すときは {@link PLACE_NODES} に足す（並びもこの順）。
 */

/** 木の件数（サーバーの最初のページの値。読むまでは null）。 */
export type BrowserPhotoTreeCounts = { photos: number; favorites: number; articleImages: number } | null;

const PLACE_NODES: readonly {
  place: Exclude<BrowserCloudPlace, "selected" | `album:${string}` | `folder:${string}`>;
  label: string;
  Icon: LucideIcon;
}[] = [
  { place: "photos", label: "写真", Icon: Images },
  { place: "favorites", label: "お気に入り", Icon: Heart },
  { place: "articleImages", label: "記事の画像", Icon: FileText },
];

/** 場所の名前（木・パンくず）。 */
export type BrowserPhotoAlbumSummary = Pick<PhotoLibraryAlbum, "id" | "name" | "photoCount" | "cover">;

/** 場所の名前（木・パンくず）。この Mac のフォルダは木（`folders`）の中の名前（見つからなければ「フォルダ」）。 */
export function browserPhotoPlaceLabel(
  place: BrowserCloudPlace,
  albums: readonly BrowserPhotoAlbumSummary[] = [],
  folders: readonly PhotoLibraryFolder[] = [],
): string {
  if (place === "selected") return PHOTO_EDITING_SELECTED_PHOTOS_LABEL;
  const folderId = browserPlaceFolderId(place);
  if (folderId) return findPhotoLibraryFolder(folders, folderId)?.name ?? PHOTO_EDITING_FOLDER_FALLBACK_LABEL;
  const albumId = browserCloudPlaceAlbumId(place);
  if (albumId) return albums.find((album) => album.id === albumId)?.name ?? "アルバム";
  return PLACE_NODES.find((node) => node.place === place)?.label ?? "";
}

/** 木に出す場所（「記事の画像」は 1 件以上あるか、見ている間だけ）。 */
export function visibleBrowserPhotoPlaces(place: BrowserCloudPlace, counts: BrowserPhotoTreeCounts): BrowserCloudPlace[] {
  return PLACE_NODES.filter(
    (node) => node.place !== "articleImages" || place === "articleImages" || (counts !== null && counts.articleImages > 0),
  ).map((node) => node.place);
}

/**
 * 「＋」（写真を追加）を出す場所。追加した写真は「写真」に入るので、「お気に入り」から追加しても「写真」へ移ってから入れる
 * （`useBrowserPhotoAdd`）。
 */
function showsAddButton(place: BrowserCloudPlace): boolean {
  return place === "photos" || place === "favorites";
}

type PlaceProps = {
  /** PC の木の底に出す 1 行（NIHO photo の「版」。木だけ。狭い幅の上段には出さない） */
  footer?: ReactNode;
  place: BrowserCloudPlace;
  counts: BrowserPhotoTreeCounts;
  albums?: readonly BrowserPhotoAlbumSummary[];
  albumsPending?: boolean;
  albumsError?: boolean;
  addButton: ReactNode;
  selectButton?: ReactNode;
  onSelectPlace: (place: BrowserCloudPlace) => void;
  onCreateAlbum?: () => void;
  onManageAlbum?: (album: BrowserPhotoAlbumSummary) => void;
  onRetryAlbums?: () => void;
};

function AlbumCover({ album }: { album: BrowserPhotoAlbumSummary }) {
  const useCorsForPhotos = usePhotoEditingImageCors();
  return album.cover?.imageUrl ? (
    // アルバム名を隣で読み上げるので表紙は装飾。
    <img crossOrigin={useCorsForPhotos ? "anonymous" : undefined} src={album.cover.imageUrl} alt="" className="h-7 w-7 shrink-0 rounded-lg object-cover" />
  ) : (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-niho-pale/60">
      <Folder className="h-4 w-4" aria-hidden />
    </span>
  );
}

/**
 * 狭い幅（1024px 未満）の上段。1 行のまま、「お気に入り」は ♥ だけのチップ（読み上げ名「お気に入り」）。「写真」「お気に入り」を
 * 見ている間は右端に「＋」（並びの切り替えは一覧の上の行。移行元設計）と、その左に複数選択に入る「選択」（`selectButton`。出せるときだけ。
 * F5a-2 移行元設計）。
 */
export function BrowserPhotoEditingPlaceTabs(props: PlaceProps) {
  const visible = visibleBrowserPhotoPlaces(props.place, props.counts);
  const albums = props.albums ?? [];
  const currentAlbum = albums.find((album) => album.id === browserCloudPlaceAlbumId(props.place));
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-1 border-b border-niho-border px-2 lg:hidden">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain pb-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {PLACE_NODES.filter((node) => node.place !== "articleImages" && visible.includes(node.place)).map(({ place: value, label, Icon }) => {
        const iconOnly = value === "favorites";
        return (
          <button
            key={value}
            type="button"
            aria-current={props.place === value ? "true" : undefined}
            aria-label={iconOnly ? label : undefined}
            title={iconOnly ? label : undefined}
            onClick={() => props.onSelectPlace(value)}
            className={cn(
              "min-h-11 shrink-0 rounded-full text-sub font-bold",
              iconOnly ? "flex w-11 items-center justify-center" : "px-3",
              props.place === value ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-sub",
            )}
          >
            {iconOnly ? <Icon className="h-[18px] w-[18px]" aria-hidden /> : label}
          </button>
        );
      })}
      {albums.map((album) => {
        const value = browserCloudAlbumPlace(album.id);
        return (
          <button
            key={album.id}
            type="button"
            aria-current={props.place === value ? "true" : undefined}
            onClick={() => props.onSelectPlace(value)}
            className={cn(
              "flex min-h-11 max-w-40 shrink-0 items-center gap-1.5 rounded-full px-3 text-sub font-bold",
              props.place === value ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-sub",
            )}
          >
            <Folder className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{album.name}</span>
            <span className="tabular-nums text-xs">{album.photoCount}</span>
          </button>
        );
      })}
      {props.albumsPending ? (
        <span className="flex min-h-11 shrink-0 items-center px-3 text-xs text-niho-text-muted">アルバムを読み込み中…</span>
      ) : null}
      {props.albumsError && props.onRetryAlbums ? (
        <button
          type="button"
          onClick={props.onRetryAlbums}
          className="min-h-11 shrink-0 rounded-full px-3 text-xs font-bold text-niho-danger"
        >
          アルバムを再読込
        </button>
      ) : null}
      {props.onCreateAlbum ? (
        <button
          type="button"
          aria-label="アルバムを作成"
          title="アルバムを作成"
          onClick={props.onCreateAlbum}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-accent-ink"
        >
          <FolderPlus className="h-5 w-5" aria-hidden />
        </button>
      ) : null}
      {PLACE_NODES.filter((node) => node.place === "articleImages" && visible.includes(node.place)).map(
        ({ place: value, label, Icon }) => (
          <button
            key={value}
            type="button"
            aria-current={props.place === value ? "true" : undefined}
            onClick={() => props.onSelectPlace(value)}
            className={cn(
              "min-h-11 shrink-0 rounded-full px-3 text-sub font-bold",
              props.place === value ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-sub",
            )}
          >
            <span className="inline-flex items-center gap-1.5"><Icon className="h-4 w-4" aria-hidden />{label}</span>
          </button>
        ),
      )}
      </div>
      {currentAlbum && props.onManageAlbum ? (
        <button
          type="button"
          aria-label={`${currentAlbum.name}を編集`}
          title={`${currentAlbum.name}を編集`}
          onClick={() => props.onManageAlbum?.(currentAlbum)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
        </button>
      ) : null}
      {props.selectButton || showsAddButton(props.place) ? (
        <div className="flex shrink-0 items-center">
          {props.selectButton}
          {showsAddButton(props.place) ? props.addButton : null}
        </div>
      ) : null}
    </div>
  );
}

/** 左の木。件数はサーバーの全件。「写真」「お気に入り」を見ている間は見出しに「＋」。 */
export function BrowserPhotoEditingTree(props: PlaceProps) {
  const visible = visibleBrowserPhotoPlaces(props.place, props.counts);
  const albums = props.albums ?? [];
  return (
    <aside aria-label="写真の場所" className="hidden min-h-0 flex-col overflow-y-auto border-r border-niho-border bg-[var(--photo-editing-surface,white)] p-3 lg:row-span-2 lg:flex">
      <div className="mb-1 flex min-h-11 items-center justify-between gap-2 px-1">
        <h3 className="text-sub font-bold text-niho-text">写真</h3>
        {showsAddButton(props.place) ? props.addButton : null}
      </div>
      <p className="flex min-h-9 items-center gap-2 px-3 text-sub font-bold text-niho-text-sub">
        <Cloud className="h-4 w-4 text-niho-text-muted" aria-hidden />
        クラウド
      </p>
      <ul className="space-y-1 pl-3.5">
        {PLACE_NODES.filter((node) => node.place !== "articleImages" && visible.includes(node.place)).map(({ place: value, label, Icon }) => {
          const count = props.counts === null ? null : props.counts[value];
          return (
            <li key={value}>
              <button
                type="button"
                aria-current={props.place === value ? "true" : undefined}
                onClick={() => props.onSelectPlace(value)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sub font-bold",
                  props.place === value ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text hover:bg-niho-pale/60",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="tabular-nums text-xs">{count || ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex min-h-9 items-center justify-between gap-2 pl-3.5 pr-1">
        <p className="px-3 text-sub font-bold text-niho-text-sub">アルバム</p>
        {props.onCreateAlbum ? (
          <button
            type="button"
            aria-label="アルバムを作成"
            title="アルバムを作成"
            onClick={props.onCreateAlbum}
            className="flex h-9 w-9 items-center justify-center rounded-full text-niho-accent-ink"
          >
            <FolderPlus className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {props.albumsPending ? <p className="px-6 py-2 text-xs text-niho-text-muted">読み込み中…</p> : null}
      {props.albumsError ? (
        <div className="space-y-1 px-6 py-2 text-xs text-niho-danger">
          <p>アルバムを読み込めませんでした。</p>
          {props.onRetryAlbums ? <button type="button" onClick={props.onRetryAlbums} className="min-h-11 font-bold underline">もう一度読み込む</button> : null}
        </div>
      ) : null}
      {!props.albumsPending && !props.albumsError ? (
        <ul className="space-y-1 pl-3.5">
          {albums.map((album) => {
            const value = browserCloudAlbumPlace(album.id);
            return (
              <li key={album.id} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  aria-current={props.place === value ? "true" : undefined}
                  onClick={() => props.onSelectPlace(value)}
                  className={cn(
                    "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 text-left text-sub font-bold",
                    props.place === value ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text hover:bg-niho-pale/60",
                  )}
                >
                  <AlbumCover album={album} />
                  <span className="min-w-0 flex-1 truncate">{album.name}</span>
                  <span className="tabular-nums text-xs">{album.photoCount}</span>
                </button>
                {props.onManageAlbum ? (
                  <button
                    type="button"
                    aria-label={`${album.name}を編集`}
                    title={`${album.name}を編集`}
                    onClick={() => props.onManageAlbum?.(album)}
                    className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-muted hover:text-niho-text"
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
          {albums.length === 0 ? <li className="px-3 py-2 text-xs text-niho-text-muted">まだありません</li> : null}
        </ul>
      ) : null}
      <ul className="mt-2 space-y-1 pl-3.5">
        {PLACE_NODES.filter((node) => node.place === "articleImages" && visible.includes(node.place)).map(({ place: value, label, Icon }) => {
          const count = props.counts === null ? null : props.counts.articleImages;
          return (
            <li key={value}>
              <button type="button" aria-current={props.place === value ? "true" : undefined} onClick={() => props.onSelectPlace(value)} className={cn("flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sub font-bold", props.place === value ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text hover:bg-niho-pale/60")}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="tabular-nums text-xs">{count || ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {props.footer ? (
        <div className="sticky bottom-0 -mx-3 -mb-3 mt-auto border-t border-niho-border bg-[var(--photo-editing-surface,white)] px-3 py-2 text-xs text-niho-text-muted">
          {props.footer}
        </div>
      ) : null}
    </aside>
  );
}
