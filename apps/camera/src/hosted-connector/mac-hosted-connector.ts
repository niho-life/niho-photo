/**
 * 接続用ソフトの窓（`hosted-connector.html`）の組み立て。native の口（vault・ファイル系・休止）と、trusted host が渡す
 * 接続先（transport）・保存先（索引・控え）・描画（B07）・出力の送り先を core へ渡し、常駐の間 tick を回す。
 *
 * 公開の build は接続先と保存先を持たないので、`runtime` が無ければ何も動かさない（個人クラウドの接続口と同じ段階の
 * 扱い。README「常設 Mac の接続用ソフト」）。
 */
import { bufferingHasher, createHostedConnector, type HostedConnectorOptions } from "@niho/photo-hosted-connector";

import type { Invoke, Listen } from "../camera-bridge";
import {
  createNativePower,
  createNativeRootFileSystem,
  createNativeVault,
  readRegisteredRoots,
  runHostedConnectorLoop,
  watchHostedPower,
  type HostedConnectorLoop,
} from "./native-ports";

/** trusted host が渡すもの（Mac の native の口以外）。 */
export type MacHostedConnectorRuntime = Pick<HostedConnectorOptions, "transport" | "index" | "replica" | "executors" | "uploader">;

/** tick の間隔（休止から戻ったときは待たずに続ける）。 */
export const HOSTED_CONNECTOR_INTERVAL_MS = 30_000;

export type MacHostedConnectorStart =
  | { readonly state: "notConfigured" }
  | { readonly state: "noFolders" }
  | { readonly state: "running"; readonly loop: HostedConnectorLoop; stop(): void };

export async function startMacHostedConnector(options: {
  readonly invoke: Invoke;
  readonly listen: Listen;
  readonly runtime: MacHostedConnectorRuntime | null;
  readonly intervalMs?: number;
}): Promise<MacHostedConnectorStart> {
  const { invoke, listen, runtime } = options;
  if (!runtime) return { state: "notConfigured" };
  const roots = await readRegisteredRoots(invoke);
  if (!roots.length) return { state: "noFolders" };
  const connector = createHostedConnector({
    ...runtime,
    vault: createNativeVault(invoke),
    fs: createNativeRootFileSystem(invoke),
    roots,
    // 索引の hash は native（fs.hash）。ここは描画 job の executor が読んだ bytes の照合だけに使う
    hasher: bufferingHasher,
    power: createNativePower(invoke),
    clock: { now: () => Date.now() },
  });
  const loop = runHostedConnectorLoop({ connector, intervalMs: options.intervalMs ?? HOSTED_CONNECTOR_INTERVAL_MS });
  const unlisten = await watchHostedPower(listen, invoke, loop.power);
  return {
    state: "running",
    loop,
    stop() {
      unlisten();
      loop.stop();
    },
  };
}
