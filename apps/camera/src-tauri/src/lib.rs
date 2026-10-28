//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//!
//! - 画面は同梱の React（`tauri.conf.json` の `frontendDist` = `../dist`）。remote の配信元は持たず、コマンドを呼べるのは
//!   同梱の画面（local）の main 窓だけ（`capabilities/default.json`。`command_acl_tests.rs` が確かめる）。
//! - 写真の閲覧・編集・書き出しはオフラインで完結する（spec 決まりごと 4）。画面の CSP の `connect-src` は `'self'` と IPC と
//!   `niho-develop:`（同梱の sidecar で現像するだけ・外へは出ない）だけで、画面から外へは通信できない。
//! - コマンドは `generate_handler!` に登録し、`permissions/camera.toml` の permission と capability で許可する。
//! - この Mac の `PhotoLibrary`（spec「接続口 PhotoLibrary」）: フォルダ（`library.rs`）・写真を開く・補正の保存（`photos.rs`）・
//!   現像と原寸の書き出し（`develop.rs`）・選別のフラグ（`flags.rs`。niho-photo#47）。本体は `packages/desktop-photo`（NIHO Desktop と
//!   同じ関数）。この Mac のプリセット（`presets.rs`）。
//!   一覧のサムネイルは URI scheme `niho-thumb://`（`thumbnail_scheme.rs`）、端末への保存とオリジナルの書き出しは `save.rs`。
//! - 編集中の現像は、画面の Worker が URI scheme `niho-develop://`（`develop_engine_scheme.rs`）へ送り、同梱の
//!   `niho-develop-render serve`（`develop_engine_sidecar.rs`。長く生きる 1 プロセス・全コア）が描く（Issue #152。使えなければ
//!   画面の wasm で描く）。
//! - 受入用の E2E（feature `e2e`。配布の build には入らない）は `e2e.rs`。
//! - 自動更新（`updater.rs`。C5 #18393）: 起動時に 1 回、Rust の側で更新フィードを見て、次に開いたときに新しい版になる
//!   （画面の通信ではない。spec 決まりごと 4 の唯一の例外）。

mod account;
mod activity;
mod app_log;
mod cutout;
mod cutout_commands;
mod develop;
mod develop_engine_scheme;
mod develop_engine_sidecar;
mod dialog;
#[cfg(feature = "e2e")]
mod e2e;
mod error;
mod flags;
mod library;
mod mask_surfaces;
mod photo_bench;
mod photos;
mod presets;
#[cfg(any(feature = "official-updates", test))]
mod runtime_assets;
mod save;
mod thumbnail_scheme;
mod updater;

use serde::Serialize;
use tauri::webview::PageLoadEvent;
use tauri::Manager;

/// 同梱の画面の窓（`tauri.conf.json` の窓・capabilities の `windows`）。
const MAIN_WINDOW_LABEL: &str = "main";

/// 画面に返すアプリの情報（版の 1 行・問い合わせ用）。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CameraAppInfo {
  /// `Cargo.toml` の版（`scripts/camera-version.mjs` が package.json・tauri.conf.json とそろえる）
  pub app_version: &'static str,
}

fn app_info() -> CameraAppInfo {
  CameraAppInfo {
    app_version: env!("CARGO_PKG_VERSION"),
  }
}

#[tauri::command]
fn camera_app_info() -> CameraAppInfo {
  app_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[allow(unused_mut)]
  let mut context = tauri::generate_context!();
  #[cfg(feature = "official-updates")]
  runtime_assets::install(&mut context);
  let builder = tauri::Builder::default().plugin(tauri_plugin_deep_link::init());
  #[cfg(feature = "e2e")]
  let builder = {
    e2e::configure(&mut context);
    builder.plugin(e2e::plugin())
  };
  // 自動更新は配る build（release・E2E ではない）で、tauri.conf.json の updater の公開鍵を差し替えてから（それまでは plugin を
  // 入れない）
  let updates = updater::enabled(context.config());
  let builder = if updates {
    builder.plugin(tauri_plugin_updater::Builder::new().build())
  } else {
    builder
  };
  builder
    // 一覧のタイル・開いた直後の仮の画（entryId だけを受け、パスは受けない・返さない）
    .register_asynchronous_uri_scheme_protocol(thumbnail_scheme::SCHEME, thumbnail_scheme::handle)
    // 編集中の現像（main 窓の Worker から本文を受け、同梱の sidecar の応答を返す。最初の要求で sidecar を起動する）
    .register_asynchronous_uri_scheme_protocol(develop_engine_scheme::SCHEME, develop_engine_scheme::handle)
    // main 窓を読み込み直したら現像の sidecar を止める（前の画面の Developer を全部手放す）。E2E の plugin の on_page_load とは
    // 別の hook で、どちらも呼ばれる
    .on_page_load(|webview, payload| {
      if webview.label() == MAIN_WINDOW_LABEL && payload.event() == PageLoadEvent::Started {
        develop_engine_sidecar::stop(webview.app_handle());
      }
    })
    .setup(move |app| {
      // フォルダは最初の「フォルダを追加」か覚えたフォルダの一覧まで読まない。現像の sidecar は裏で 1 回だけ確かめる
      account::install(app.handle());
      library::install(app.handle());
      photos::install(app.handle());
      flags::install(app.handle());
      develop::install(app.handle());
      develop_engine_sidecar::install(app.handle());
      cutout_commands::install(app.handle());
      presets::install(app.handle());
      // 更新の確認は裏で 1 回（起動を待たせない。結果は camera.log）
      app.manage(updater::UpdateState::new(updates));
      app.manage(updater::StagedInstall::default());
      if updates {
        updater::check_in_background(app.handle(), app_log::log_fn(app.handle()));
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      camera_app_info,
      account::camera_account_state,
      account::camera_account_login,
      account::camera_account_cancel,
      account::camera_account_logout,
      account::camera_account_refresh,
      library::camera_library_add_folder,
      library::camera_library_add_photos,
      library::camera_library_remembered,
      library::camera_library_selected_photos,
      library::camera_library_list_folder,
      library::camera_library_forget_folder,
      library::camera_library_forget_photos,
      flags::camera_library_set_flags,
      library::camera_photo_interactive_preview,
      library::camera_photo_cancel_interactive_preview,
      photos::camera_photo_open,
      photos::camera_photo_close,
      photos::camera_photo_info,
      photos::camera_photo_save_settings,
      mask_surfaces::camera_mask_surface_save,
      mask_surfaces::camera_mask_surface_load,
      mask_surfaces::camera_mask_surface_exists,
      photos::camera_photo_versions,
      photos::camera_photo_save_versions,
      develop::camera_develop_status,
      develop::camera_develop_source,
      develop::camera_develop_source_bytes,
      develop::camera_export,
      develop::camera_choose_export_folder,
      develop::camera_export_to_folder,
      cutout_commands::camera_cutout_status,
      cutout_commands::camera_cutout_load_recipe,
      cutout_commands::camera_cutout_save_recipe,
      cutout_commands::camera_cutout_detect,
      cutout_commands::camera_cutout_cancel,
      cutout_commands::camera_cutout_read_mask,
      cutout_commands::camera_cutout_export,
      presets::camera_presets_list,
      presets::camera_presets_create,
      presets::camera_presets_rename,
      presets::camera_presets_delete,
      save::camera_save_file,
      save::camera_export_original,
      photo_bench::camera_photo_bench_edits,
      updater::camera_update_status
    ])
    .build(context)
    .expect("error while building NIHO photo")
    .run(|app, event| {
      // アプリを閉じたら、走っている sidecar を止め、書きかけの書き出しを消す。その後で、取得しておいた新しい版へ `.app` を
      // 差し替える（起動中に差し替えると、動いている現像が新しい sidecar・校正を起動してしまう。updater.rs）
      if let tauri::RunEvent::Exit = event {
        develop::shutdown(app);
        develop_engine_sidecar::stop(app);
        cutout_commands::shutdown(app);
        updater::install_staged_on_exit(app, app_log::log_fn(app));
      }
    });
}

#[cfg(test)]
#[path = "command_acl_tests.rs"]
mod command_acl_tests;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn app_info_is_the_crate_version_in_camel_case() {
    let info = app_info();
    assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(
      serde_json::to_value(&info).unwrap(),
      serde_json::json!({ "appVersion": env!("CARGO_PKG_VERSION") })
    );
  }
}
