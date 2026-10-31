"use client";

import { useId } from "react";
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";

import type { PhotoLibrary, PhotoLibraryItem, PhotoLibraryPhotoInfo } from "../library/photo-library";
import { usePhotoLibrary } from "../library/photo-library-context";
import { photoEditingInfoGroups, photoInfoEv100, type PhotoEditingInfoGroup } from "../photo-editing-info";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";

/**
 * 写真の情報の問い合わせ（{@link PhotoLibrary.info}）。右パネルの「情報」と空の検出の露出（niho-photo#141）が同じ鍵・同じ読み方を
 * 使う（どちらかが読んだ値をもう一方が使う）。読めなければ写真の行の項目だけを出す（やり直して待たせない）。
 */
export function browserPhotoInfoQueryOptions(library: PhotoLibrary, photo: Pick<PhotoLibraryItem, "id" | "contentSha256">) {
  return queryOptions({
    queryKey: photoEditingQueryKeys.photoInfo(library.place, photo.id, photo.contentSha256),
    queryFn: async ({ signal }): Promise<PhotoLibraryPhotoInfo | null> =>
      library.info ? ((await library.info(photo.id, { signal })) ?? null) : null,
    retry: false,
  });
}

/**
 * 空の検出の撮影時の露出（ISO 100 の EV。{@link photoInfoEv100}）。「情報」が読んだ値があればそれを、無ければ同じ問い合わせで読む。
 * 情報を読めない置き場・読めない・失敗・値が足りなければ null（写真の中の相対の明るさで探す）。
 */
export async function readBrowserPhotoEv100(
  queryClient: QueryClient,
  library: PhotoLibrary,
  photo: Pick<PhotoLibraryItem, "id" | "contentSha256">,
): Promise<number | null> {
  if (!library.info) return null;
  const options = browserPhotoInfoQueryOptions(library, photo);
  try {
    const cached = queryClient.getQueryData(options.queryKey);
    return photoInfoEv100(cached !== undefined ? cached : await queryClient.fetchQuery(options));
  } catch {
    return null;
  }
}

/**
 * 情報の群（niho-photo#43）。群ごとに見出しと、ラベルと値の 2 列（`dl`）。読み上げはラベルと値を続けて読む（「ISO 400」）。長い値
 * （レンズ・ファイル名）は折り返す。行の無い群は呼ぶ側が渡さない（{@link photoEditingInfoGroups}）。
 */
export function PhotoEditingInfoList(props: { groups: ReadonlyArray<PhotoEditingInfoGroup> }) {
  return (
    <div className="space-y-3 pb-2 pt-1">
      {props.groups.map((group) => (
        <PhotoEditingInfoGroupSection key={group.key} group={group} />
      ))}
    </div>
  );
}

function PhotoEditingInfoGroupSection(props: { group: PhotoEditingInfoGroup }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="pb-1 text-xs font-bold text-niho-text-muted">
        {props.group.title}
      </h3>
      <dl className="space-y-1">
        {props.group.rows.map((row) => (
          <div key={row.key} className="flex gap-2 text-xs leading-relaxed">
            <dt className="w-24 shrink-0 text-niho-text-sub">{row.label}</dt>
            <dd className="min-w-0 flex-1 font-medium text-niho-text [overflow-wrap:anywhere]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 右パネルの「情報」の面の中身（niho-photo#43。Lightroom の「情報」）。写真の情報（{@link PhotoLibrary.info}。`infoAvailable` の
 * ときだけ、面を開いている間に読む）と写真の行から群を作る。
 *
 * - 読んでいる間は群を出さない（読めた群が上に足されて、下の行が動かないように。この Mac は ImageIO の読み出しだけで速い）
 * - 読めない・失敗したら失敗の 1 行は出さず、写真の行のファイルの項目（名前・形式・大きさ・撮影日時）だけを出す
 * - 情報を読めない置き場（`capabilities.info` が false。いまのクラウド）も、写真の行のファイルの項目だけを出す
 */
export function BrowserPhotoEditingInfo(props: { photo: PhotoLibraryItem; infoAvailable: boolean }) {
  const library = usePhotoLibrary();
  const { photo } = props;
  const reads = props.infoAvailable && library.info !== undefined;
  const info = useQuery({ ...browserPhotoInfoQueryOptions(library, photo), enabled: reads });
  if (reads && info.isPending) return <div aria-busy="true" className="min-h-8" />;
  // 読まない間は、同じ鍵に前に読んだ値が残っていても使わない
  return <PhotoEditingInfoList groups={photoEditingInfoGroups(photo, reads ? (info.data ?? null) : null)} />;
}
