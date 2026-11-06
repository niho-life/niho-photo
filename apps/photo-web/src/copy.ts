import {
  PHOTO_EDITING_PERSONAL_CLOUD_TRANSFER_COPY,
  PHOTO_WEB_AUTH_COPY,
  PHOTO_WEB_COPY,
  photoWebUsageLabel,
} from "niho-photo-editing/photo-editing-copy";
import type { PhotoWebTransferCopy, PhotoWebViewCopy } from "./view/types";

/** Shared product copy mapped to each host boundary; no private or identity metadata. */
export const PHOTO_WEB_VIEW_COPY: PhotoWebViewCopy = Object.freeze({ ...PHOTO_WEB_COPY, usage: photoWebUsageLabel });
export const PHOTO_WEB_TRANSFER_COPY: PhotoWebTransferCopy = PHOTO_EDITING_PERSONAL_CLOUD_TRANSFER_COPY;
export const PHOTO_WEB_APPLICATION_COPY = Object.freeze({
  name: PHOTO_WEB_COPY.brand,
  shortName: PHOTO_WEB_COPY.brand,
  description: PHOTO_WEB_COPY.subtitle,
});
export const PHOTO_WEB_OFFLINE_COPY = Object.freeze({ title: PHOTO_WEB_COPY.brand, message: PHOTO_WEB_COPY.offline });
export const PHOTO_WEB_NAVIGATION_ERROR_COPY = Object.freeze({
  title: PHOTO_WEB_COPY.brand,
  message: PHOTO_WEB_COPY.unavailable,
  homeLabel: PHOTO_WEB_COPY.homeLabel,
});
export const PHOTO_WEB_SERVER_AUTH_COPY = PHOTO_WEB_AUTH_COPY;
