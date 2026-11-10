"use client";

import { useEffect, useState } from "react";

import type { PhotoLibrary, PhotoLibraryRollout } from "./library/photo-library";

/** 読めるまで・読めなかったときは全部出さない（受入前の機能を誤って出さない）。 */
export const PHOTO_EDITING_ROLLOUT_OFF: PhotoLibraryRollout = { crop: false, mobileEditing: false, sharedAlbums: false };

/**
 * 写真編集の受入まで拠点を絞る機能（F9 移行元設計）を、写真の出どころ（接続口 `PhotoLibrary` の `rollout`。クラウドは拠点ごと）から
 * 1 回読む。切り抜きの入口（F3b）とスマホの編集面（F6c）はこの値で出し分ける。口が変わったら（拠点が変わった）読み直し、前の口の
 * 結果・unmount 後に届いた結果は捨てる。口が無ければ読まない。読めなかったら出さない（fail closed）。
 */
export function usePhotoEditingRollout(library: PhotoLibrary | null): PhotoLibraryRollout {
  const [state, setState] = useState<{ library: PhotoLibrary; rollout: PhotoLibraryRollout } | null>(null);

  useEffect(() => {
    if (!library) return;
    const controller = new AbortController();
    library.rollout({ signal: controller.signal }).then(
      (rollout) => {
        if (!controller.signal.aborted) setState({ library, rollout });
      },
      () => {
        if (!controller.signal.aborted) setState({ library, rollout: PHOTO_EDITING_ROLLOUT_OFF });
      },
    );
    return () => controller.abort();
  }, [library]);

  return state && state.library === library ? state.rollout : PHOTO_EDITING_ROLLOUT_OFF;
}
