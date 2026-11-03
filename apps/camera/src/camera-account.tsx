import { useEffect, useState } from "react";
import { accountMessage, LOCAL_ACCOUNT, parseAccountSnapshot, type AccountBridge } from "niho-desktop-account";
import { invalidateNativePhotoIdentity } from "./native-photo-session";

async function invoke(command: string): Promise<unknown> {
  if (!("__TAURI_INTERNALS__" in window)) return LOCAL_ACCOUNT;
  const { invoke: nativeInvoke } = await import("@tauri-apps/api/core");
  return nativeInvoke(command);
}
export const nativeAccount: AccountBridge = {
  read: async () => parseAccountSnapshot(await invoke("camera_account_state")),
  login: async () => { await invoke("camera_account_login"); },
  cancel: async () => { await invoke("camera_account_cancel"); },
  logout: async () => { await invoke("camera_account_logout"); },
  refresh: async () => { await invoke("camera_account_refresh"); },
};

/** アカウントを編集領域の前提にしない。nativeからtokenやプロフィールを受け取らない。 */
export function CameraAccount({ bridge = nativeAccount }: { bridge?: AccountBridge }) {
  const [state, setState] = useState(LOCAL_ACCOUNT);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const value = parseAccountSnapshot(await bridge.read());
        if (active) setState(value);
      } catch {
        if (active) setState({ ...LOCAL_ACCOUNT });
      }
    };
    void read();
    // 起動直後のrestoreやOS deep linkはnative側で非同期に完了する。
    const timer = state.available ? setInterval(() => void read(), 1000) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [bridge, state.available]);

  const act = async (action: () => Promise<void>) => {
    // IPCの生error文字列を画面・consoleへ出さず、nativeの固定分類snapshotを読み直す。
    try { await action(); } catch { /* read()で固定エラーを表示する */ }
    try { setState(parseAccountSnapshot(await bridge.read())); } catch { setState({ ...LOCAL_ACCOUNT }); }
  };
  const logout = () => {
    invalidateNativePhotoIdentity();
    return bridge.logout();
  };
  return (
    <details className="relative shrink-0 text-sm">
      <summary className="cursor-pointer rounded-lg px-2 py-1 text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink">
        {state.phase === "connected" ? "アカウント" : "このMacで編集"}
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-niho-border bg-white p-4 shadow-lg">
        <p role="status" aria-live="polite">{accountMessage(state)}</p>
        {state.available ? (
          <div className="mt-3 flex flex-wrap gap-3">
            {state.phase === "waiting" || state.phase === "refreshing" ? (
              <button type="button" onClick={() => void act(() => bridge.cancel())}>ログインを取り消す</button>
            ) : state.phase === "connected" || state.phase === "offline" ? (
              <button type="button" onClick={() => void act(logout)}>このMacからログアウト</button>
            ) : (
              <button type="button" onClick={() => { setState({ ...state, phase: "waiting", error: null }); void act(() => bridge.login()); }}>ブラウザでログイン</button>
            )}
            {state.phase === "offline" ? (
              <button type="button" onClick={() => void act(() => bridge.refresh())}>接続を再試行</button>
            ) : null}
            {state.error === "storage" || state.error === "network" || state.error === "expired" || state.error === "rejected" ? (
              <button type="button" onClick={() => void act(logout)}>保存した接続を削除</button>
            ) : null}
          </div>
        ) : <p className="mt-2 text-niho-text-muted">クラウド共有は準備中です。</p>}
      </div>
    </details>
  );
}
