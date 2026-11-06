/**
 * 常設 Mac の接続用ソフト（Epic #240 / B03 #244）の Mac の口。接続用ソフトの窓（表示しない `hosted-connector.html`）の中で、
 * core（`@niho/photo-hosted-connector`）の port を native（`src-tauri/src/hosted_connector.rs`）のコマンドで満たす。
 *
 * - コマンドは `capabilities/hosted-connector.json` で接続用ソフトの窓だけに許す（main 窓からは呼べない）。
 * - path は受け取らず返さない。native へ渡すのは root の ID と root からの相対 path だけ。
 * - 索引の hash は native で読む（`RootFileSystem.hash`）。原本の bytes をこの窓へ通すのは描画 job の executor だけ。
 */
import type {
  CredentialVault,
  DirectoryEntry,
  HostedConnector,
  OpenedFile,
  PowerAssertions,
  RegisteredRoot,
  RootFileSystem,
  VaultContents,
} from "@niho/photo-hosted-connector";

import type { Invoke, Listen } from "../camera-bridge";

/** native の `hosted_code`（`hosted_connector.rs`）。 */
export const HOSTED_ERROR_CODE = {
  rootUnavailable: "hostedRootUnavailable",
  notFound: "hostedNotFound",
  refused: "hostedRefused",
  vaultUnavailable: "hostedVaultUnavailable",
} as const;

/** native が休止・復帰を知らせる event（`hosted_connector::POWER_EVENT`）。 */
export const HOSTED_POWER_EVENT = "hosted-connector-power";

const EMPTY_VAULT: VaultContents = { installSalt: null, credential: null, pairing: null, rotation: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 端末資格・登録中と回転中の秘密・localKey の salt を、Keychain の 1 項目（JSON）として読み書きする。 */
export function createNativeVault(invoke: Invoke): CredentialVault {
  return {
    async read() {
      const text = await invoke<string | null>("camera_hosted_connector_vault_read");
      if (text === null) return EMPTY_VAULT;
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("hosted connector vault is not an object");
      return { ...EMPTY_VAULT, ...(parsed as Partial<VaultContents>) };
    },
    async write(next) {
      await invoke("camera_hosted_connector_vault_write", { request: { contents: JSON.stringify(next) } });
    },
  };
}

/** 登録したフォルダ（ID だけ。名前と path は渡らない）。 */
export async function readRegisteredRoots(invoke: Invoke): Promise<RegisteredRoot[]> {
  const roots = await invoke<unknown>("camera_hosted_connector_roots");
  if (!Array.isArray(roots)) return [];
  return roots.flatMap((root) => (isRecord(root) && typeof root.id === "string" ? [{ id: root.id }] : []));
}

type NativeOpened = { handle: number; entry: DirectoryEntry };
type NativeHash = { outcome: "hashed"; sha256: string; bytes: number } | { outcome: "changed" };

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("hosted connector read returned no bytes");
}

/**
 * 登録したフォルダの下を read-only で読む。symlink・`..`・root の外・通常ファイルでないものは native が拒む。root が差し替え
 * られた・未 mount なら `unmounted`。
 */
export function createNativeRootFileSystem(invoke: Invoke): RootFileSystem {
  const at = (root: RegisteredRoot, path: string) => ({ request: { rootId: root.id, path } });
  return {
    async rootStatus(root) {
      return invoke<"available" | "unmounted">("camera_hosted_connector_root_status", { request: { rootId: root.id } });
    },
    async list(root, relativeDir) {
      return invoke<DirectoryEntry[]>("camera_hosted_connector_list", at(root, relativeDir));
    },
    async stat(root, relativePath) {
      return invoke<DirectoryEntry | null>("camera_hosted_connector_stat", at(root, relativePath));
    },
    async open(root, relativePath): Promise<OpenedFile> {
      const { handle, entry } = await invoke<NativeOpened>("camera_hosted_connector_open", at(root, relativePath));
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await invoke("camera_hosted_connector_close", { request: { handle } }).catch(() => undefined);
      };
      return {
        sizeBytes: entry.sizeBytes,
        mtimeMs: entry.mtimeMs,
        fileId: entry.fileId,
        changeToken: entry.changeToken,
        async *read(signal) {
          for (;;) {
            if (signal.aborted) throw signal.reason ?? new Error("aborted");
            const chunk = toBytes(await invoke<unknown>("camera_hosted_connector_read", { request: { handle } }));
            if (chunk.byteLength === 0) return;
            yield chunk;
          }
        },
        close,
      };
    },
    async hash(root, relativePath, expected) {
      const answer = await invoke<NativeHash>("camera_hosted_connector_hash", {
        request: {
          rootId: root.id,
          path: relativePath,
          expected: { sizeBytes: expected.sizeBytes, fileId: expected.fileId, changeToken: expected.changeToken },
        },
      });
      return answer.outcome === "hashed" ? { sha256: answer.sha256, bytes: answer.bytes } : null;
    },
  };
}

/** job・同期・走査の間だけ休止を抑える（IOPM assertion）。抑えられなくても仕事は続ける。 */
export function createNativePower(invoke: Invoke): PowerAssertions {
  return {
    async hold(reason) {
      const answer = await invoke<{ holdId: number | null }>("camera_hosted_connector_power_hold", { request: { reason } }).catch(() => ({
        holdId: null,
      }));
      let released = false;
      return {
        async release() {
          if (released || answer.holdId === null) return;
          released = true;
          await invoke("camera_hosted_connector_power_release", { request: { holdId: answer.holdId } }).catch(() => undefined);
        },
      };
    },
  };
}

export type HostedPowerHandlers = {
  /** 休止の前（終わったら native が休止を進める。native は最長 8 秒で待たずに進む）。 */
  willSleep(): Promise<void>;
  didWake(): Promise<void>;
};

/** 休止・復帰の知らせを受ける。休止の答えは知らせと同じ ticket で返す。戻り値で受けるのをやめる。 */
export async function watchHostedPower(listen: Listen, invoke: Invoke, handlers: HostedPowerHandlers): Promise<() => void> {
  return listen<{ state?: unknown; ticket?: unknown }>(HOSTED_POWER_EVENT, (event) => {
    if (event.payload.state === "willSleep") {
      const ticket = event.payload.ticket;
      void handlers
        .willSleep()
        .catch(() => undefined)
        .finally(() => {
          if (typeof ticket === "number") void invoke("camera_hosted_connector_sleep_ready", { request: { ticket } }).catch(() => undefined);
        });
    } else if (event.payload.state === "didWake") {
      void handlers.didWake().catch(() => undefined);
    }
  });
}

export type HostedConnectorLoop = {
  /** 休止・復帰の受け口（`watchHostedPower` へ渡す）。 */
  readonly power: HostedPowerHandlers;
  stop(): void;
  /** 終わるまで待つ（試験用）。 */
  readonly done: Promise<void>;
};

/**
 * 常駐の間 tick を回す。休止の前は走っている tick を止めて NIHO へ `sleeping` を送り、復帰したら続きから（控えは差分だけ）。
 * tick が失敗しても（通信の切断など）次の間隔で続ける。登録したフォルダが変わったら（別の process が書き換えた場合も）
 * 止めて `onRootsChanged` を呼ぶ（core は起動時の一覧で動くので、組み立て直す）。
 */
export function runHostedConnectorLoop(options: {
  readonly connector: Pick<HostedConnector, "tick" | "willSleep" | "didWake">;
  readonly intervalMs: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly rootsChanged?: () => Promise<boolean>;
  readonly onRootsChanged?: () => void;
}): HostedConnectorLoop {
  const wait =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }));
  let stopped = false;
  let asleep = false;
  let tick = new AbortController();
  let pause = new AbortController();
  const done = (async () => {
    while (!stopped) {
      if (options.rootsChanged && (await options.rootsChanged().catch(() => false))) {
        stopped = true;
        options.onRootsChanged?.();
        break;
      }
      if (!asleep) {
        try {
          await options.connector.tick(tick.signal);
        } catch {
          // 次の間隔でやり直す（未接続・失効は tick の phase が知らせる）
        }
      }
      if (stopped) break;
      await wait(options.intervalMs, pause.signal);
      if (pause.signal.aborted) pause = new AbortController();
    }
  })();
  return {
    power: {
      async willSleep() {
        asleep = true;
        tick.abort();
        await options.connector.willSleep(new AbortController().signal);
      },
      async didWake() {
        tick = new AbortController();
        asleep = false;
        await options.connector.didWake();
        // 間隔を待たずに続きへ
        pause.abort();
      },
    },
    stop() {
      stopped = true;
      tick.abort();
      pause.abort();
    },
    done,
  };
}
