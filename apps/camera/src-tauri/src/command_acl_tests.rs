//! `generate_handler!` に登録したコマンドと ACL（`permissions/`・`capabilities/`）の突き合わせ。NIHO Desktop の
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//!
//! Tauri 2 は、アプリが自前の permission（`permissions/camera.toml`）を持つと app コマンドも ACL で判定し、許可の無い
//! コマンドは実行前に `Command … not allowed by ACL` で拒否する。登録だけして permission・capability へ足し忘れると、
//! 同梱の画面から呼べない。逆に NIHO photo は remote の配信元を持たないので、同梱の画面（local）以外の呼び出し元
//! （Web のページ・別の窓）にはどのコマンドも許さない（spec 決まりごと 4・6）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use tauri::ipc::Origin;
use tauri::utils::acl::{manifest::Manifest, ACL_MANIFESTS_FILE_NAME, APP_ACL_KEY};

/// `tauri.conf.json` の窓（capabilities/default.json の `windows`）。
const MAIN_WINDOW_LABEL: &str = "main";

const ACCOUNT_PLUGIN_COMMANDS: [&str; 5] = [
  "plugin:niho-desktop-account|account_state",
  "plugin:niho-desktop-account|account_begin_login",
  "plugin:niho-desktop-account|account_cancel_login",
  "plugin:niho-desktop-account|account_logout",
  "plugin:niho-desktop-account|account_open_my_page",
];

/// lib.rs の `generate_handler![...]` に並べたコマンド名（`module::command` は末尾の名前）。
fn registered_commands() -> BTreeSet<String> {
  const HANDLER: &str = "tauri::generate_handler![";
  let source = include_str!("lib.rs");
  assert_eq!(
    source.matches(HANDLER).count(),
    1,
    "lib.rs の {HANDLER} は1か所の前提（増やしたらこの読み取りも直す）"
  );
  let start = source.find(HANDLER).unwrap() + HANDLER.len();
  let end = start + source[start..].find(']').expect("generate_handler! の閉じ括弧が無い");
  let commands: BTreeSet<String> = source[start..end]
    .lines()
    .map(|line| line.split("//").next().unwrap_or_default())
    .flat_map(|line| line.split(','))
    .filter_map(|entry| entry.split_whitespace().last())
    .map(|path| path.rsplit("::").next().unwrap_or(path).to_string())
    .collect();
  assert!(
    commands.contains("camera_app_info")
      && commands
        .iter()
        .all(|name| name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')),
    "generate_handler! を読み取れなかった: {commands:?}"
  );
  commands
}

/// 同梱の画面以外の呼び出し元。NIHO photo は remote の配信元を持たないので、どれにも許さない。
fn foreign_origins() -> Vec<(&'static str, Origin)> {
  let remote = |url: &str| Origin::Remote {
    url: url.parse().expect("URL"),
  };
  vec![
    ("https://niho.life/", remote("https://niho.life/")),
    ("https://app.niho.life/", remote("https://app.niho.life/")),
    ("https://example.com/", remote("https://example.com/")),
  ]
}

fn context() -> tauri::Context<tauri::Wry> {
  // 実行時と同じ、capabilities と permissions から解決した ACL で判定する
  // （test = true は macOS の Info.plist 埋め込みを省くだけ。run() の展開とシンボルが重複しない）
  tauri::generate_context!(test = true)
}

#[test]
fn every_registered_command_is_allowed_for_the_bundled_ui() {
  let mut context = context();
  let authority = context.runtime_authority_mut();
  let denied: Vec<String> = registered_commands()
    .into_iter()
    .filter(|command| {
      authority
        .resolve_access(command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &Origin::Local)
        .is_none()
    })
    .collect();
  assert!(
    denied.is_empty(),
    "generate_handler! に登録したのに ACL で拒否されるコマンドがある。permissions/camera.toml の \
     permission へ足し、capabilities/default.json で許可する: {denied:#?}"
  );
}

#[test]
fn no_command_is_allowed_for_remote_pages_or_other_windows() {
  let mut context = context();
  let authority = context.runtime_authority_mut();
  let mut allowed = Vec::new();
  for command in registered_commands() {
    for (label, origin) in foreign_origins() {
      if authority
        .resolve_access(&command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &origin)
        .is_some()
      {
        allowed.push(format!("{command} ← {label}"));
      }
    }
    if authority
      .resolve_access(&command, "other", "other", &Origin::Local)
      .is_some()
    {
      allowed.push(format!("{command} ← 窓 other"));
    }
  }
  assert!(
    allowed.is_empty(),
    "同梱の画面（main 窓・local）以外から呼べるコマンドがある。capabilities に remote や窓を足さない: {allowed:#?}"
  );
}

#[test]
fn account_plugin_commands_are_unavailable_without_authentication_module() {
  let mut context = context();
  let authority = context.runtime_authority_mut();
  for command in ACCOUNT_PLUGIN_COMMANDS {
    assert!(
      authority
        .resolve_access(command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &Origin::Local)
        .is_none(),
      "公開ローカル版は認証コマンド {command} を持たない"
    );
    for (label, origin) in foreign_origins() {
      assert!(
        authority
          .resolve_access(command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &origin)
          .is_none(),
        "{label} は {command} を呼べない"
      );
    }
    assert!(
      authority
        .resolve_access(command, "other", "other", &Origin::Local)
        .is_none(),
      "別の窓は {command} を呼べない"
    );
  }
}

#[test]
fn the_bundled_ui_may_only_listen_to_events_among_the_core_commands() {
  // 自動更新の案内（updater.rs の `update-staged`）を受けるために、core の event の listen・unlisten だけを足した。core:default
  // （窓の操作・emit・path など）は足さない。足すのは同梱の画面（main 窓・local）だけ
  let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json"))
    .expect("capabilities/default.json を解釈できない");
  let core: BTreeSet<&str> = capability["permissions"]
    .as_array()
    .expect("permissions")
    .iter()
    .filter_map(serde_json::Value::as_str)
    .filter(|permission| permission.starts_with("core:"))
    .collect();
  assert_eq!(
    core,
    BTreeSet::from(["core:event:allow-listen", "core:event:allow-unlisten"]),
    "core の permission は event の listen・unlisten だけ"
  );

  let mut context = context();
  let authority = context.runtime_authority_mut();
  for command in ["plugin:event|listen", "plugin:event|unlisten"] {
    assert!(
      authority
        .resolve_access(command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &Origin::Local)
        .is_some(),
      "同梱の画面は {command} できる"
    );
    for (label, origin) in foreign_origins() {
      assert!(
        authority
          .resolve_access(command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &origin)
          .is_none(),
        "{label} は {command} できない"
      );
    }
  }
  for command in [
    "plugin:event|emit",
    "plugin:event|emit_to",
    "plugin:window|close",
    "plugin:path|resolve_directory",
  ] {
    assert!(
      authority
        .resolve_access(command, MAIN_WINDOW_LABEL, MAIN_WINDOW_LABEL, &Origin::Local)
        .is_none(),
      "同梱の画面にも {command} は許さない"
    );
  }
}

#[test]
fn app_permissions_only_allow_registered_commands() {
  // tauri-build が permissions/ を解釈して OUT_DIR へ書いたもの（generate_context! もこれを読む）
  let path = Path::new(env!("OUT_DIR")).join(ACL_MANIFESTS_FILE_NAME);
  let manifests: BTreeMap<String, Manifest> =
    serde_json::from_str(&std::fs::read_to_string(&path).expect("acl-manifests.json を読めない"))
      .expect("acl-manifests.json を解釈できない");
  let app = manifests
    .get(APP_ACL_KEY)
    .expect("permissions/camera.toml の permission が ACL に無い");
  let registered = registered_commands();
  let unknown: BTreeSet<&str> = app
    .permissions
    .values()
    .flat_map(|permission| permission.commands.allow.iter())
    .map(String::as_str)
    .filter(|command| !registered.contains(*command))
    .collect();
  assert!(
    unknown.is_empty(),
    "permission が許可しているのに generate_handler! に無いコマンドがある（撤去したコマンドは \
     permission からも外す）: {unknown:?}"
  );
}

#[test]
fn bundled_ui_cannot_reach_the_network() {
  // 決まりごと 4（オフラインで完結・wasm を niho.life から取らない）を画面の側でも閉じる: 本番の CSP の connect-src は
  // 同梱の画面（'self'）と IPC と現像の URI scheme `niho-develop:`（同梱の sidecar へ渡すだけ。develop_engine_scheme.rs）だけ。
  // remote の URL を足すと画面から外へ通信できてしまう。唯一の例外の自動更新（C5 #18393）は Rust の側（updater.rs・
  // tauri-plugin-updater）が通信し、画面は通信しない。
  let config: serde_json::Value =
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json を解釈できない");
  let csp = &config["app"]["security"]["csp"];
  assert_eq!(
    csp["connect-src"],
    serde_json::json!(format!(
      "'self' ipc: http://ipc.localhost {}:",
      crate::develop_engine_scheme::SCHEME
    )),
    "本番の CSP の connect-src に外の通信先を足さない"
  );
  assert_eq!(csp["default-src"], serde_json::json!("'self'"));
  assert!(
    config["build"]["frontendDist"]
      .as_str()
      .is_some_and(|dist| !dist.contains("://")),
    "frontendDist は同梱の画面（URL にしない）"
  );
  // 開発用の CSP も外へは vite の dev server（localhost）だけ
  let dev_csp = &config["app"]["security"]["devCsp"];
  assert_eq!(
    dev_csp["connect-src"],
    serde_json::json!(format!(
      "'self' ipc: http://ipc.localhost ws://localhost:1430 {}:",
      crate::develop_engine_scheme::SCHEME
    )),
    "開発用の CSP の connect-src に外の通信先を足さない"
  );
}

#[test]
fn images_allow_only_local_thumbnails_and_the_account_avatar() {
  // 一覧のタイルは URI scheme `niho-thumb:`。アカウントの顔写真は共通 plugin が app data の account/account-avatar.* に保存する。
  // どちらもこの Mac の asset だけで、外の URL は許可しない（本番と開発用の両方）。
  let config: serde_json::Value =
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json を解釈できない");
  for key in ["csp", "devCsp"] {
    assert_eq!(
      config["app"]["security"][key]["img-src"],
      serde_json::json!(format!(
        "'self' blob: data: {}: asset: http://asset.localhost",
        crate::thumbnail_scheme::SCHEME
      )),
      "{key} の img-src"
    );
  }
  assert_eq!(config["app"]["security"]["assetProtocol"]["enable"], false);
  assert_eq!(
    config["app"]["security"]["assetProtocol"]["scope"],
    serde_json::json!([]),
    "asset protocol は共通 account plugin の顔写真だけ"
  );
}

#[test]
fn the_bundle_registers_only_the_camera_deep_link_scheme() {
  let config: serde_json::Value =
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json を解釈できない");
  assert_eq!(
    config["plugins"]["deep-link"]["desktop"]["schemes"],
    serde_json::json!(["niho-camera"])
  );
}
