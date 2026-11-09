/**
 * 接続用ソフトの窓（表示しない。`hosted-connector.html`）の入口。native が登録したフォルダがあるときだけこの窓を作る
 * （`src-tauri/src/hosted_connector.rs`）。公開の build は接続先と保存先を持たないので、ここでは何も動かさない。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { startMacHostedConnector } from "./mac-hosted-connector";

void startMacHostedConnector({ invoke, listen, runtime: null });
