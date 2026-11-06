import type { QueryClient } from "@tanstack/react-query";
import type {
  BrowserPersonalPhotoTransferController,
  PersonalPhotoTransferStatus,
} from "../../../../packages/photo-cloud-library/src/browser/index.ts";
import type { PhotoSessionSnapshot } from "../../../../packages/photo-cloud-session/src/index.ts";
import type { FormatCapability, QuotaUsage } from "../../../../packages/photo-library-contract/src/v2";
import type { PhotoLibrary } from "niho-photo-editing/library/photo-library";
import type { PhotoEditingHost } from "niho-photo-editing/library/photo-library-context";
import type { PhotoEditingLeaveGuardRegistrar } from "niho-photo-editing/editor/browser-photo-editing-model";
import type { PhotoSharedAlbumOpenedInvite, PhotoSharedAlbumPort } from "niho-photo-editing/shared-album/photo-shared-album-port";
import type { PhotoPwaUpdateSnapshot } from "../pwa/types";

export interface PhotoWebTransferCopy {
  readonly toolbar: string;
  readonly pendingTitle: string;
  readonly add: string;
  readonly resume: string;
  readonly chooseSameFile: string;
  readonly cancel: string;
  readonly refresh: string;
  readonly next: string;
  readonly first: string;
  readonly busy: string;
  readonly failed: string;
  readonly unsupported: string;
  readonly refreshFailed: string;
  readonly phaseLabels: Readonly<Record<PersonalPhotoTransferStatus["phase"], string>>;
}

export interface PhotoWebTransferBinding {
  readonly controller: BrowserPersonalPhotoTransferController;
  readonly formats: readonly FormatCapability[];
  readonly copy: PhotoWebTransferCopy;
  readonly describeError: (error: unknown) => string;
  readonly onSettled: (status: PersonalPhotoTransferStatus) => void | Promise<void>;
}

/** Host runtime supplies accepted C02/C03 bindings; this view creates no client or persistent journal. */
export interface PhotoWebViewBinding {
  readonly key: string;
  readonly scopeKey: string;
  readonly actorId: string;
  readonly library: PhotoLibrary;
  readonly host: PhotoEditingHost;
  readonly canEdit: boolean;
  readonly cloudOriginalsAllowed: boolean;
  readonly mobileEditingAllowed: boolean;
  readonly disableCloudDelete: boolean;
  readonly usage: QuotaUsage | null;
  readonly transfer?: PhotoWebTransferBinding;
  /** 「共有アルバム」と設定の「保存先」。rollout が開いた拠点だけ（無ければ何も出さない） */
  readonly sharedAlbums?: PhotoSharedAlbumPort;
}

/** Values will come from shared photo-editing-copy; no product copy strings live in this view. */
export interface PhotoWebViewCopy {
  readonly brand: string;
  readonly title: string;
  readonly subtitle: string;
  readonly login: string;
  readonly verifying: string;
  readonly unavailable: string;
  readonly retry: string;
  readonly logout: string;
  readonly cloud: string;
  readonly toggleTree: string;
  readonly offline: string;
  readonly failed: string;
  readonly version: string;
  readonly pwaAvailable: string;
  readonly pwaPreparing: string;
  readonly pwaBlocked: string;
  readonly pwaFailed: string;
  readonly pwaApply: string;
  readonly usage: (usage: QuotaUsage) => string;
}

export interface PhotoWebViewProps {
  /**
   * An opened invite, used once when shared albums are open: the link's secret read from the address bar (memory only),
   * or an invite the BFF holds from before signing in.
   */
  readonly invite?: PhotoSharedAlbumOpenedInvite | null;
  /** The invite was used; the host drops it. */
  readonly onInviteHandled?: () => void;
  /** Runtime owns clearing/canceling query resources on authority invalidation. */
  readonly queryClient: QueryClient;
  readonly session: PhotoSessionSnapshot;
  readonly binding: PhotoWebViewBinding | null;
  readonly dialogScopeKey: string;
  readonly copy: PhotoWebViewCopy;
  readonly iconUrl: string;
  readonly online: boolean;
  readonly pwa: null | {
    readonly snapshot: PhotoPwaUpdateSnapshot;
    readonly requestUpdate: () => Promise<"applied" | "blocked" | "failed">;
  };
  readonly onRetry: () => Promise<void>;
  readonly onLogout: () => Promise<void>;
  readonly registerRouteLeaveGuard: PhotoEditingLeaveGuardRegistrar;
}
