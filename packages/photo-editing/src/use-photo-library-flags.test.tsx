// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PhotoCloudListPage } from "./use-photo-cloud-photos";
import { photoEditingQueryKeys } from "./photo-editing-query-keys";
import { photoCloudListFilter } from "./use-photo-cloud-favorite";
import type { PhotoLibrary, PhotoLibraryCapabilities, PhotoLibraryFlag, PhotoLibraryItem } from "./library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "./library/photo-library-context";
import { usePhotoLibraryFlags, type PhotoLibraryFlagsControl } from "./use-photo-library-flags";

/**
 * 選別のフラグの付け外し（niho-photo#47）: 押した直後に読み込んである一覧すべて（選別で絞った一覧も、行は外さずに）と一覧の外の写真を
 * 書き換え、`photosPerRequest` 枚ずつ送る。今の値と同じ写真・送っている途中の写真は飛ばす。送れなかった・変えられなかった写真があれば
 * 元の値に戻し、一覧を読み直してから `onError`。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPOT = "local";
const CAPABILITIES = { place: "local", flags: true } as unknown as PhotoLibraryCapabilities;
const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => true,
};

type Pages = InfiniteData<PhotoCloudListPage, string | null>;
type SetFlags = (photoIds: readonly string[], flag: PhotoLibraryFlag | null) => Promise<{ updated: number; skipped: { notFound: number; noOriginal: number } }>;

function photo(id: string, flag?: PhotoLibraryFlag | null): PhotoLibraryItem {
  return {
    id,
    fileName: `${id}.JPG`,
    fileExtension: "jpg",
    sizeBytes: 1,
    contentSha256: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    uploadedBy: null,
    hasOriginal: true,
    hasPreview: true,
    hasWebImage: false,
    hasDevelopSettings: false,
    developSettings: null,
    developSettingsUpdatedAt: null,
    developRevision: 0,
    webRenderedRevision: null,
    previewUrl: null,
    ...(flag === undefined ? {} : { flag }),
  };
}

const ALL_KEY = photoEditingQueryKeys.cloudPhotosList(SPOT, { sort: "added", hasOriginal: null, favorite: null, folderId: "f1" });
const PICKS_KEY = photoEditingQueryKeys.cloudPhotosList(SPOT, {
  sort: "added",
  hasOriginal: null,
  favorite: null,
  flag: "pick",
  folderId: "f1",
});

describe("photoEditingQueryKeys scopeKey compatibility", () => {
  it("keeps legacy keys intact and isolates scoped list cache under the matching prefix", () => {
    const list = { sort: "added" as const, hasOriginal: null, favorite: null, folderId: "f1" };
    const scopeA = "personal:library-a:actor-a";
    const scopeB = "personal:library-b:actor-a";
    const legacyKey = photoEditingQueryKeys.cloudPhotosList(SPOT, list);
    const scopedKeyA = photoEditingQueryKeys.cloudPhotosList(SPOT, list, scopeA);
    const scopedKeyB = photoEditingQueryKeys.cloudPhotosList(SPOT, list, scopeB);

    expect(photoEditingQueryKeys.cloudPhotos(SPOT)).toEqual(["admin", "photoEditing", "cloudPhotos", SPOT]);
    expect(legacyKey).toEqual(["admin", "photoEditing", "cloudPhotos", SPOT, { ...list, albumId: null, kind: null, edited: null }]);
    expect(scopedKeyA).not.toEqual(scopedKeyB);
    expect(photoCloudListFilter(scopedKeyA)).toEqual({ hasOriginal: null, favorite: null, kind: null, edited: null });

    const scopedClient = new QueryClient();
    scopedClient.setQueryData(legacyKey, "legacy");
    scopedClient.setQueryData(scopedKeyA, "library A");
    scopedClient.setQueryData(scopedKeyB, "library B");
    expect(scopedClient.getQueriesData({ queryKey: photoEditingQueryKeys.cloudPhotos(SPOT, scopeA) })).toEqual([[scopedKeyA, "library A"]]);
    expect(scopedClient.getQueriesData({ queryKey: photoEditingQueryKeys.cloudPhotos(SPOT) })).toEqual([[legacyKey, "legacy"]]);
    scopedClient.clear();
  });
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let control: PhotoLibraryFlagsControl;
let applyLocal: ReturnType<typeof vi.fn<(photoId: string, flag: PhotoLibraryFlag | null) => void>>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

function library(set: SetFlags | null): PhotoLibrary {
  return {
    place: "local",
    initialCapabilities: CAPABILITIES,
    capabilities: async () => CAPABILITIES,
    limits: { listPageSize: 500, lookupMaxCount: 100, referencesMaxCount: 0, photosPerRequest: 2 },
    ...(set ? { flags: { set } } : {}),
  } as unknown as PhotoLibrary;
}

function Consumer() {
  control = usePhotoLibraryFlags({ spotId: SPOT, applyLocal, onError });
  return null;
}

async function render(set: SetFlags | null) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library(set)} host={host}>
          <Consumer />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
}

function seed(key: readonly unknown[], photos: PhotoLibraryItem[]) {
  client.setQueryData<Pages>(key, {
    pages: [{ photos, nextCursor: null, usage: null, counts: null }],
    pageParams: [null],
  });
}

function flagsIn(key: readonly unknown[]): Array<[string, PhotoLibraryFlag | null]> {
  return (client.getQueryData<Pages>(key)?.pages ?? []).flatMap((page) =>
    page.photos.map((item) => [item.id, item.flag ?? null] as [string, PhotoLibraryFlag | null]),
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ok = (updated: number) => ({ updated, skipped: { notFound: 0, noOriginal: 0 } });

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  applyLocal = vi.fn();
  onError = vi.fn();
  seed(ALL_KEY, [photo("a"), photo("b", "pick"), photo("c", "reject"), photo("d", null)]);
  seed(PICKS_KEY, [photo("b", "pick")]);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("usePhotoLibraryFlags", () => {
  it("押した直後にすべての一覧と一覧の外の写真を書き換え、今の値と同じ写真は送らず、photosPerRequest 枚ずつ送る", async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    const set = vi.fn<SetFlags>().mockImplementationOnce(() => pending.promise).mockResolvedValue(ok(1));
    await render(set);

    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = control.setFlag([photo("a"), photo("b", "pick"), photo("c", "reject"), photo("d", null)], "pick");
    });
    // 採用の b は送らない。選別で絞った一覧からも行は外さない（出し分けは画面）
    expect(flagsIn(ALL_KEY)).toEqual([
      ["a", "pick"],
      ["b", "pick"],
      ["c", "pick"],
      ["d", "pick"],
    ]);
    expect(flagsIn(PICKS_KEY)).toEqual([["b", "pick"]]);
    expect(applyLocal.mock.calls).toEqual([
      ["a", "pick"],
      ["c", "pick"],
      ["d", "pick"],
    ]);
    expect([...control.pendingIds]).toEqual(["a", "c", "d"]);
    expect(control.isPending("a")).toBe(true);
    expect(control.isPending("b")).toBe(false);

    await act(async () => {
      pending.resolve(ok(2));
      await done;
    });
    expect(set.mock.calls).toEqual([
      [["a", "c"], "pick"],
      [["d"], "pick"],
    ]);
    expect(control.pendingIds.size).toBe(0);
    expect(control.isPending("a")).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(flagsIn(ALL_KEY).map(([, flag]) => flag)).toEqual(["pick", "pick", "pick", "pick"]);
  });

  it("外す（null）も同じ。送っている途中の写真への 2 回目は受けない", async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    const set = vi.fn<SetFlags>(() => pending.promise);
    await render(set);
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = control.setFlag([photo("b", "pick")], null);
    });
    expect(flagsIn(ALL_KEY)[1]).toEqual(["b", null]);
    await act(async () => {
      await control.setFlag([photo("b", null)], "reject");
    });
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(ok(1));
      await done;
    });
    expect(set).toHaveBeenCalledWith(["b"], null);
    expect(flagsIn(ALL_KEY)[1]).toEqual(["b", null]);
    // 付いていない写真を外すのは何も送らない
    await act(async () => {
      await control.setFlag([photo("a"), photo("d", null)], null);
    });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("送れなかったら元の値に戻し、一覧を読み直してから知らせる", async () => {
    const set = vi.fn<SetFlags>().mockResolvedValueOnce(ok(2)).mockRejectedValueOnce(new Error("disk full"));
    await render(set);
    await act(async () => {
      await control.setFlag([photo("a"), photo("b", "pick"), photo("d", null)], "reject");
    });
    expect(flagsIn(ALL_KEY)).toEqual([
      ["a", null],
      ["b", "pick"],
      ["c", "reject"],
      ["d", null],
    ]);
    expect(flagsIn(PICKS_KEY)).toEqual([["b", "pick"]]);
    expect(applyLocal.mock.calls.at(-1)).toEqual(["d", null]);
    expect(client.getQueryState(ALL_KEY)?.isInvalidated).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(control.pendingIds.size).toBe(0);
  });

  it("変えられなかった写真がある（updated が少ない）ときも戻して知らせる", async () => {
    const set = vi.fn<SetFlags>().mockResolvedValue({ updated: 0, skipped: { notFound: 1, noOriginal: 0 } });
    await render(set);
    await act(async () => {
      await control.setFlag([photo("a")], "pick");
    });
    expect(flagsIn(ALL_KEY)[0]).toEqual(["a", null]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("一覧の読み直しが終わるまでは失敗を知らせない", async () => {
    const invalidation = deferred<void>();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(invalidation.promise);
    const set = vi.fn<SetFlags>().mockResolvedValue({ updated: 0, skipped: { notFound: 1, noOriginal: 0 } });
    await render(set);

    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = control.setFlag([photo("a")], "pick");
      await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    });
    expect(onError).not.toHaveBeenCalled();
    await act(async () => {
      invalidation.resolve();
      await done;
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("選別を持たない写真の出どころでは、押されても戻して知らせる", async () => {
    await render(null);
    await act(async () => {
      await control.setFlag([photo("a")], "pick");
    });
    expect(flagsIn(ALL_KEY)[0]).toEqual(["a", null]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
