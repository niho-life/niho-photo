import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_ACCOUNT, type AccountBridge, type AccountSnapshot } from "niho-desktop-account";
import { CameraAccount } from "./camera-account";
import { watchNativePhotoIdentityInvalidation } from "./native-photo-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of mounted.splice(0)) await clean(); });
async function render(state: AccountSnapshot) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const calls: string[] = [];
  let current = state;
  const bridge: AccountBridge = {
    read: async () => current,
    login: async () => { calls.push("login"); current = { ...state, phase: "failed", error: "network" }; throw new Error("synthetic-sensitive-body"); },
    cancel: async () => { calls.push("cancel"); current = { ...state, phase: "signed_out", error: "cancelled" }; },
    logout: async () => { calls.push("logout"); current = { ...state, phase: "signed_out", error: null }; },
    refresh: async () => { calls.push("refresh"); },
  };
  await act(async () => root.render(<CameraAccount bridge={bridge} />));
  mounted.push(async () => { await act(async () => root.unmount()); container.remove(); });
  const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
    expect(button).toBeTruthy(); await act(async () => button?.click());
  };
  return { container, calls, click };
}

describe("Camera account", () => {
  it("shows preparation and local editing without production login or share controls", async () => {
    const { container } = await render(LOCAL_ACCOUNT);
    expect(container.textContent).toContain("写真はこのMacで編集できます");
    expect(container.textContent).toContain("クラウド共有は準備中");
    expect(container.querySelectorAll("button,a")).toHaveLength(0);
  });
  it("lets a waiting login be cancelled and keeps the local editor promise visible", async () => {
    const { container, calls, click } = await render({ ...LOCAL_ACCOUNT, available: true, phase: "waiting" });
    expect(container.textContent).toContain("編集は続けられます");
    await click("取り消す");
    expect(calls).toEqual(["cancel"]);
    expect(container.textContent).toContain("ログインを取り消しました");
  });
  it("shows network retry UX without rendering raw native error bodies", async () => {
    const { container, calls, click } = await render({ ...LOCAL_ACCOUNT, available: true, phase: "signed_out" });
    await click("ブラウザでログイン");
    expect(calls).toEqual(["login"]);
    expect(container.textContent).toContain("ネットワークを確認");
    expect(container.textContent).not.toContain("sensitive");
    expect(container.textContent).toContain("ブラウザでログイン");
  });
  it("offers logout only for the current Mac and clears the connected view", async () => {
    const invalidated = vi.fn();
    const stop = await watchNativePhotoIdentityInvalidation(invalidated, { listen: async () => () => {} });
    const { container, calls, click } = await render({ ...LOCAL_ACCOUNT, available: true, phase: "connected" });
    await click("ログアウト"); expect(calls).toEqual(["logout"]);
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("ログインせずに");
    stop();
  });
});

describe("既存接続のオフライン操作", () => {
  it("uses refresh retry and logout while keeping a new browser login unavailable", async () => {
    const { container, calls, click } = await render({ ...LOCAL_ACCOUNT, available: true, phase: "offline", error: "network" });
    expect(container.textContent).toContain("このMacで編集");
    expect(container.textContent).not.toContain("ブラウザでログイン");
    await click("接続を再試行"); expect(calls).toEqual(["refresh"]);
  });
});

describe("認証失敗の固定文言", () => {
  it("distinguishes a paused connection, expiry, and unavailable storage", async () => {
    for (const [phase, error, text] of [["offline", "paused", "一時停止"], ["failed", "expired", "もう一度ログイン"], ["failed", "storage", "保存先"]] as const) {
      const { container } = await render({ ...LOCAL_ACCOUNT, available: true, phase, error });
      expect(container.textContent).toContain(text);
      expect(container.textContent).not.toContain("オフラインです");
      if (error === "expired") {
        expect(container.textContent).toContain("ブラウザでログイン");
        expect(container.textContent).not.toContain("接続を再試行");
      }
    }
  });
});
