"use client";

import { Cloud, Laptop, Moon, Plus, Server } from "lucide-react";

import { cn } from "niho-ui/cn";

import { PHOTO_STORAGE_LOCATION_COPY } from "../photo-editing-copy";
import { formatPhotoCloudUsage } from "../photo-library-usage";
import { PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME } from "../editor/photo-editing-button-classes";

import {
  photoStorageLocationName,
  photoStorageLocationStatus,
  type PhotoStorageLocation,
  type PhotoStorageLocationKind,
} from "./photo-shared-album-model";

const KIND_ORDER: Record<PhotoStorageLocationKind, number> = { nihoCloud: 0, hostedMac: 1, thisMac: 2 };

/**
 * 設定の「保存先」（B08 #249）。標準は NIHO クラウドで、最初に選ばせない。自前サーバー（常設 Mac）はここから足し、日常の画面には
 * 出さない。自前サーバーは接続状態だけを短く出し、休止中は「Mac の起動後に更新」（一覧・補正・共有アルバムは止めない）。
 * 保存先の変更・移行は第 2 段階（B10）なので、ここでは切り替えない。
 */
export function PhotoStorageLocationSettings(props: {
  locations: readonly PhotoStorageLocation[];
  /** 自前サーバーを足す（登録の流れは接続側。無ければ出さない） */
  onAddHostedMac?: () => void;
}) {
  const locations = [...props.locations].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return (
    <section aria-labelledby="photo-storage-location-heading" className="text-niho-text">
      <h2 id="photo-storage-location-heading" className="px-1 text-sub font-bold text-niho-text-sub">
        {PHOTO_STORAGE_LOCATION_COPY.heading}
      </h2>
      <ul className="mt-2 divide-y divide-niho-border overflow-hidden rounded-2xl border border-niho-border bg-white">
        {locations.map((location) => (
          <PhotoStorageLocationRow key={location.locationId} location={location} />
        ))}
      </ul>
      {props.onAddHostedMac ? (
        <button type="button" onClick={props.onAddHostedMac} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-3 h-11 px-4")}>
          <Plus className="h-4 w-4" aria-hidden />
          {PHOTO_STORAGE_LOCATION_COPY.addHostedMac}
        </button>
      ) : null}
    </section>
  );
}

function PhotoStorageLocationRow(props: { location: PhotoStorageLocation }) {
  const { location } = props;
  const Icon = location.kind === "nihoCloud" ? Cloud : location.kind === "hostedMac" ? Server : Laptop;
  const status = photoStorageLocationStatus(location);
  const detail = location.kind === "nihoCloud" && location.usage ? formatPhotoCloudUsage(location.usage) : status;
  const hostedStatus = location.kind === "hostedMac" ? location.hostedMacStatus : null;
  return (
    <li className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-niho-surface-subtle text-niho-text-sub">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-words text-body font-bold leading-snug">{photoStorageLocationName(location)}</span>
        {detail ? (
          <span
            className={cn(
              "flex items-start gap-1.5 text-sub font-bold",
              hostedStatus === "unreachable" ? "text-niho-text-sub" : "text-niho-text-muted",
            )}
          >
            {hostedStatus ? (
              // 印は 1 行目の高さの中で縦に揃える（状態が 2 行に折り返しても 1 行目に付く）
              <span aria-hidden className="flex h-[1.5em] shrink-0 items-center">
                {hostedStatus === "sleeping" ? (
                  <Moon className="h-3.5 w-3.5" />
                ) : (
                  <span className={cn("h-2 w-2 rounded-full", hostedStatus === "online" ? "bg-niho-deep" : "bg-niho-orange")} />
                )}
              </span>
            ) : null}
            <span className="min-w-0 break-words">{detail}</span>
          </span>
        ) : null}
      </span>
      {location.kind === "nihoCloud" ? (
        <span className="shrink-0 rounded-full bg-niho-accent-soft px-2.5 py-0.5 text-xs font-bold text-niho-accent-ink">
          {PHOTO_STORAGE_LOCATION_COPY.standard}
        </span>
      ) : null}
    </li>
  );
}
