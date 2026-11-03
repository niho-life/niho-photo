"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";

import { Skeleton } from "niho-ui/components/skeleton";
import { Spinner } from "niho-ui/components/spinner";
import { photoEditingTileGeometryStyles } from "../photo-editing-tile-geometry";
import type { PhotoEditingThumbnail } from "../photo-editing-thumbnail";
import { cn } from "niho-ui/cn";

import { CloudPhotoMark } from "./photo-editing-cloud-photo-mark";
import { usePhotoEditingImageCors } from "./photo-editing-image-cors";

/** グリッドのタイル 1 枚分。`key` は場所ごとの写真の ID（クラウドの写真の ID・フォルダの entryId・開いた写真の photoId） */
export type PhotoEditingGridItem = {
  key: string;
  fileName: string;
  /**
   * サムネイル（クラウドは一覧の `previewUrl`、フォルダと v16〜の「追加した写真」は Desktop のサムネイル、v15 以前の
   * 「追加した写真」は render(128)）
   */
  thumbnail: PhotoEditingThumbnail;
  raw: boolean;
  /** この Mac の写真のうち、中身の同じクラウドの写真があるもの（クラウドのグリッドの中では付けない） */
  cloud: boolean;
  /** 開いている途中（フォルダの写真を選んだとき）。タイルに Spinner を重ねる */
  opening?: boolean;
  /**
   * クラウドへ追加している途中（ブラウザ版の「写真を追加」、移行元設計）。タイルに薄い幕と回転を重ね、送った割合が分かれば下端に
   * 細い帯で出す。上げ終わるまで押せない（Desktop 版は渡さない）
   */
  adding?: { fraction: number | null };
  /**
   * サムネイルに CSS で当てる幾何（`developSettings.geometry`。回転・反転・角度補正・切り抜き。移行元設計）。補正前のプレビューを
   * 出すときだけ渡す（補正後の画は切り抜き済みなので渡さない）。無ければそのまま出す
   */
  geometry?: Record<string, unknown> | null;
};

/**
 * タイルのサムネイル。署名付き URL・blob: の画像をそのまま出す（next/image の最適化の対象外）。セルいっぱいに切り抜く。幾何が
 * あれば、読み込んだ画像の実寸（向きを反映した大きさ）から CSS で回転・反転・角度補正・切り抜きを当てる（移行元設計。表示だけ）。
 * 実寸が分かるまでは透明にして、切り抜く前の画を一瞬も見せない。`cellAspect` はセルの縦横比（幅 / 高さ。既定は 4:3。ブラウザ版の
 * 狭い幅の正方形のタイルは 1）。
 */
export function PhotoEditingTileImage({
  url,
  geometry,
  cellAspect,
}: {
  url: string;
  geometry: Record<string, unknown> | null;
  cellAspect?: number;
}) {
  const useCorsForPhotos = usePhotoEditingImageCors();
  // 読んだ画像の実寸（どの URL の画像か一緒に持つ。URL が替わったら前の画像の実寸は使わない）
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number } | null>(null);
  const size = measured && measured.url === url ? measured : null;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const styles = geometry && size ? photoEditingTileGeometryStyles(geometry, size.width, size.height, cellAspect) : null;
  // 幾何が後から付いた（1 枚で回転・切り抜きを確定した直後の帯のタイルなど）とき、画像はもう読み込み済みで `load` は二度と来ない。
  // `onLoad` だけに頼ると実寸が分からないまま透明で残り、タイルが空白になるので、読み込み済みならここで実寸を読む
  useEffect(() => {
    if (!geometry || size) return;
    const element = imageRef.current;
    if (element && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0) {
      setMeasured({ url, width: element.naturalWidth, height: element.naturalHeight });
    }
  }, [geometry, size, url]);
  const image = (style?: CSSProperties, className?: string) => (
    <img
      ref={imageRef}
      crossOrigin={useCorsForPhotos ? "anonymous" : undefined}
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      className={className}
      style={style}
      onLoad={
        geometry
          ? (event) =>
              setMeasured({ url, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
          : undefined
      }
    />
  );
  if (styles) return <span style={styles.box}>{image(styles.image)}</span>;
  return image(geometry && !size ? { opacity: 0 } : undefined, "h-full w-full object-cover");
}

/** 下まで見たら続きを読む（クラウドの一覧） */
export type PhotoEditingGridMore = {
  hasMore: boolean;
  loading: boolean;
  /** 続きを読めなかったときの 1 行（読めていれば null） */
  failedMessage: string | null;
  onLoad: () => void;
};

/** 読み込み中に並べるタイルの数 */
const SKELETON_TILE_COUNT = 8;
/** 続きを読み始める、一番下からの距離（px） */
const LOAD_MORE_MARGIN_PX = 240;

/**
 * グリッドの 1 行に並んでいるタイルの数（↑↓ で移る数）。並びの見た目（タイルの縦の位置）から数え、幅から計算しない。
 */
export function countPhotoEditingGridColumns(list: HTMLElement | null): number {
  const tiles = list ? (Array.from(list.children) as HTMLElement[]) : [];
  if (tiles.length < 2) return 1;
  const top = tiles[0].offsetTop;
  let columns = 1;
  while (columns < tiles.length && tiles[columns].offsetTop === top) columns += 1;
  return columns;
}

/**
 * 中央のグリッド（一覧、移行元設計・モック `idea/mock/photo-editing-cloud-grid-v1.html`）。選んでいる場所（クラウド・
 * 「追加した写真」・フォルダ）の写真を 4:3 のタイル（セルいっぱいに切り抜いたサムネイル・ファイル名・RAW の印）で並べ、
 * どれを使うかをサムネイルで選べるようにする。選んでいる写真は緑の枠と印。この Mac の写真のうち中身の同じクラウドの
 * 写真があるものには雲の印を付け、クラウドの中で元の写真が無い写真には「元の写真なし」の印を付ける（雲の印と同じ右下。
 * クラウドの中では雲の印を付けないので重ならない。ブラウザ版は印を渡さず RAW の印だけ、追加している途中の写真には追加中の
 * 印を重ねる。移行元設計）。選び方（クリック・⌘ / Shift・キーボード）と 1 枚への切り替えは画面が
 * 決め、ここは押されたことを伝えるだけ。出した直後は表示中の写真が見える位置まで送る。
 */
export function PhotoEditingGrid(props: {
  items: readonly PhotoEditingGridItem[];
  selectedKeys: ReadonlySet<string>;
  /** 表示中の写真（出した直後に見える位置へ送る） */
  activeKey: string | null;
  /** 最初のページを読んでいる（タイルの形の仮の面を並べる） */
  loading?: boolean;
  /**
   * 右上の 1 行（クラウドの使用量と、写真を選んでいるときの「クラウドから消す」）。一覧を下へ送っても上に残す。無ければ
   * 出さない
   */
  meta?: ReactNode;
  /** 写真が無いときに中央に出すもの（空状態・読めなかったとき） */
  placeholder?: ReactNode;
  more?: PhotoEditingGridMore;
  /** タイルを並べた list（↑↓ で移る数を数える） */
  listRef: MutableRefObject<HTMLUListElement | null>;
  tileRef: (key: string, element: HTMLButtonElement | null) => void;
  onTileClick: (key: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** ダブルクリック（1 枚で出す） */
  onTileOpen: (key: string) => void;
  onTileKeyDown: (key: string, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const tilesRef = useRef(new Map<string, HTMLButtonElement>());
  const initialActiveKeyRef = useRef(props.activeKey);

  // 出した直後（1 枚から戻った・場所を切り替えた）は、表示中の写真が見える位置まで送る
  useEffect(() => {
    const key = initialActiveKeyRef.current;
    const tile = key === null ? undefined : tilesRef.current.get(key);
    if (tile && typeof tile.scrollIntoView === "function") tile.scrollIntoView({ block: "nearest" });
  }, []);

  // 下まで見たら続きを読む。読み足しても一番下が見えたままなら、続けて読む（見張り直すと 1 回呼ばれる）
  const hasMore = props.more?.hasMore === true;
  const loadingMore = props.more?.loading === true;
  const loadMoreFailedMessage = props.more?.failedMessage ?? null;
  const loadMoreFailed = loadMoreFailedMessage !== null;
  const onLoadMoreRef = useRef(props.more?.onLoad);
  onLoadMoreRef.current = props.more?.onLoad;
  const itemCount = props.items.length;
  useEffect(() => {
    const root = scrollRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasMore || loadingMore || loadMoreFailed) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current?.();
      },
      { root, rootMargin: `0px 0px ${LOAD_MORE_MARGIN_PX}px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, itemCount, loadMoreFailed, loadingMore]);

  const empty = !props.loading && props.items.length === 0;
  const showMeta = Boolean(props.meta) && !empty;

  return (
    <section
      ref={scrollRef}
      aria-label="写真の一覧"
      aria-busy={props.loading || loadingMore ? true : undefined}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-y-auto px-[18px] pb-[18px] pt-2.5 [scrollbar-width:thin]",
        // 上に残る右上の行の下にタイルが来るように送る（出した直後の scrollIntoView・キーボードで移ったときのフォーカス）
        showMeta && "scroll-pt-12",
      )}
    >
      {showMeta ? (
        // 一覧を下へ送っても上に残す（下のほうの写真を選んでも「クラウドから消す」が見えて押せるように。移行元設計）。
        // 上の余白（pt-2.5）の分も白で覆い、送ったタイルが行の上に透けないようにする。高さはボタン（32px）に合わせて
        // 固定し、写真を選んでボタンが出ても一覧を動かさない
        <div className="sticky -top-2.5 z-10 -mt-2.5 mb-1.5 box-content flex h-8 shrink-0 items-center justify-end gap-3 bg-[var(--photo-editing-surface,white)] pt-2.5 text-xs font-bold tabular-nums text-niho-text-muted">
          {props.meta}
        </div>
      ) : null}
      {props.loading ? (
        <ul aria-hidden className="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-x-3 gap-y-3.5">
          {Array.from({ length: SKELETON_TILE_COUNT }, (_, index) => (
            <li key={index}>
              <Skeleton className="aspect-[4/3] rounded-[10px]" />
              <Skeleton className="mt-[5px] h-3 w-3/4" />
            </li>
          ))}
        </ul>
      ) : empty ? (
        <div className="m-auto flex items-center justify-center p-6">{props.placeholder}</div>
      ) : (
        <ul
          ref={props.listRef}
          className="grid shrink-0 select-none grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-x-3 gap-y-3.5 pb-2"
        >
          {props.items.map((item) => {
            const selected = props.selectedKeys.has(item.key);
            const { thumbnail } = item;
            return (
              <li key={item.key} className="min-w-0">
                <button
                  ref={(element) => {
                    if (element) tilesRef.current.set(item.key, element);
                    else tilesRef.current.delete(item.key);
                    props.tileRef(item.key, element);
                  }}
                  type="button"
                  aria-pressed={selected}
                  disabled={item.adding !== undefined}
                  title={item.fileName}
                  onClick={(event) => props.onTileClick(item.key, event)}
                  onDoubleClick={() => props.onTileOpen(item.key)}
                  onKeyDown={(event) => props.onTileKeyDown(item.key, event)}
                  className="group flex w-full min-w-0 flex-col gap-[5px] rounded-[10px] text-left focus-visible:outline-none"
                >
                  {/* 読み上げは写真名（と雲の印）の順。見た目ではタイルの下に置く */}
                  <span
                    className={cn(
                      "order-last block truncate px-0.5 text-xs font-bold leading-[15px] tabular-nums",
                      selected ? "text-niho-accent-ink" : "text-niho-text-muted",
                    )}
                  >
                    {item.fileName}
                  </span>
                  <span
                    className={cn(
                      "relative block aspect-[4/3] w-full overflow-hidden rounded-[10px] bg-[#F1EEE6] outline outline-2 outline-offset-2 outline-transparent motion-safe:transition-[box-shadow,outline-color]",
                      selected
                        ? "ring-2 ring-niho-accent-ink ring-offset-2"
                        : "group-hover:shadow-[0_0_0_1px_#DDD8CC]",
                      "group-focus-visible:outline-niho-text-sub",
                    )}
                  >
                    {thumbnail.url ? (
                      <PhotoEditingTileImage key={thumbnail.url} url={thumbnail.url} geometry={item.geometry ?? null} />
                    ) : thumbnail.failed ? (
                      <span
                        aria-hidden
                        className="flex h-full w-full items-center justify-center text-xl font-bold text-niho-text-muted"
                      >
                        {Array.from(item.fileName)[0] ?? ""}
                      </span>
                    ) : null}
                    {item.raw ? (
                      // 読み上げはファイル名（拡張子）と重なるので読ませない
                      <span
                        aria-hidden
                        className="absolute bottom-[5px] left-[5px] rounded bg-black/60 px-1 text-[9px] font-bold leading-[14px] tracking-[0.05em] text-white"
                      >
                        RAW
                      </span>
                    ) : null}
                    {item.cloud ? (
                      <span className="absolute bottom-[5px] right-[5px] flex h-[18px] w-[18px] items-center justify-center rounded-md bg-black/60 text-white">
                        <CloudPhotoMark className="h-3 w-3" />
                      </span>
                    ) : null}
                    {selected ? (
                      <span
                        aria-hidden
                        className="niho-accent-surface absolute right-1.5 top-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full shadow-sm"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      </span>
                    ) : null}
                    {item.opening ? (
                      <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-white/50">
                        <Spinner size="sm" />
                      </span>
                    ) : null}
                    {item.adding ? (
                      <span className="absolute inset-0 flex items-center justify-center bg-white/55">
                        <Spinner size="md" />
                        <span className="sr-only">追加中</span>
                        {item.adding.fraction !== null ? (
                          <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-niho-accent-soft">
                            <span
                              className="block h-full bg-niho-accent-ink motion-safe:transition-[width]"
                              style={{ width: `${Math.round(Math.min(1, Math.max(0, item.adding.fraction)) * 100)}%` }}
                            />
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />
      {loadingMore ? (
        <div className="flex shrink-0 justify-center py-4">
          <Spinner size="md" label="続きを読み込み中" />
        </div>
      ) : null}
      {loadMoreFailed ? (
        <div role="alert" className="shrink-0 py-3 text-center text-xs leading-relaxed text-[#8C3425]">
          {loadMoreFailedMessage}
          <button
            type="button"
            onClick={() => onLoadMoreRef.current?.()}
            className="ml-2 font-bold text-niho-text-sub underline"
          >
            再読み込み
          </button>
        </div>
      ) : null}
    </section>
  );
}
