"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  PhotoLibraryAlbum,
  PhotoLibraryAlbums,
  PhotoLibraryFavorites,
} from "./library/photo-library";
import { usePhotoLibrary } from "./library/photo-library-context";
import { photoEditingQueryKeys } from "./photo-editing-query-keys";

/**
 * 1 回で送れる数（接続口の `limits.photosPerRequest`。クラウドの API は 100 件）を超えないよう、選択順を保って重複を除く。
 */
export function photoCloudPhotoIdBatches(photoIds: readonly string[], batchSize: number): string[][] {
  const unique = [...new Set(photoIds)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += batchSize) {
    batches.push(unique.slice(index, index + batchSize));
  }
  return batches;
}

/** アルバムからの削除が、重複を除いた全対象に完了したか確認する。 */
export function photoCloudAlbumRemovalIsComplete(
  photoIds: readonly string[],
  batchSize: number,
  results: readonly { removed: number }[],
): boolean {
  const batches = photoCloudPhotoIdBatches(photoIds, batchSize);
  return results.length === batches.length && results.every((result, index) => result.removed === batches[index]?.length);
}

/** 部分的に成功した後の失敗を成功扱いにしない。失敗した batch 以降は送らない。 */
export async function runPhotoCloudPhotoBatches<T>(
  photoIds: readonly string[],
  batchSize: number,
  action: (batch: readonly string[]) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const batch of photoCloudPhotoIdBatches(photoIds, batchSize)) results.push(await action(batch));
  return results;
}

/** アルバム・お気に入りを持たない写真の出どころ（`capabilities` で道具を出さないので、呼ばれない）。 */
function requireTool<T>(tool: T | undefined, name: string): T {
  if (tool === undefined) throw new Error(`photo library has no ${name}`);
  return tool;
}

function skippedCount(result: { skipped?: { notFound?: number; noOriginal?: number } }): number {
  return (result.skipped?.notFound ?? 0) + (result.skipped?.noOriginal ?? 0);
}

export function usePhotoCloudAlbums(options: { spotId: string; scopeKey?: string; enabled?: boolean }) {
  const { spotId, scopeKey } = options;
  const library = usePhotoLibrary();
  const albumsTool: PhotoLibraryAlbums | undefined = library.albums;
  const favoritesTool: PhotoLibraryFavorites | undefined = library.favorites;
  const batchSize = library.limits.photosPerRequest;
  const queryClient = useQueryClient();
  const queryKey = photoEditingQueryKeys.cloudAlbums(spotId, scopeKey);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => ({ albums: await requireTool(albumsTool, "albums").list({ signal }) }),
    enabled: (options.enabled ?? true) && albumsTool !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const refreshAlbums = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );
  const refreshAfterPhotoChange = useCallback(
    async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: photoEditingQueryKeys.cloudPhotos(spotId, scopeKey) }),
      ]);
    },
    [queryClient, queryKey, scopeKey, spotId],
  );

  const createAlbum = useCallback(
    async (name: string): Promise<PhotoLibraryAlbum> => {
      const album = await requireTool(albumsTool, "albums").create(name);
      await refreshAlbums();
      return album;
    },
    [albumsTool, refreshAlbums],
  );
  const renameAlbum = useCallback(
    async (albumId: string, name: string): Promise<PhotoLibraryAlbum> => {
      const album = await requireTool(albumsTool, "albums").rename(albumId, name);
      await refreshAlbums();
      return album;
    },
    [albumsTool, refreshAlbums],
  );
  const deleteAlbum = useCallback(
    async (albumId: string): Promise<void> => {
      await requireTool(albumsTool, "albums").delete(albumId);
      await refreshAfterPhotoChange();
    },
    [albumsTool, refreshAfterPhotoChange],
  );

  const setPhotosFavorite = useCallback(
    async (photoIds: readonly string[], favorite: boolean): Promise<void> => {
      try {
        const favorites = requireTool(favoritesTool, "favorites");
        const results = await runPhotoCloudPhotoBatches(photoIds, batchSize, (batch) => favorites.set(batch, favorite));
        if (results.some((result) => skippedCount(result) > 0)) throw new Error("some photos were skipped");
      } finally {
        await refreshAfterPhotoChange();
      }
    },
    [batchSize, favoritesTool, refreshAfterPhotoChange],
  );
  const addPhotosToAlbum = useCallback(
    async (albumId: string, photoIds: readonly string[]): Promise<void> => {
      try {
        const albums = requireTool(albumsTool, "albums");
        const results = await runPhotoCloudPhotoBatches(photoIds, batchSize, (batch) => albums.addPhotos(albumId, batch));
        if (results.some((result) => skippedCount(result) > 0)) throw new Error("some photos were skipped");
      } finally {
        await refreshAfterPhotoChange();
      }
    },
    [albumsTool, batchSize, refreshAfterPhotoChange],
  );
  const removePhotosFromAlbum = useCallback(
    async (albumId: string, photoIds: readonly string[]): Promise<void> => {
      try {
        const albums = requireTool(albumsTool, "albums");
        const results = await runPhotoCloudPhotoBatches(photoIds, batchSize, (batch) => albums.removePhotos(albumId, batch));
        if (!photoCloudAlbumRemovalIsComplete(photoIds, batchSize, results)) throw new Error("some photos were not removed");
      } finally {
        await refreshAfterPhotoChange();
      }
    },
    [albumsTool, batchSize, refreshAfterPhotoChange],
  );

  return {
    albums: query.data?.albums ?? [],
    isPending: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
    createAlbum,
    renameAlbum,
    deleteAlbum,
    setPhotosFavorite,
    addPhotosToAlbum,
    removePhotosFromAlbum,
  };
}
