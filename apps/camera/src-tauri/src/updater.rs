//! 自動更新（C5 #18393。NIHO Desktop・NIHO docs と同じ作法: 次に開いたときに新しい版になる）。
//!
//! - 起動時に 1 回だけ `plugins.updater.endpoints`（Photo の GitHub Release `latest.json`。Web の
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//!   署名（`plugins.updater.pubkey`）と署名対象versionを確かめて取得する。`.app` の差し替えはアプリを閉じるとき（`RunEvent::Exit`・
//!   `install_staged_on_exit`）にする。起動中に差し替えると、動いている現像（`PhotoDevelop`）が起動時に確かめた版・校正の
//!   fingerprint のまま、`/Applications/NIHO photo.app/...` の新しい sidecar と校正を起動してしまうため（古い recipe での
//!   キャッシュ・版の組み合わせの不一致）。閉じるときは sidecar を止めた後（`develop::shutdown`）に差し替える。
//! - 通信は Rust の側だけ（画面の CSP の `connect-src` は同梱の画面と IPC のまま。`command_acl_tests.rs`）。spec 決まりごと 4
//!   の唯一の例外で、つながらない・フィードが使えないときも写真の編集はそのまま続く。
//! - 画面に出すのは「新しい版を取得した（次に開いたときに切り替わる）」ことだけ（`camera_update_status` と `update-staged` の
//!   event）。再起動はしない
//!   （現像・書き出しを止めないため）。失敗しても起動は止めず、診断ログ（`camera.log`。`app_log.rs`）に残すだけ。
//! - 公開鍵がプレースホルダー（`PUBKEY_PLACEHOLDER`）の間は、plugin を初期化せず、画面にも出さない。開発ビルド
//!   （`tauri dev`・debug）と受入用の E2E の build（feature `e2e`）でも確かめない（`.app` ではない・配らない build）。

use niho_desktop_photo::common::LogFn;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// tauri.conf.json の `plugins.updater.pubkey` の既定。owner が `tauri signer generate` で作った公開鍵に差し替えるまで、
/// 自動更新は使わない（apps/camera/scripts の updater-key.mjs も同じ値を見る）。
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_CAMERA_UPDATER_PUBKEY";
/// 新しい版を差し替えたときに窓へ送る event（中身は `UpdateStatus`）。
pub const STAGED_EVENT: &str = "update-staged";

/// tauri.conf.json の `plugins.updater` の公開鍵が差し替え済みか。
pub fn pubkey_configured(updater_config: Option<&Value>) -> bool {
  updater_config
    .and_then(|config| config.get("pubkey"))
    .and_then(Value::as_str)
    .map(str::trim)
    .is_some_and(|pubkey| !pubkey.is_empty() && pubkey != PUBKEY_PLACEHOLDER)
}

/// 配る build か（release で、受入用の E2E の build ではない）。
fn distributed_build(debug: bool, e2e: bool) -> bool {
  !debug && !e2e
}

/// この起動で自動更新を使うか（配る build で、公開鍵が差し替え済み）。
pub fn enabled(config: &tauri::Config) -> bool {
  cfg!(feature = "official-updates")
    && distributed_build(cfg!(debug_assertions), cfg!(feature = "e2e"))
    && pubkey_configured(config.plugins.0.get("updater"))
}

/// 画面が読む自動更新の状態。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
  /// 自動更新を使っているか（公開鍵が未設定・開発ビルド・E2E では false で、画面は何も出さない）。
  pub enabled: bool,
  /// 差し替えた新しい版（次に開いたときに切り替わる）。この起動で差し替えていなければ None。
  pub staged_version: Option<String>,
}

pub struct UpdateState(Mutex<UpdateStatus>);

/// 取得して署名を確かめた新しい版（アプリを閉じるときに `.app` へ差し替える）。
#[derive(Default)]
pub struct StagedInstall(Mutex<Option<(Update, Vec<u8>)>>);

impl UpdateState {
  pub fn new(enabled: bool) -> Self {
    Self(Mutex::new(UpdateStatus {
      enabled,
      staged_version: None,
    }))
  }

  fn status(&self) -> UpdateStatus {
    self.0.lock().map(|status| status.clone()).unwrap_or_default()
  }

  fn staged(&self, version: String) -> UpdateStatus {
    match self.0.lock() {
      Ok(mut status) => {
        status.staged_version = Some(version);
        status.clone()
      }
      Err(_) => UpdateStatus {
        enabled: true,
        staged_version: Some(version),
      },
    }
  }
}

/// 起動時の 1 回の確認（裏で動く。ネットワーク不通・フィード未公開でも起動は止めない）。
pub fn check_in_background<R: Runtime>(app: &AppHandle<R>, log: LogFn) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    let installed = app.package_info().version.to_string();
    match download_and_stage(&app).await {
      Ok(Some(version)) => {
        log(
          "auto_update.staged",
          json!({ "installedVersion": installed, "latestVersion": version }),
        );
        let status = app.state::<UpdateState>().staged(version);
        let _ = app.emit(STAGED_EVENT, status);
      }
      Ok(None) => {}
      Err((code, details)) => log(
        "auto_update.failed",
        json!({ "installedVersion": installed, "code": code, "details": details }),
      ),
    }
  });
}

/// フィードに新しい版があれば、取得して署名を確かめ、閉じるときの差し替えまで持っておく。取得した版を返す。
async fn download_and_stage<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, (&'static str, String)> {
  let updater = app
    .updater()
    .map_err(|error| ("updater_unavailable", error.to_string()))?;
  let Some(update) = updater
    .check()
    .await
    .map_err(|error| ("update_check_failed", error.to_string()))?
  else {
    return Ok(None);
  };
  let version = update.version.clone();
  // `download` は署名も確かめる。差し替え（`install`）は閉じるとき
  let bytes = update
    .download(|_chunk, _total| {}, || {})
    .await
    .map_err(|error| ("update_download_failed", error.to_string()))?;
  let staged = app.state::<StagedInstall>();
  match staged.0.lock() {
    Ok(mut slot) => *slot = Some((update, bytes)),
    Err(_) => return Err(("update_stage_failed", "staged install lock poisoned".to_string())),
  }
  Ok(Some(version))
}

/// アプリを閉じるとき（`RunEvent::Exit`。sidecar を止めた後）に、取得しておいた新しい版へ `.app` を差し替える。次に開いたときから
/// 新しい版になる。取得していなければ何もしない。失敗しても閉じるのは止めず、診断ログに残す（次の起動でもう一度取得する）。
pub fn install_staged_on_exit<R: Runtime>(app: &AppHandle<R>, log: LogFn) {
  let Some(staged) = app.try_state::<StagedInstall>() else {
    return;
  };
  let pending = match staged.0.lock() {
    Ok(mut slot) => slot.take(),
    Err(_) => None,
  };
  let Some((update, bytes)) = pending else {
    return;
  };
  let version = update.version.clone();
  match update.install(&bytes) {
    Ok(()) => log("auto_update.installed_on_exit", json!({ "latestVersion": version })),
    Err(error) => log(
      "auto_update.failed",
      json!({ "latestVersion": version, "code": "update_install_failed", "details": error.to_string() }),
    ),
  }
}

/// 画面が起動時に読む今の状態（差し替えた後は `update-staged` の event でも届く）。
#[tauri::command]
pub fn camera_update_status(state: tauri::State<'_, UpdateState>) -> UpdateStatus {
  state.status()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_placeholder_and_blank_keys_turn_the_updater_off() {
    assert!(!pubkey_configured(None));
    assert!(!pubkey_configured(Some(&json!({ "endpoints": [] }))));
    assert!(!pubkey_configured(Some(&json!({ "pubkey": PUBKEY_PLACEHOLDER }))));
    assert!(!pubkey_configured(Some(&json!({ "pubkey": "  " }))));
    assert!(pubkey_configured(Some(
      &json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6" })
    )));
  }

  #[test]
  fn only_the_distributed_build_updates_itself() {
    assert!(distributed_build(false, false));
    assert!(!distributed_build(true, false), "開発ビルド（debug）は .app ではない");
    assert!(!distributed_build(false, true), "受入用の E2E の build は配らない");
    assert!(!distributed_build(true, true));
  }

  #[test]
  fn the_feed_is_the_photo_github_release() {
    let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
    assert_eq!(
      conf["plugins"]["updater"]["endpoints"],
      json!(["https://github.com/niho-life/niho-photo/releases/latest/download/latest.json"])
    );
    assert_eq!(conf["plugins"]["updater"]["requireSignedVersion"], json!(true));
    assert!(conf["plugins"]["updater"]["pubkey"].is_string());
  }

  #[test]
  fn the_status_uses_the_web_field_names() {
    let state = UpdateState::new(true);
    assert_eq!(
      serde_json::to_value(state.status()).unwrap(),
      json!({ "enabled": true, "stagedVersion": null })
    );
    assert_eq!(
      serde_json::to_value(state.staged("0.1.8".into())).unwrap(),
      json!({ "enabled": true, "stagedVersion": "0.1.8" })
    );
    assert_eq!(state.status().staged_version.as_deref(), Some("0.1.8"));
  }
}
