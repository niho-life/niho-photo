import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanelLeft, X } from "lucide-react";
import icon from "../src-tauri/icons/128x128.png";

import {
  BrowserPhotoEditingWorkbench,
  type BrowserPhotoCopyToCloudBinding,
} from "niho-photo-editing/editor/browser-photo-editing-workbench";
import type { PhotoEditingLeaveGuard } from "niho-photo-editing/editor/browser-photo-editing-model";
import type { PhotoLibrary } from "niho-photo-editing/library/photo-library";
import {
  PhotoLibraryProvider,
  type PhotoEditingHost,
} from "niho-photo-editing/library/photo-library-context";
import { PhotoLibraryScreenTabs, type PhotoLibraryScreen } from "niho-photo-editing/shared-album/photo-shared-album-list";
import type { PhotoSharedAlbumPort } from "niho-photo-editing/shared-album/photo-shared-album-port";
import { PhotoSharedAlbumWorkspace } from "niho-photo-editing/shared-album/photo-shared-album-workspace";
import { PhotoSettingsButton, PhotoStorageSettingsDialog } from "niho-photo-editing/shared-album/photo-storage-settings-dialog";
import { readLocalStorageItemSafely, removeLocalStorageItemSafely, writeLocalStorageItemSafely } from "niho-ui/local-storage-safe";
import { AppDialogHost } from "niho-ui/components/app-dialog-host";

import { readAppInfo, type CameraAppInfo } from "./camera-bridge";
import { CameraAccount } from "./camera-account";
import { CameraHeaderBreadcrumb } from "./camera-header-breadcrumb";
import { CameraUpdateNotice, type WatchUpdate } from "./camera-update-notice";
import { HostedFolders, type HostedFolderCommands } from "./hosted-connector/hosted-folders";
import { createCameraCommands, type CameraCommands } from "./local-library/commands";
import { createLocalPhotoEditingHost } from "./local-library/local-photo-editing-host";
import { createLocalPhotoCutoutHost } from "./local-library/local-photo-cutout-host";
import { createLocalPhotoLibrary } from "./local-library/local-photo-library";
import { useGuardedCloudBinding } from "./use-guarded-cloud-binding";

/** 初回の案内（旧 NIHO camera の補正は引き継がない）を閉じたことを、この端末に覚える鍵。 */
export const PHOTO_BENCH_NOTICE_DISMISSED_KEY = "niho-camera:photo-bench-notice-dismissed";
/** 左のパネル（写真の場所の木）を隠していることを、この端末に覚える鍵（値は "1"）。保存先切替は常に表示する。 */
export const PHOTO_TREE_HIDDEN_KEY = "niho-camera:photo-tree-hidden";
export const PHOTO_BENCH_NOTICE_TEXT =
  "旧 NIHO camera（Photo Bench）で保存した補正は引き継がれません。写真はそのまま開いて直せます。";

/**
 * Trusted host が private integration から注入する、本人のクラウド写真の接続口。
 * upload、冪等性、再開、資格情報は `copyLocalPhoto` の実装に閉じ、React へは渡さない。
 */
export type PersonalCloudPhotoBinding = {
  library: PhotoLibrary;
  host: PhotoEditingHost;
  actorId: string;
  /** actor/library/session/epoch/transport の衝突しないtuple。認可には使わず、query/editorを論理sessionごとに分ける。 */
  scopeKey?: string;
  copyLocalPhoto?: BrowserPhotoCopyToCloudBinding["copyLocalPhoto"];
  /**
   * 「共有アルバム」と設定の「保存先」（B08 #249）。rollout が開いたときだけ host が渡す（無ければ何も出さない）。共有アルバムの
   * client はまだ browser の session だけに対応するので、Mac の native session 用の transport が入るまで host は渡さない。
   */
  sharedAlbums?: PhotoSharedAlbumPort;
};

export type AppProps = {
  /** native のコマンド（テストで差し替える。既定は Tauri の invoke） */
  commands?: CameraCommands;
  /** テストで差し替える（既定は native の camera_app_info）。 */
  loadAppInfo?: () => Promise<CameraAppInfo | null>;
  /** テストで差し替える（既定は native の自動更新の状態。camera_update_status と update-staged の event）。 */
  watchUpdate?: WatchUpdate;
  /** Trusted host が明示的に渡したときだけ、個人クラウドの UI と操作を有効にする。 */
  cloudBinding?: PersonalCloudPhotoBinding;
  /**
   * 常設 Mac の接続用ソフトに渡すフォルダの登録（Epic #240 / B03 #244）。接続先を持つ trusted host が渡したときだけ
   * header に出す（公開の build は接続先を持たないので出さない）。
   */
  hostedFolders?: HostedFolderCommands;
  /** 設定の「保存先」から自前サーバー（常設 Mac）の登録を始める入口（登録の画面は常設 Mac 側。無ければ出さない）。 */
  onAddHostedMac?: () => void;
};

type PhotoSource = "local" | "cloud";

function usableCloudBinding(binding: PersonalCloudPhotoBinding | undefined): binding is PersonalCloudPhotoBinding {
  return Boolean(binding && binding.actorId.trim() && binding.library.place === "cloud");
}

function personalPhotoScope(actorId: string, source: PhotoSource): string {
  return `personal-user:${encodeURIComponent(actorId)}:${source}`;
}

function PhotoSourceTabs(props: {
  source: PhotoSource;
  switching: boolean;
  onSelect: (source: PhotoSource) => void;
}) {
  return (
    <div role="group" aria-label="写真の保存先" className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-niho-pale/60 p-1">
      {([
        ["cloud", "クラウド"],
        ["local", "この Mac"],
      ] as const).map(([source, label]) => (
        <button
          key={source}
          type="button"
          aria-pressed={props.source === source}
          disabled={props.switching}
          onClick={() => props.onSelect(source)}
          className={`min-h-9 rounded-lg px-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-wait ${
            props.source === source
              ? "bg-white text-niho-accent-ink shadow-sm"
              : "text-niho-text-sub hover:bg-white/70 hover:text-niho-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

let defaultCommands: CameraCommands | null = null;
export function cameraCommands(): CameraCommands {
  defaultCommands ??= createCameraCommands();
  return defaultCommands;
}

function createQueryClient(): QueryClient {
  // この Mac の native の呼び出しは通信ではないので、失敗をすぐ見せる（やり直しは 1 回だけ）
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/**
 * 初回の案内（spec「データ（この Mac）」）: 旧 NIHO camera（Photo Bench）の補正がこの Mac にあれば、閉じるまで 1 行出す。閉じたら
 * この端末に覚えて二度と出さない（覚えられない環境では、その起動の間だけ消す）。
 */
function usePhotoBenchNotice(commands: Pick<CameraCommands, "photoBenchEditsFound">) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (readLocalStorageItemSafely(PHOTO_BENCH_NOTICE_DISMISSED_KEY) !== null) return;
    let active = true;
    commands.photoBenchEditsFound().then(
      (found) => {
        if (active && found) setShown(true);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [commands]);
  const dismiss = () => {
    writeLocalStorageItemSafely(PHOTO_BENCH_NOTICE_DISMISSED_KEY, new Date().toISOString());
    setShown(false);
  };
  return { shown, dismiss };
}

/** 左のパネルの表示 / 非表示（header の「左のパネル」。この端末に覚える）。 */
function useTreeHidden() {
  const [hidden, setHidden] = useState(() => readLocalStorageItemSafely(PHOTO_TREE_HIDDEN_KEY) === "1");
  const toggle = () => {
    setHidden((current) => {
      const next = !current;
      if (next) writeLocalStorageItemSafely(PHOTO_TREE_HIDDEN_KEY, "1");
      else removeLocalStorageItemSafely(PHOTO_TREE_HIDDEN_KEY);
      return next;
    });
  };
  return { hidden, toggle };
}

/**
 * NIHO photo の画面（spec「画面」）。共通の編集面（packages/photo-editing の `BrowserPhotoEditingWorkbench`）を、この Mac の
 * `PhotoLibrary`（native のフォルダ・写真・現像）と同梱の wasm で動かす。trusted host が個人クラウドを注入したときだけ、同じ面を
 * 本人のクラウド `PhotoLibrary` へ切り替える。左に場所、中央に写真、右に補正（どれも編集面の部品）。
 * 窓のタイトルバーにアイコンと名前を一度だけ表示し、その下の帯は左端の「左のパネル」（木の表示 / 非表示）と表示中の場所（編集面のパンくず）に使う。
 * 編集面は窓の底まで使い（`appearance="fill"`）、版は左の木の底の目立たない 1 行。自動更新で新しい版を入れたときだけ、編集面の上に 1 行の案内
 * （niho-photo#50）。
 */
export function App({ commands, loadAppInfo = readAppInfo, watchUpdate, cloudBinding, hostedFolders, onAddHostedMac }: AppProps) {
  const native = commands ?? cameraCommands();
  const localLibrary = useMemo(() => createLocalPhotoLibrary(native), [native]);
  const localHost = useMemo(() => createLocalPhotoEditingHost(native), [native]);
  const cutout = useMemo(() => createLocalPhotoCutoutHost(native, localLibrary.withStablePhoto), [localLibrary, native]);
  const incomingCloud = usableCloudBinding(cloudBinding) ? cloudBinding : null;
  const incomingCloudSecurityKey = incomingCloud === null
    ? null
    : JSON.stringify([incomingCloud.actorId, incomingCloud.scopeKey ?? null]);
  const cloudSecurityKeyRef = useRef(incomingCloudSecurityKey);
  cloudSecurityKeyRef.current = incomingCloudSecurityKey;
  const [source, setSource] = useState<PhotoSource>("local");
  const [sourceSwitching, setSourceSwitching] = useState(false);
  const [openCloudPhotoId, setOpenCloudPhotoId] = useState<string | null>(null);
  const leaveGuardRef = useRef<PhotoEditingLeaveGuard | null>(null);
  const sourceSwitchRef = useRef(false);
  const sourceSwitchGenerationRef = useRef(0);
  const [screen, setScreen] = useState<{ readonly current: PhotoLibraryScreen; readonly visited: boolean }>({ current: "photos", visited: false });
  const [settingsScope, setSettingsScope] = useState<string | null>(null);
  const resetForCloudOwnerChange = useCallback(() => {
    sourceSwitchGenerationRef.current += 1;
    sourceSwitchRef.current = false;
    setSourceSwitching(false);
    setSource("local");
    setOpenCloudPhotoId(null);
    // Another owner's albums never stay on screen.
    setScreen({ current: "photos", visited: false });
    setSettingsScope(null);
  }, []);
  const cloudBindingTransition = useGuardedCloudBinding({
    incoming: incomingCloud,
    leaveGuardRef,
    onOwnerChange: resetForCloudOwnerChange,
  });
  const cloud = cloudBindingTransition.binding;
  const [queryClient] = useState(createQueryClient);
  const [appInfo, setAppInfo] = useState<CameraAppInfo | null>(null);
  const notice = usePhotoBenchNotice(native);
  const tree = useTreeHidden();

  useEffect(() => {
    if (!cloud && source === "cloud") setSource("local");
  }, [cloud, source]);

  const registerRouteLeaveGuard = useCallback((guard: PhotoEditingLeaveGuard | null) => {
    leaveGuardRef.current = guard;
  }, []);
  const selectSource = useCallback(async (next: PhotoSource, cloudPhotoId: string | null = null) => {
    if (!cloud || next === source || sourceSwitchRef.current) return;
    const securityKey = cloudSecurityKeyRef.current;
    const generation = ++sourceSwitchGenerationRef.current;
    sourceSwitchRef.current = true;
    setSourceSwitching(true);
    try {
      const canLeave = await (leaveGuardRef.current?.() ?? Promise.resolve(true));
      if (!canLeave || cloudSecurityKeyRef.current !== securityKey || sourceSwitchGenerationRef.current !== generation) return;
      setOpenCloudPhotoId(next === "cloud" ? cloudPhotoId : null);
      setSource(next);
    } finally {
      if (sourceSwitchGenerationRef.current === generation) {
        sourceSwitchRef.current = false;
        setSourceSwitching(false);
      }
    }
  }, [cloud, source]);

  const activeSource: PhotoSource = cloud ? source : "local";
  const library = activeSource === "cloud" && cloud ? cloud.library : localLibrary;
  const host = activeSource === "cloud" && cloud ? cloud.host : localHost;
  const sourceKey = activeSource === "cloud" && cloud ? personalPhotoScope(cloud.actorId, activeSource) : "local";
  const queryScopeKey = activeSource === "cloud" ? cloud?.scopeKey : undefined;
  const libraryKey = queryScopeKey === undefined ? sourceKey : `${sourceKey}:scope:${queryScopeKey}`;
  const actorId = activeSource === "cloud" && cloud ? cloud.actorId : "local";
  const copyToCloud = useMemo<BrowserPhotoCopyToCloudBinding | undefined>(() =>
    cloud?.copyLocalPhoto && !cloudBindingTransition.switching && !cloudBindingTransition.failed ? {
      copyLocalPhoto: cloud.copyLocalPhoto,
      onOpenCloudPhoto: (photoId) => {
        void selectSource("cloud", photoId);
      },
    } : undefined, [cloud, cloudBindingTransition.failed, cloudBindingTransition.switching, selectSource]);
  const sharedAlbums = cloud?.sharedAlbums ?? null;
  // The settings belong to the cloud scope they were opened in; another scope never sees them (even for one render).
  const sharedScope = sharedAlbums && cloud ? `${cloud.actorId}:${cloud.scopeKey ?? ""}` : null;
  const settingsOpen = sharedScope !== null && settingsScope === sharedScope;
  const setSettingsOpen = useCallback((open: boolean) => setSettingsScope(open ? sharedScope : null), [sharedScope]);
  const activeScreen: PhotoLibraryScreen = sharedAlbums ? screen.current : "photos";
  const sharedAlbumsMounted = sharedAlbums !== null && (screen.visited || activeScreen === "sharedAlbums");
  const loadStorageLocations = useCallback(async (signal: AbortSignal) => [
    ...(sharedAlbums ? await sharedAlbums.storageLocations(signal) : []),
    { locationId: "thisMac", kind: "thisMac" as const, name: null, hostedMacStatus: null, usage: null },
  ], [sharedAlbums]);
  const sourceTabs = cloud ? (
    <PhotoSourceTabs
      source={activeSource}
      switching={sourceSwitching || cloudBindingTransition.switching || cloudBindingTransition.failed}
      onSelect={(next) => void selectSource(next)}
    />
  ) : undefined;

  useEffect(() => {
    let active = true;
    void loadAppInfo().then((info) => {
      if (active) setAppInfo(info);
    });
    return () => {
      active = false;
    };
  }, [loadAppInfo]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppDialogHost />
      <div className="flex h-full flex-col">
        <div className="photo-titlebar" data-tauri-drag-region>
          <img src={icon} alt="" draggable={false} />
          <h1 data-tauri-drag-region>NIHO photo</h1>
        </div>
        <header
          className="flex h-11 shrink-0 select-none items-center gap-3 border-b border-niho-border px-3 sm:px-4"
          data-tauri-drag-region
        >
          <button
            type="button"
            aria-label="左のパネル"
            aria-pressed={!tree.hidden}
            title="左のパネル"
            onClick={tree.toggle}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-sub transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink aria-pressed:bg-niho-accent-soft aria-pressed:text-niho-accent-ink"
          >
            <PanelLeft className="h-[18px] w-[18px]" aria-hidden />
          </button>
          <div className="min-w-0 flex-1" data-tauri-drag-region>
            <CameraHeaderBreadcrumb />
          </div>
          {hostedFolders ? <HostedFolders commands={hostedFolders} /> : null}
          {sharedAlbums ? <PhotoSettingsButton onClick={() => setSettingsOpen(true)} /> : null}
          <CameraAccount />
        </header>
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-4 pt-3 empty:hidden">
            <CameraUpdateNotice watch={watchUpdate} />
            {cloudBindingTransition.failed ? (
              <div role="alert" className="mb-3 flex items-center gap-3 rounded-xl border border-niho-danger/30 bg-niho-danger/10 px-4 py-2.5 text-sm text-niho-text-sub">
                <p className="min-w-0 flex-1">写真の編集中または操作中のため、アカウントの切替を保留しました。編集を保存または操作を完了してから再試行してください。</p>
                <button
                  type="button"
                  disabled={cloudBindingTransition.switching}
                  onClick={() => void cloudBindingTransition.retry()}
                  className="shrink-0 rounded-lg px-3 py-1.5 font-bold text-niho-accent-ink hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-wait"
                >
                  再試行
                </button>
              </div>
            ) : null}
            {notice.shown ? (
              <div
                role="status"
                className="mb-3 flex items-center gap-3 rounded-xl border border-niho-border bg-white px-4 py-2.5 text-sm text-niho-text-sub"
              >
                <p className="min-w-0 flex-1">{PHOTO_BENCH_NOTICE_TEXT}</p>
                <button
                  type="button"
                  aria-label="案内を閉じる"
                  onClick={notice.dismiss}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-muted transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : null}
            {sharedAlbums ? (
              <div className="mb-3">
                <PhotoLibraryScreenTabs current={activeScreen} onChange={(next) => setScreen({ current: next, visited: true })} />
              </div>
            ) : null}
            {activeScreen === "photos" ? sourceTabs : null}
          </div>
          {sharedAlbumsMounted && sharedAlbums && cloud ? (
            // Kept mounted after the first visit so additions keep going while 写真 is shown.
            <div className={activeScreen === "sharedAlbums" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <PhotoSharedAlbumWorkspace key={`${cloud.actorId}:${cloud.scopeKey ?? ""}`} port={sharedAlbums} onOpenStorage={() => setSettingsOpen(true)} />
            </div>
          ) : null}
          <div className={activeScreen === "photos" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <PhotoLibraryProvider key={libraryKey} library={library} host={host}>
            <BrowserPhotoEditingWorkbench
              key={libraryKey}
              spotId={libraryKey}
              scopeKey={queryScopeKey}
              actorId={actorId}
              canEdit
              cloudOriginalsAllowed={false}
              active={activeScreen === "photos"}
              openCloudPhotoId={activeSource === "cloud" ? openCloudPhotoId : null}
              onOpenCloudPhotoHandled={() => setOpenCloudPhotoId(null)}
              registerRouteLeaveGuard={registerRouteLeaveGuard}
              // 個人クラウドの削除・退会purge APIはまだ非公開側で未実装なので、接続後も削除を止める。
              disableCloudDelete
              cutout={activeSource === "local" ? cutout : undefined}
              appearance="fill"
              treeHidden={tree.hidden}
              treeFooter={appInfo ? <span>版 {appInfo.appVersion}</span> : null}
              copyToCloud={activeSource === "local" ? copyToCloud : undefined}
            />
          </PhotoLibraryProvider>
          </div>
          {sharedAlbums ? (
            <PhotoStorageSettingsDialog
              key={sharedScope ?? ""}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              loadLocations={loadStorageLocations}
              {...(onAddHostedMac ? { onAddHostedMac } : {})}
            />
          ) : null}
        </main>
      </div>
    </QueryClientProvider>
  );
}
