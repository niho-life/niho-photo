"use client";

import { createContext, useContext, type ReactNode } from "react";

const PhotoEditingImageCorsContext = createContext(false);

/**
 * Enables anonymous CORS requests for photo images inside an isolated browser document.
 * The caller must only enable this when the remote image origins return a matching
 * Access-Control-Allow-Origin response header.
 */
export function PhotoEditingImageCorsProvider(props: { enabled: boolean; children: ReactNode }) {
  return <PhotoEditingImageCorsContext.Provider value={props.enabled}>{props.children}</PhotoEditingImageCorsContext.Provider>;
}

export function usePhotoEditingImageCors(): boolean {
  return useContext(PhotoEditingImageCorsContext);
}
