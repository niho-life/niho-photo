/**
 * Render jobs on the device that holds the original (B07 #248): the executor, the finished-output pipeline, the
 * engine and personal-cloud adapters for the Mac app and browser, the ticket uploader, and a synthetic queue for
 * development and tests. Not wired into any host yet.
 */
export {
  createSourceDeviceRenderExecutor,
  type CreateSourceDeviceRenderExecutorOptions,
  type PhotoRef,
  type RenderExecutorTransport,
  type RenderSourcePort,
  type SourceDeviceRenderEvent,
  type SourceDeviceRenderExecutor,
  type SourceDeviceRenderOutcome,
  type SourceDeviceRenderSummary,
} from "./render-executor";
export {
  SOURCE_DEVICE_PREVIEW_MAX_EDGE,
  SourceDeviceRenderFailure,
  checkRenderable,
  renderFinishedOutput,
  type DeviceRenderer,
  type FinishedOutput,
  type RenderSource,
  type RenderedJpeg,
} from "./render-output";
export {
  RENDITION_EXIF_ALLOWED_TAGS,
  jpegMetadataRecord,
  renditionMetadataViolations,
  scanJpegMetadata,
  stripJpegMetadata,
  type JpegMetadataScan,
  type JpegMetadataSegmentKind,
} from "./jpeg-metadata";
export {
  DEVELOP_ENGINE_FULL_RESOLUTION_MAX_EDGE,
  DEVELOP_ENGINE_RENDER_FORMATS,
  createDevelopEngineDeviceRenderer,
  type CreateDevelopEngineDeviceRendererOptions,
} from "./engine-renderer";
export { createPersonalCloudRenderSource } from "./personal-cloud-source";
export { createTicketUploader, type CreateTicketUploaderOptions, type RenderOutputUploader } from "./ticket-upload";
export { createRenderJobMockServer, type CreateRenderJobMockServerOptions, type RenderJobMockItem, type RenderJobMockServer } from "./render-mock";
