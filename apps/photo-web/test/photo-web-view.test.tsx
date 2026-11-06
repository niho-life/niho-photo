import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PhotoWebTransferBinding,
  PhotoWebViewBinding,
  PhotoWebViewCopy,
  PhotoWebViewProps,
} from "../src/view/types";

const mockState = vi.hoisted(() => ({
  workbenchProps: [] as Array<Record<string, unknown>>,
  workbenchQueryClients: [] as Array<unknown>,
  providerProps: [] as Array<Record<string, unknown>>,
  transferPanelProps: [] as Array<Record<string, unknown>>,
  workspaceProps: [] as Array<Record<string, unknown>>,
  settingsProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("niho-photo-editing/shared-album/photo-shared-album-workspace", () => ({
  PhotoSharedAlbumWorkspace: (props: Record<string, unknown>) => {
    mockState.workspaceProps.push(props);
    return <div data-testid="shared-workspace" />;
  },
}));

vi.mock("niho-photo-editing/shared-album/photo-storage-settings-dialog", () => ({
  PhotoStorageSettingsDialog: (props: Record<string, unknown>) => {
    mockState.settingsProps.push(props);
    return props.open ? <div data-testid="settings-dialog" /> : null;
  },
}));

vi.mock("niho-photo-editing/editor/browser-photo-editing-workbench", async () => {
  const { useQueryClient } = await import("@tanstack/react-query");
  return {
    BrowserPhotoEditingWorkbench: (props: Record<string, unknown>) => {
      mockState.workbenchProps.push(props);
      mockState.workbenchQueryClients.push(useQueryClient());
      return <div data-testid="workbench">{props.treeFooter as ReactNode}</div>;
    },
  };
});

vi.mock("niho-photo-editing/library/photo-library-context", () => ({
  PhotoLibraryProvider: (props: Record<string, unknown>) => {
    mockState.providerProps.push(props);
    return <div data-testid="provider">{props.children as ReactNode}</div>;
  },
}));

vi.mock("niho-ui/components/app-dialog-host", () => ({
  AppDialogHost: () => <div data-testid="dialog-host" />,
}));

vi.mock("../src/view/PhotoWebTransferPanel", () => ({
  PhotoWebTransferPanel: (props: Record<string, unknown>) => {
    mockState.transferPanelProps.push(props);
    return <div data-testid="transfer-panel" />;
  },
}));

import { PhotoWebView } from "../src/view/PhotoWebView";

const copy: PhotoWebViewCopy = {
  brand: "写真ブランド",
  title: "写真を整える",
  subtitle: "自分の写真を表示します",
  login: "ログイン",
  verifying: "確認中",
  unavailable: "利用できません",
  retry: "再試行",
  logout: "ログアウト",
  cloud: "クラウド",
  toggleTree: "左パネル",
  offline: "オフライン",
  failed: "操作に失敗しました",
  version: "版 合成",
  pwaAvailable: "更新があります",
  pwaPreparing: "更新を準備中",
  pwaBlocked: "更新を保留しました",
  pwaFailed: "更新に失敗しました",
  pwaApply: "更新する",
  usage: (usage) => `使用量 ${usage.usedBytes}`,
};

const usage = {
  quotaBytes: 100,
  usedBytes: 20,
  originalBytes: 15,
  maskBytes: 5,
  pendingPurgeBytes: 0,
  reservedBytes: 0,
  availableBytes: 80,
};

function session(phase: PhotoWebViewProps["session"]["phase"], userId: string | null = "利用者甲"): PhotoWebViewProps["session"] {
  return {
    phase,
    identity: userId === null ? null : {
      userId,
      sessionId: "セッション不透明値",
      sessionEpoch: "世代不透明値",
      transport: "browser-session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    cloudOperationsAvailable: phase === "ready",
    localEditingAvailable: true,
    error: phase === "unavailable" ? "temporarily-unavailable" : null,
  };
}

function binding(overrides: Partial<PhotoWebViewBinding> = {}): PhotoWebViewBinding {
  return {
    key: "置場不透明値甲",
    scopeKey: "範囲不透明値甲",
    actorId: "利用者甲",
    library: { place: "cloud" } as PhotoWebViewBinding["library"],
    host: {} as PhotoWebViewBinding["host"],
    canEdit: true,
    cloudOriginalsAllowed: true,
    mobileEditingAllowed: true,
    disableCloudDelete: false,
    usage,
    ...overrides,
  };
}

function transferBinding(): PhotoWebTransferBinding {
  return {
    controller: {
      checkCapability: vi.fn(async () => true),
      start: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      list: vi.fn(),
      readPendingRecipe: vi.fn(),
      dispose: vi.fn(),
    },
    formats: [],
    copy: {} as PhotoWebTransferBinding["copy"],
    describeError: () => "",
    onSettled: vi.fn(),
  };
}

function scopedHost() {
  const scopeController = new AbortController();
  return {
    scopeController,
    host: {
      scopeSignal: scopeController.signal,
      isScopeCurrent: () => true,
      notifyPhotosChanged: vi.fn(),
      saveFile: vi.fn(async () => "downloaded" as const),
      nativeFileSaveAvailable: () => false,
      isNativeViewport: () => false,
      isDesktopApp: () => false,
    } satisfies PhotoWebViewBinding["host"],
  };
}

function props(overrides: Partial<PhotoWebViewProps> = {}): PhotoWebViewProps {
  return {
    queryClient: new QueryClient(),
    session: session("ready"),
    binding: binding(),
    dialogScopeKey: "利用者甲:資源世代1",
    copy,
    iconUrl: "/owned-icon.png",
    online: true,
    pwa: null,
    onRetry: vi.fn(async () => undefined),
    onLogout: vi.fn(async () => undefined),
    registerRouteLeaveGuard: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function byText(container: HTMLElement, selector: string, text: string): HTMLElement {
  const element = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((candidate) => candidate.textContent === text);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}

describe("PhotoWebView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mockState.workbenchProps.length = 0;
    mockState.workbenchQueryClients.length = 0;
    mockState.providerProps.length = 0;
    mockState.transferPanelProps.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(viewProps: PhotoWebViewProps) {
    act(() => root.render(<PhotoWebView {...viewProps} />));
  }

  it("未認証では入力を足さない固定POSTログインだけを出す", () => {
    render(props({ session: session("signed-out", null), binding: binding() }));

    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/auth/start");
    expect(form?.querySelectorAll("input")).toHaveLength(0);
    expect(byText(container, "button", copy.login).getAttribute("type")).toBe("submit");
    expect(container.querySelector('[data-testid="workbench"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="dialog-host"]')).toHaveLength(1);
    expect(container.textContent).not.toContain(copy.toggleTree);
  });

  it.each([
    ["別owner", session("ready", "利用者乙"), binding()],
    ["unavailable", session("unavailable"), binding()],
    ["空key", session("ready"), binding({ key: " " })],
    ["空scope", session("ready"), binding({ scopeKey: "" })],
    ["local library", session("ready"), binding({ library: { place: "local" } as PhotoWebViewBinding["library"] })],
  ])("%s の古いWorkbenchを表示しない", (_name, nextSession, nextBinding) => {
    render(props({ session: nextSession, binding: nextBinding }));
    expect(container.querySelector('[data-testid="workbench"]')).toBeNull();
    expect(container.textContent).toContain(copy.unavailable);
    expect(container.textContent).not.toContain(copy.toggleTree);
  });

  it("同じ本人とbindingの通常verifyingではWorkbench instanceを保つ", () => {
    const accepted = binding();
    render(props({ session: session("ready"), binding: accepted }));
    const before = container.querySelector('[data-testid="workbench"]');

    render(props({ session: session("verifying"), binding: accepted }));

    expect(container.querySelector('[data-testid="workbench"]')).toBe(before);
    expect(container.textContent).toContain(copy.verifying);
  });

  it("accepted bindingのcapabilityとguardを忠実にWorkbenchへ渡す", () => {
    const queryClient = new QueryClient();
    const guard = vi.fn();
    const accepted = binding({
      canEdit: false,
      cloudOriginalsAllowed: false,
      mobileEditingAllowed: false,
      disableCloudDelete: true,
    });
    render(props({ queryClient, binding: accepted, registerRouteLeaveGuard: guard }));

    const workbench = mockState.workbenchProps.at(-1);
    expect(workbench).toMatchObject({
      spotId: accepted.key,
      scopeKey: accepted.scopeKey,
      actorId: accepted.actorId,
      canEdit: false,
      cloudOriginalsAllowed: false,
      mobileEditingAllowed: false,
      disableCloudDelete: true,
      appearance: "fill",
      active: true,
      openCloudPhotoId: null,
      registerRouteLeaveGuard: guard,
      treeHidden: false,
    });
    expect(mockState.workbenchQueryClients.at(-1)).toBe(queryClient);
    expect(mockState.providerProps.at(-1)).toMatchObject({ library: accepted.library, host: accepted.host });
    expect(container.textContent).toContain(copy.version);
    expect(container.querySelector(".photo-web-transfer")).toBeNull();

    act(() => byText(container, "button", copy.toggleTree).click());
    expect(mockState.workbenchProps.at(-1)?.treeHidden).toBe(true);
  });

  it.each([
    ["ready+online", "ready", true, true],
    ["verifying+online", "verifying", true, false],
    ["ready+offline", "ready", false, false],
  ] as const)("transfer descriptorを持つ%sではWorkbenchの直前にpanelを1つ置く", (_name, phase, online, mutationEnabled) => {
    const transfer = transferBinding();
    const { host } = scopedHost();
    render(props({
      session: session(phase),
      online,
      binding: binding({ transfer, host }),
    }));

    expect(container.querySelectorAll('[data-testid="transfer-panel"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="workbench"]')).toHaveLength(1);
    const stack = container.querySelector(".photo-web-workspace-stack");
    expect(stack?.children[0]?.getAttribute("data-testid")).toBe("transfer-panel");
    expect(stack?.children[1]?.classList.contains("photo-web-workbench")).toBe(true);
    expect(mockState.transferPanelProps).toHaveLength(1);
    expect(mockState.transferPanelProps[0]).toMatchObject({ transfer, host, mutationEnabled });
  });

  it.each([
    { canEdit: false },
    { cloudOriginalsAllowed: false },
  ])("原本保存policyが閉じるbindingではtransfer mutationを止める: %o", (policy) => {
    const transfer = transferBinding();
    const { host } = scopedHost();
    render(props({ binding: binding({ transfer, host, ...policy }) }));
    expect(mockState.transferPanelProps.at(-1)?.mutationEnabled).toBe(false);
    expect(container.querySelectorAll('[data-testid="workbench"]')).toHaveLength(1);
  });

  it.each([
    ["descriptorなし", (host: PhotoWebViewBinding["host"]) => binding({ host })],
    ["scopeSignalなし", (host: PhotoWebViewBinding["host"]) => binding({
      transfer: transferBinding(),
      host: { ...host, scopeSignal: undefined },
    })],
    ["isScopeCurrentなし", (host: PhotoWebViewBinding["host"]) => binding({
      transfer: transferBinding(),
      host: { ...host, isScopeCurrent: undefined },
    })],
  ])("%sではpanelを出さずWorkbenchを保つ", (_name, createBinding) => {
    const { host } = scopedHost();
    render(props({ binding: createBinding(host) }));

    expect(container.querySelector('[data-testid="transfer-panel"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="workbench"]')).toHaveLength(1);
    expect(mockState.transferPanelProps).toHaveLength(0);
  });

  it("retry/logout/updateを同一tickの連打から一度に抑止する", async () => {
    const retryResult = deferred<void>();
    const retry = vi.fn(() => retryResult.promise);
    render(props({ session: session("unavailable"), onRetry: retry }));
    const retryButton = byText(container, "button", copy.retry);
    act(() => {
      retryButton.click();
      retryButton.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () => retryResult.resolve());

    const logoutResult = deferred<void>();
    const logout = vi.fn(() => logoutResult.promise);
    render(props({ onLogout: logout }));
    const logoutButton = byText(container, "button", copy.logout);
    act(() => {
      logoutButton.click();
      logoutButton.click();
    });
    expect(logout).toHaveBeenCalledTimes(1);
    await act(async () => logoutResult.resolve());

    const updateResult = deferred<"applied" | "blocked" | "failed">();
    const requestUpdate = vi.fn(() => updateResult.promise);
    render(props({ pwa: { snapshot: { phase: "available" }, requestUpdate } }));
    const updateButton = byText(container, "button", copy.pwaApply);
    act(() => {
      updateButton.click();
      updateButton.click();
    });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    await act(async () => updateResult.resolve("applied"));
  });

  it("binding key変更後に届いた古いaction失敗を新scopeへ表示しない", async () => {
    const result = deferred<void>();
    render(props({ session: session("unavailable"), binding: binding(), onRetry: () => result.promise }));
    act(() => byText(container, "button", copy.retry).click());

    render(props({
      session: session("unavailable"),
      binding: binding({ key: "置場不透明値乙", scopeKey: "範囲不透明値乙" }),
      onRetry: () => result.promise,
    }));
    await act(async () => result.reject(new Error("秘密の失敗")));

    expect(container.textContent).not.toContain(copy.failed);
    expect(container.textContent).not.toContain("秘密の失敗");
  });

  it("session rotation後は新actionを許し、旧sessionの遅着失敗を表示しない", async () => {
    const accepted = binding();
    const firstResult = deferred<void>();
    const firstRetry = vi.fn(() => firstResult.promise);
    render(props({ session: session("unavailable"), binding: accepted, onRetry: firstRetry }));
    act(() => byText(container, "button", copy.retry).click());

    const rotatedSession = session("unavailable");
    if (rotatedSession.identity === null) throw new Error("missing synthetic identity");
    const secondResult = deferred<void>();
    const secondRetry = vi.fn(() => secondResult.promise);
    render(props({
      session: {
        ...rotatedSession,
        identity: {
          ...rotatedSession.identity,
          sessionId: "親セッション不透明値乙",
          sessionEpoch: "世代不透明値乙",
        },
      },
      binding: accepted,
      onRetry: secondRetry,
    }));
    act(() => byText(container, "button", copy.retry).click());

    expect(firstRetry).toHaveBeenCalledTimes(1);
    expect(secondRetry).toHaveBeenCalledTimes(1);
    await act(async () => firstResult.reject(new Error("旧セッションの失敗")));
    expect(container.textContent).not.toContain(copy.failed);
    expect(container.textContent).not.toContain("旧セッションの失敗");

    await act(async () => secondResult.reject(new Error("新セッションの失敗")));
    expect(container.textContent).toContain(copy.failed);
    expect(container.textContent).not.toContain("新セッションの失敗");
  });

  it("PWA状態は登録済みの明示状態だけを出し、進捗中をdisableする", async () => {
    const requestUpdate = vi.fn(async () => "blocked" as const);
    render(props({ online: false, pwa: null }));
    expect(container.textContent).toContain(copy.offline);
    expect(container.textContent).not.toContain(copy.pwaAvailable);
    expect(container.textContent).not.toContain(copy.pwaApply);

    render(props({ online: false, pwa: { snapshot: { phase: "available" }, requestUpdate } }));
    expect(container.textContent).toContain(copy.pwaAvailable);
    expect(byText(container, "button", copy.pwaApply).hasAttribute("disabled")).toBe(false);

    render(props({ online: false, pwa: { snapshot: { phase: "preparing" }, requestUpdate } }));
    expect(container.textContent).toContain(copy.pwaPreparing);
    expect(byText(container, "button", copy.pwaApply).hasAttribute("disabled")).toBe(true);

    render(props({ online: false, pwa: { snapshot: { phase: "blocked" }, requestUpdate } }));
    expect(container.textContent).toContain(copy.pwaBlocked);
    expect(byText(container, "button", copy.pwaApply).hasAttribute("disabled")).toBe(false);

    render(props({ online: false, pwa: { snapshot: { phase: "failed" }, requestUpdate } }));
    expect(container.textContent).toContain(copy.pwaFailed);
    expect(byText(container, "button", copy.pwaApply).hasAttribute("disabled")).toBe(false);
  });

  describe("shared albums (B08)", () => {
    const port = () => ({ listAlbums: vi.fn(), storageLocations: vi.fn(async () => []), dispose: vi.fn() }) as unknown as NonNullable<PhotoWebViewBinding["sharedAlbums"]>;

    it("出さない: rolloutが閉じた拠点では切替・設定・共有アルバムを出さず、招待のsecretも使わない", () => {
      act(() => root.render(<PhotoWebView {...props({ invite: { kind: "link", secret: "synthetic-invite-secret-value" } })} />));
      expect(container.querySelector("nav")).toBeNull();
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "設定")).toBe(false);
      expect(container.querySelector("[data-testid=shared-workspace]")).toBeNull();
      expect(mockState.workspaceProps).toEqual([]);
      expect(mockState.workbenchProps.at(-1)?.active).toBe(true);
    });

    it("開いた拠点では「写真 / 共有アルバム」と設定を出し、切り替えても写真の編集面を保つ", () => {
      const sharedAlbums = port();
      act(() => root.render(<PhotoWebView {...props({ binding: binding({ sharedAlbums }) })} />));
      const tabs = Array.from(container.querySelectorAll("nav button"));
      expect(tabs.map((tab) => tab.textContent)).toEqual(["写真", "共有アルバム"]);
      expect(container.querySelector("[data-testid=shared-workspace]")).toBeNull();
      act(() => (tabs[1] as HTMLButtonElement).click());
      expect(container.querySelector("[data-testid=shared-workspace]")).not.toBeNull();
      expect(mockState.workspaceProps.at(-1)?.port).toBe(sharedAlbums);
      // The workbench stays mounted (drafts kept) but inactive and hidden.
      expect(mockState.workbenchProps.at(-1)?.active).toBe(false);
      expect(container.querySelector("[data-testid=workbench]")?.parentElement?.hidden).toBe(true);
      act(() => byText(container, "button", "設定").click());
      expect(container.querySelector("[data-testid=settings-dialog]")).not.toBeNull();
      act(() => (Array.from(container.querySelectorAll("nav button"))[0] as HTMLButtonElement).click());
      expect(mockState.workbenchProps.at(-1)?.active).toBe(true);
      // Still mounted so additions keep going.
      expect(container.querySelector("[data-testid=shared-workspace]")?.parentElement?.hidden).toBe(true);
    });

    it("開いた設定は別のscopeへ持ち越さない（1回の描画でも前の保存先を出さない）", () => {
      const sharedAlbums = port();
      act(() => root.render(<PhotoWebView {...props({ binding: binding({ sharedAlbums }) })} />));
      act(() => byText(container, "button", "設定").click());
      expect(mockState.settingsProps.at(-1)?.open).toBe(true);
      const next = port();
      act(() => root.render(<PhotoWebView {...props({ binding: binding({ scopeKey: "範囲不透明値乙", sharedAlbums: next }) })} />));
      expect(mockState.settingsProps.at(-1)?.open).toBe(false);
      expect(container.querySelector("[data-testid=settings-dialog]")).toBeNull();
    });

    it("招待のsecretは開いた拠点で共有アルバムへ渡し、使い終えたら共有アルバムに留まる", () => {
      const onInviteHandled = vi.fn();
      const sharedAlbums = port();
      act(() => root.render(<PhotoWebView {...props({ binding: binding({ sharedAlbums }), invite: { kind: "link", secret: "synthetic-invite-secret-value" }, onInviteHandled })} />));
      expect(mockState.workspaceProps.at(-1)?.invite).toEqual({ kind: "link", secret: "synthetic-invite-secret-value" });
      act(() => (mockState.workspaceProps.at(-1)?.onInviteHandled as () => void)());
      expect(onInviteHandled).toHaveBeenCalledTimes(1);
      act(() => root.render(<PhotoWebView {...props({ binding: binding({ sharedAlbums }), invite: null, onInviteHandled })} />));
      expect(container.querySelector("[data-testid=shared-workspace]")?.parentElement?.hidden).toBe(false);
      expect(mockState.workspaceProps.at(-1)?.invite).toBeNull();
    });

    it("ログインの前に預けた招待は共有アルバムを開いて渡す", () => {
      const sharedAlbums = port();
      act(() => root.render(<PhotoWebView {...props({ binding: binding({ sharedAlbums }), invite: { kind: "held" } })} />));
      expect(mockState.workspaceProps.at(-1)?.invite).toEqual({ kind: "held" });
      expect(container.querySelector("[data-testid=shared-workspace]")?.parentElement?.hidden).toBe(false);
    });
  });
});
