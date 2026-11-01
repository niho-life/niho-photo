"use client";

import { useEffect, useRef, useState, type ChangeEvent, type MutableRefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE } from "../photo-original-files";
import type { BrowserCloudPlace } from "../browser-photo-cloud-source";
import {
  MAC_PHOTOS_ADDING_DROP_REASON,
  sumMacCloudAddBytes,
  summarizeMacCloudAdd,
} from "../photo-library-device-add";
import {
  dropJpegsPairedWithRaw,
  summarizePhotoCloudAddOutcome,
  usePhotoCloudAddQueue,
} from "../photo-cloud-add-queue";
import {
  PHOTO_DROP_BULK_REASON,
  PHOTO_DROP_DELETING_REASON,
  PHOTO_DROP_EXPORTING_REASON,
  PHOTO_DROP_NO_PHOTOS_MESSAGE,
  photoCloudCapacityConfirm,
  sumPhotoFileBytes,
  type SortedPhotoDrop,
} from "../photo-file-drop";
import { usePhotoFileDropZone, type PhotoFileDropZoneState } from "../use-photo-file-drop-zone";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import { appDialog } from "niho-ui/app-dialog";
import type {
  PhotoLibraryCapabilities,
  PhotoLibraryDeviceAddOutcome,
  PhotoLibraryDeviceCandidate,
  PhotoLibraryDeviceImport,
  PhotoLibraryDevicePhoto,
  PhotoLibraryDevicePick,
  PhotoLibraryDevicePickKind,
  PhotoLibraryPhoto,
  PhotoLibraryUsage,
} from "../library/photo-library";
import { usePhotoEditingHost, usePhotoLibrary } from "../library/photo-library-context";

import {
  cloudKey,
  describeAddFailures,
  describeMacAddFailures,
  type AddRetry,
  type AddingProgress,
  type BrowserPhotoAccess,
  type BrowserPhotoOperation,
  type BrowserPhotoOperationKind,
  type BrowserViewMode,
  type FooterStatus,
} from "./browser-photo-editing-model";
import type { BrowserPhotoItems } from "./use-browser-photo-items";

/** 選んだ結果のうち、終わりの状態欄に足すもの（開けなかった写真・入れなかった写真。「再試行」では無い）。 */
type MacPickExtras = Pick<PhotoLibraryDevicePick, "failures" | "rawPairedJpegCount" | "truncated">;

const NO_MAC_PICK_EXTRAS: MacPickExtras = { failures: [], rawPairedJpegCount: 0, truncated: false };

/**
 * 写真を追加（「＋」・面に落とした写真。移行元設計 / 移行元設計）: ファイル選択・ドロップ・容量の確かめ・1 枚ずつクラウドへ入れる
 * 待ち行列。予約が返ったら一覧の先頭に追加中のタイルを出す。
 *
 * 写真の出どころがこの Mac から足せる（`capabilities.addFromDevice`。NIHO Desktop の中のクラウド。K2 移行元設計）なら、「＋」と空状態の主ボタンは「この Mac の
 * フォルダ」「この Mac の写真」（`mac.addFromMac`）になる。選んだ写真はファイルの追加と同じ追加中のタイル・状態欄（失敗と「再試行」）・
 * 容量の確かめ・離れる前の確かめで 1 枚ずつ入れる（ファイルの待ち行列とは別の走行で、同時には走らせない）。ドロップは今までどおり
 * ファイルで入れる。
 *
 * 入れる先は写真の出どころ（接続口 `PhotoLibrary` の `addFile`・`device`。移行元設計）。オリジナルも置くか・作業コピーを手元で作るかは、
 * 写真の出どころが足す直前に決める（拠点の許可・この Mac の「オリジナルを置く」・Desktop の版）。
 */
export function useBrowserPhotoAdd(params: {
  spotId: string;
  scopeKey?: string;
  canEdit: boolean;
  cloudOriginalsAllowed: boolean;
  active: boolean;
  queryClient: QueryClient;
  mountedRef: MutableRefObject<boolean>;
  latestAccessRef: MutableRefObject<BrowserPhotoAccess>;
  items: Pick<
    BrowserPhotoItems,
    "placeRef" | "setPlace" | "setSelectedKey" | "upsertAddedPhoto" | "removeAddedPhoto" | "clearFilter"
  >;
  /** 同じ写真が既にあったとき、詳細取得した最新行を読み込み済みページにも反映する */
  replaceCloudPhoto: (photo: PhotoLibraryPhoto) => void;
  usage: PhotoLibraryUsage | null;
  viewModeRef: MutableRefObject<BrowserViewMode>;
  operation: BrowserPhotoOperation | null;
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  /** 「写真」の一覧へ移る（開いていた写真の保存・破棄の確認を済ませる。移れなければ false） */
  selectPlace: (place: BrowserCloudPlace) => Promise<boolean>;
  setStatus: (status: FooterStatus | null) => void;
  /** 写真の出どころのできること（「この Mac から追加」は `addFromDevice`、フォルダから選ぶのは `addFromDeviceFolder`。K2 移行元設計） */
  capabilities: PhotoLibraryCapabilities;
}) {
  const { queryClient, mountedRef, latestAccessRef, viewModeRef, operation, operationRef, selectPlace, setStatus } = params;
  const { placeRef, setPlace, setSelectedKey, upsertAddedPhoto, removeAddedPhoto, clearFilter } = params.items;
  const library = usePhotoLibrary();
  const host = usePhotoEditingHost();
  const [adding, setAdding] = useState<AddingProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cloudUsageRef = useRef(params.usage);
  cloudUsageRef.current = params.usage;
  const capabilitiesRef = useRef(params.capabilities);
  capabilitiesRef.current = params.capabilities;
  // ファイル選択・ドロップが同時に確認ダイアログや画面切替を待っても、容量確認から queue.add までを直列にする。
  const addAdmissionTailRef = useRef<Promise<void>>(Promise.resolve());
  // この Mac から追加（K2 移行元設計）: 選び始めてから入れ終わるまで（その間はファイルの追加もこの Mac の追加も始めない）
  const [macBusy, setMacBusy] = useState(false);
  const macBusyRef = useRef(false);
  // この Mac の写真を入れている走行（止めるため。入れていなければ null）
  const macRunRef = useRef<AbortController | null>(null);

  const stillAllowedToAdd = (spotId: string): boolean => {
    const access = latestAccessRef.current;
    return mountedRef.current && access.canEdit && access.cloudOriginalsAllowed && access.spotId === spotId;
  };

  const setMacBusyState = (busy: boolean) => {
    macBusyRef.current = busy;
    if (mountedRef.current) setMacBusy(busy);
  };

  /** 「再試行」のために開いたままの写真を手放す（`keep` の写真は呼び出し側が持っていく）。 */
  // 写真を追加（「＋」・面に落とした写真。移行元設計 / 移行元設計）の待ち行列。1 枚ずつクラウドへ入れ、予約が返ったら一覧の先頭に
  // 追加中のタイルを出す。追加中に足した分は続けて入れる
  const addQueue = usePhotoCloudAddQueue({
    addPhoto: async (file, { signal }) => {
      // 予約が返った写真（失敗したら一覧から外す。準備の途中で呼ばれるので、変数ではなく入れ物で受ける）
      const reservation: { photoId: string | null } = { photoId: null };
      try {
        if (!library.addFile) throw new Error("photo library cannot add files");
        const result = await library.addFile(file, {
          signal,
          onReserved: (photo, preview) => {
            if (signal.aborted || !mountedRef.current) return;
            reservation.photoId = photo.id;
            upsertAddedPhoto(photo, preview, true);
            setAdding((current) => (current ? { ...current, photoId: photo.id } : current));
          },
          onProgress: (progress) => {
            if (progress.phase !== "uploading" || signal.aborted || !mountedRef.current) return;
            const fraction = Math.round(progress.fraction * 100) / 100;
            setAdding((current) => (current && current.fraction !== fraction ? { ...current, fraction } : current));
          },
        });
        // 新しく入った写真は、記事制作の画像ライブラリ（編集面の外）に「描いてから使う」行として出る（記事用の画像は付けない。
        // K3 移行元設計 / 移行元設計）ので知らせる
        if (!result.alreadyStored) host.notifyPhotosChanged();
        if (signal.aborted || !mountedRef.current) {
          // 止めた後に届いた結果は反映しない（追加中のタイルを外し、クラウドに入った分は一覧を読み直して出す）
          if (mountedRef.current && reservation.photoId !== null) removeAddedPhoto(reservation.photoId);
        } else {
          if (result.alreadyStored) params.replaceCloudPhoto(result.photo);
          upsertAddedPhoto(result.photo, result.preview, false);
        }
        return result;
      } catch (error) {
        if (mountedRef.current && reservation.photoId !== null) removeAddedPhoto(reservation.photoId);
        throw error;
      }
    },
    canContinue: (spotId) => stillAllowedToAdd(spotId),
    onProgress: (progress) => {
      if (!mountedRef.current) return;
      setAdding((current) => {
        if (progress === null) return null;
        // 待ちに足しただけ（同じ 1 枚のまま）なら、合計だけ増やす
        if (
          current &&
          current.spotId === progress.spotId &&
          current.index === progress.index &&
          current.fileName === progress.fileName
        ) {
          return current.total === progress.total ? current : { ...current, total: progress.total };
        }
        return { ...progress, photoId: null, fraction: null };
      });
    },
    onFinished: (outcome) => {
      if (outcome.storedAny) {
        void queryClient
          .invalidateQueries({ queryKey: photoEditingQueryKeys.cloudPhotos(outcome.spotId, params.scopeKey) })
          .catch(() => undefined);
      }
      if (!mountedRef.current || outcome.aborted || latestAccessRef.current.spotId !== outcome.spotId) return;
      // 止めた理由 > 失敗（「再試行」） > 入れなかったファイル（写真でないファイル・RAW と同じ写真の JPEG）
      const summary = summarizePhotoCloudAddOutcome(outcome);
      if (summary?.kind === "stopped") setStatus({ kind: "error", text: summary.text });
      else if (summary?.kind === "failed") setStatus(describeAddFailures(summary.failures));
      else if (summary?.kind === "notice") setStatus({ kind: "notice", text: summary.text });
      if (outcome.lastPhotoId !== null && viewModeRef.current === "grid") {
        setPlace("photos");
        setSelectedKey(cloudKey(outcome.lastPhotoId));
      }
    },
  });

  // 画面を離れる前の確かめで見る「追加している途中」（ファイルの待ち行列か、この Mac の追加の走行）
  const [addRunning] = useState(() => ({
    get running(): boolean {
      return addQueue.running || macRunRef.current !== null || macBusyRef.current;
    },
  }));

  // 拠点・権限・オリジナルの保存の許可が変わったら、追加を止める（新しい予約・入れ終わりを始めない。待ちも捨てる）
  useEffect(() => {
    if (!adding) return;
    if (adding.spotId !== params.spotId || !params.canEdit || !params.cloudOriginalsAllowed) {
      addQueue.abort();
      macRunRef.current?.abort();
    }
  }, [addQueue, adding, params.canEdit, params.cloudOriginalsAllowed, params.spotId]);

  // 画面を閉じたら、この Mac の追加を止める
  useEffect(
    () => () => {
      macRunRef.current?.abort();
    },
    [],
  );

  /**
   * 写真を追加（移行元設計）・面に落とした写真（移行元設計）。選んだ・落としたファイルを 1 枚ずつクラウドへ入れる（{@link addQueue}）。
   * 予約が返ったら一覧の先頭に追加中のタイルを出し、終わったら最後に足した写真を選ぶ（同じ写真がもうあれば上げずにその写真を
   * 選ぶ）。容量超え・拠点が許可していなければ残りを止め、ほかの失敗はタイルを外して次へ進み、最後に「再試行」を出す。
   *
   * - 追加している途中なら待ちに足して続けて入れる（「写真」の一覧へ移るのは、その回の最初の 1 枚を始める前だけ）
   * - 足す合計が空き（待ち・追加中の分を引いた値）を超えるときだけ、始める前に 1 回確かめる。やめたら何もしない
   * - この Mac の写真を追加している間（K2 移行元設計）は受けない（同時に走らせない）
   */
  const addPhotos = async (files: File[], options: { nonPhotoCount?: number } = {}) => {
    if (!files.length) return;
    const previousAdmission = addAdmissionTailRef.current;
    let releaseAdmission!: () => void;
    addAdmissionTailRef.current = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    await previousAdmission;
    try {
      if (operationRef.current || macBusyRef.current) return;
      const operationSpotId = latestAccessRef.current.spotId;
      if (!stillAllowedToAdd(operationSpotId)) return;
      // 空きの確認は実際に入れる写真で数える（RAW と同じ名前の JPEG は待ち行列が外す。移行元設計）
      const addBytes = sumPhotoFileBytes(dropJpegsPairedWithRaw(files).files);
      let approvedCapacityKey: string | null = null;
      const confirmCapacityIfNeeded = async (): Promise<boolean> => {
        const usage = cloudUsageRef.current;
        const message = photoCloudCapacityConfirm({
          addBytes,
          usage,
          reservedBytes: usage ? addQueue.reservedBytes(usage.usedBytes) : 0,
        });
        const messageKey = message === null ? null : (JSON.stringify(message) ?? "");
        if (!message || messageKey === approvedCapacityKey) return true;
        if (!(await appDialog.confirm(message))) return false;
        approvedCapacityKey = messageKey;
        return !operationRef.current && stillAllowedToAdd(operationSpotId);
      };
      if (!(await confirmCapacityIfNeeded())) return;
      if (!addQueue.running) {
        if ((placeRef.current !== "photos" || viewModeRef.current !== "grid") && !(await selectPlace("photos"))) return;
        if (operationRef.current || macBusyRef.current || !stillAllowedToAdd(operationSpotId)) return;
        // 足した写真が一覧に見えるよう、絞り込みの条件も外す（「写真」へ移るのと同じ。F5b 移行元設計）
        clearFilter();
        if (!addQueue.running) setStatus(null);
      }
      // selectPlace may wait for save/discard confirmation. Re-read usage and queue reservations immediately before admitting the files.
      if (!(await confirmCapacityIfNeeded())) return;
      if (operationRef.current || macBusyRef.current || !stillAllowedToAdd(operationSpotId)) return;
      const usage = cloudUsageRef.current;
      addQueue.add(operationSpotId, files, { nonPhotoCount: options.nonPhotoCount, usedBytes: usage?.usedBytes ?? null });
    } finally {
      releaseAdmission();
    }
  };

  /** 面に落とした写真（形式でふるった後）。写真が 1 枚も無く、追加している途中でもなければすぐに知らせる。 */
  const addDroppedPhotos = (dropped: SortedPhotoDrop) => {
    if (operationRef.current || macBusyRef.current || !stillAllowedToAdd(params.spotId)) return;
    if (dropped.photos.length > 0) {
      void addPhotos(dropped.photos, { nonPhotoCount: dropped.nonPhotoCount });
      return;
    }
    if (addQueue.add(params.spotId, [], { nonPhotoCount: dropped.nonPhotoCount }) === "ignored") {
      setStatus({ kind: "error", text: PHOTO_DROP_NO_PHOTOS_MESSAGE });
    }
  };

  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void addPhotos(files);
  };

  /**
   * この Mac の写真 1 枚をクラウドへ入れる（予約が返ったら追加中のタイルを出し、入れ終えたらタイルを入れ終わりにする）。オリジナルも
   * 置くか・作業コピーを手元で作るかは、写真の出どころが入れる直前に読み直す（入れている途中で この Mac の「オリジナルを置く」が
   * 変わった。移行元設計）。
   */
  const addMacPhoto = async (device: PhotoLibraryDeviceImport, macPhoto: PhotoLibraryDevicePhoto, signal: AbortSignal) => {
    // 予約が返った写真（失敗したら一覧から外す。準備の途中で呼ばれるので、変数ではなく入れ物で受ける）
    const reservation: { photoId: string | null } = { photoId: null };
    try {
      const result = await device.addPhoto(macPhoto, {
        signal,
        onPrepared: (photo) => {
          if (signal.aborted || !mountedRef.current) return;
          reservation.photoId = photo.id;
          upsertAddedPhoto(photo, null, true);
          setAdding((current) => (current ? { ...current, photoId: photo.id } : current));
        },
        onPreview: (photo, preview) => {
          if (signal.aborted || !mountedRef.current) return;
          upsertAddedPhoto(photo, preview, true);
        },
      });
      // 新しく入った写真は、記事制作の画像ライブラリに「描いてから使う」行として出るので知らせる（ファイルの追加と同じ）
      if (!result.alreadyStored) host.notifyPhotosChanged();
      if (signal.aborted || !mountedRef.current) {
        if (mountedRef.current && reservation.photoId !== null) removeAddedPhoto(reservation.photoId);
      } else {
        if (result.alreadyStored) params.replaceCloudPhoto(result.photo);
        upsertAddedPhoto(result.photo, result.preview, false);
      }
      return result;
    } catch (error) {
      if (mountedRef.current && reservation.photoId !== null) removeAddedPhoto(reservation.photoId);
      throw error;
    }
  };

  /** この Mac の追加が終わった（止めた）ときの一覧・状態欄。止めた・画面を閉じた・拠点が変わったときは画面に出さない。 */
  const finishMacAdd = (spotId: string, outcome: PhotoLibraryDeviceAddOutcome, extras: MacPickExtras) => {
    if (outcome.storedAny) {
      void queryClient.invalidateQueries({ queryKey: photoEditingQueryKeys.cloudPhotos(spotId, params.scopeKey) }).catch(() => undefined);
    }
    if (!mountedRef.current || outcome.aborted || latestAccessRef.current.spotId !== spotId) return;
    // 止めた理由 > 失敗（「再試行」） > 入れなかった写真（フォルダの上限・RAW と同じ写真の JPEG）
    const summary = summarizeMacCloudAdd({
      stopMessage: outcome.stopMessage,
      failures: [...extras.failures, ...outcome.failures],
      rawPairedJpegCount: extras.rawPairedJpegCount,
      truncated: extras.truncated,
    });
    if (summary?.kind === "stopped") setStatus({ kind: "error", text: summary.text });
    else if (summary?.kind === "failed") setStatus(describeMacAddFailures(summary.failures));
    else if (summary?.kind === "notice") setStatus({ kind: "notice", text: summary.text });
    if (outcome.lastPhoto !== null && viewModeRef.current === "grid") {
      setPlace(outcome.lastPhoto.hasOriginal ? "photos" : "articleImages");
      setSelectedKey(cloudKey(outcome.lastPhoto.id));
    }
  };

  /**
   * 選んだこの Mac の写真を入れる（写真の出どころの `device.run`）。足す合計が空きを超えるときだけ始める前に 1 回確かめ、「写真」の一覧へ
   * 移ってから 1 枚ずつ入れる。終わったら最後に足した写真を選び、止めた理由・失敗（「再試行」）・入れなかった写真を状態欄に出す。
   * 呼ぶ前に `macBusy` と停止用 signal を立てておく。成功・失敗・中断を問わず開いた写真を手放す。
   */
  const runMacAdd = async (
    device: PhotoLibraryDeviceImport,
    spotId: string,
    candidates: PhotoLibraryDeviceCandidate[],
    extras: MacPickExtras,
    options: { controller: AbortController },
  ): Promise<void> => {
    const { controller } = options;
    const canStart = () => !controller.signal.aborted && !operationRef.current && !addQueue.running && stillAllowedToAdd(spotId);
    let started = false;
    try {
      if (!canStart()) return;
      if (candidates.length === 0) {
        // 入れる写真が無かった（開けなかった写真だけ・写真の無いフォルダ）
        setStatus(
          extras.failures.length > 0
            ? describeMacAddFailures(extras.failures)
            : { kind: "error", text: PHOTO_DROP_NO_PHOTOS_MESSAGE },
        );
        return;
      }
      const capacity = photoCloudCapacityConfirm({
        addBytes: sumMacCloudAddBytes(candidates),
        usage: cloudUsageRef.current,
        reservedBytes: 0,
      });
      if (capacity && (!(await appDialog.confirm(capacity)) || !canStart())) return;
      if ((placeRef.current !== "photos" || viewModeRef.current !== "grid") && !(await selectPlace("photos"))) return;
      if (!canStart()) return;
      // 足した写真が一覧に見えるよう、ファイルの追加と同じく絞り込みも外す。
      clearFilter();
      setStatus(null);
      started = true;
      const outcome = await device.run(candidates, {
        signal: controller.signal,
        canContinue: () => stillAllowedToAdd(spotId) && capabilitiesRef.current.addFromDevice,
        onProgress: (progress) => {
          if (!mountedRef.current) return;
          setAdding({ spotId, ...progress, photoId: null, fraction: null });
        },
        addPhoto: (macPhoto, context) => addMacPhoto(device, macPhoto, context.signal),
      }).finally(() => {
        if (macRunRef.current === controller) macRunRef.current = null;
        if (mountedRef.current) setAdding(null);
      });
      finishMacAdd(spotId, outcome, extras);
    } finally {
      if (!started) {
        void device.release(candidates);
      }
      if (macRunRef.current === controller) macRunRef.current = null;
      setMacBusyState(false);
    }
  };

  /**
   * 「この Mac のフォルダ」「この Mac の写真」（K2 移行元設計）: ネイティブの選択ダイアログで選んだ写真を、ファイルの追加と同じ見せ方で
   * クラウドの「写真」へ 1 枚ずつ入れる（元の写真・プレビュー・RAW の作業コピーを Desktop が上げる。W2 移行元設計）。ほかの追加・
   * 書き出し・消している途中は始めない。ダイアログを閉じたら何もしない。
   */
  const addFromMac = async (kind: PhotoLibraryDevicePickKind) => {
    const device = library.device;
    if (!device || !capabilitiesRef.current.addFromDevice || macBusyRef.current || addQueue.running || operationRef.current) return;
    const spotId = latestAccessRef.current.spotId;
    if (!stillAllowedToAdd(spotId)) return;
    setMacBusyState(true);
    const controller = new AbortController();
    macRunRef.current = controller;
    let pick: PhotoLibraryDevicePick;
    try {
      pick = await device.pick(kind);
    } catch (error) {
      const message = device.describePickError(kind, error);
      if (
        message &&
        !controller.signal.aborted &&
        mountedRef.current &&
        latestAccessRef.current.spotId === spotId
      ) {
        setStatus({ kind: "error", text: message });
      }
      if (macRunRef.current === controller) macRunRef.current = null;
      setMacBusyState(false);
      return;
    }
    if (pick.cancelled) {
      if (macRunRef.current === controller) macRunRef.current = null;
      setMacBusyState(false);
      return;
    }
    if (controller.signal.aborted) {
      void device.release(pick.candidates);
      if (macRunRef.current === controller) macRunRef.current = null;
      setMacBusyState(false);
      return;
    }
    await runMacAdd(device, spotId, pick.candidates, pick, { controller });
  };

  /** 状態欄の「再試行」: 追加できなかった写真だけをもう一度入れる（ファイルはファイルの追加、この Mac の写真はこの Mac の追加）。 */
  const retryAdd = (retry: AddRetry) => {
    if (retry.kind === "files") {
      void addPhotos(retry.files);
      return;
    }
    const device = library.device;
    if (!device || !capabilitiesRef.current.addFromDevice || macBusyRef.current || addQueue.running || operationRef.current) return;
    const spotId = latestAccessRef.current.spotId;
    if (!stillAllowedToAdd(spotId)) return;
    setMacBusyState(true);
    const controller = new AbortController();
    macRunRef.current = controller;
    void runMacAdd(device, spotId, retry.photos, NO_MAC_PICK_EXTRAS, { controller });
  };

  // 追加している途中も押せる（選んだ分は待ちに足して続けて入れる）。書き出し・消している途中は押せない。ファイルを足せない写真の
  // 出どころ（`capabilities.addFiles` が false。この Mac のフォルダを読む NIHO camera）は、ファイルの追加を受けない
  const canAddBase = params.canEdit && params.cloudOriginalsAllowed && operation === null && !macBusy;
  const canAdd = canAddBase && params.capabilities.addFiles && library.addFile !== undefined;
  const addTitle = params.cloudOriginalsAllowed ? "写真を追加" : BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE;
  const openAddPicker = () => {
    if (canAdd) fileInputRef.current?.click();
  };
  const stopMacAdd = () => macRunRef.current?.abort();

  // この Mac から追加（K2 移行元設計）。クラウドの写真置き場に対応した Desktop（v11〜）だけ。ほかの追加（ドロップ）・この Mac の追加・
  // 書き出し・消している途中は押せない。オリジナル設定がオフでも、クラウドにある同じ写真を選べるのでメニューは使える
  const { capabilities } = params;
  const mac = capabilities.addFromDevice
    ? {
        /** 「この Mac のフォルダ」も出せる（フォルダの一覧 v14〜） */
        folders: capabilities.addFromDeviceFolder,
        canAdd: canAddBase && adding === null,
        busy: macBusy,
        addFromMac,
        stop: stopMacAdd,
      }
    : null;

  // Finder などから写真を落とす口（面全体。移行元設計）。設定サブタブを見せている間は受けない。閲覧のみの operator と、ファイルを
  // 足せない写真の出どころ（`capabilities.addFiles` が false）には幕を出さず、ページを離れないようにだけする
  const dropZone: PhotoFileDropZoneState | null = (!params.canEdit || !capabilities.addFiles || library.addFile === undefined)
    ? null
    : !params.cloudOriginalsAllowed
      ? { kind: "reject", reason: BROWSER_CLOUD_ORIGINALS_DISABLED_MESSAGE }
      : operation?.kind === "export"
        ? { kind: "reject", reason: PHOTO_DROP_EXPORTING_REASON }
        : operation?.kind === "delete"
          ? { kind: "reject", reason: PHOTO_DROP_DELETING_REASON }
          : operation?.kind === "bulk"
            ? { kind: "reject", reason: PHOTO_DROP_BULK_REASON }
            : operation?.kind === "copy"
              ? { kind: "reject", reason: "クラウドへのコピーが終わってから追加できます" }
              : macBusy
                ? { kind: "reject", reason: MAC_PHOTOS_ADDING_DROP_REASON }
                : { kind: "accept", queued: adding !== null };
  const fileDrop = usePhotoFileDropZone({ enabled: params.active, zone: dropZone, onDropFiles: addDroppedPhotos });

  return {
    adding,
    macBusy,
    addRunning,
    fileInputRef,
    addPhotos,
    retryAdd,
    onFilesChosen,
    canAdd,
    addTitle,
    openAddPicker,
    fileDrop,
    mac,
  };
}
