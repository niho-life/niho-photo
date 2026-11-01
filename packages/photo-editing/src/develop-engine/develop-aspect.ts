export const FIXED_ASPECT_PATTERN = /^([1-9]\d{0,3}):([1-9]\d{0,3})$/;

/** `aspect` として書ける値か（crate の `is_aspect`: `free`・`original`・`originalSwapped`・`<w>:<h>`〔1〜9999〕）。 */
export function isDevelopAspect(aspect: string): boolean {
  return aspect === "free" || aspect === "original" || aspect === "originalSwapped" || FIXED_ASPECT_PATTERN.test(aspect);
}
