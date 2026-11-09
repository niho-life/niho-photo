//! 常設 Mac の接続用ソフト（Epic #240 / B03 #244）の Mac の native 部分。core は `packages/photo-hosted-connector`（TS）で、
//! ここはその OS の口と常駐の仕組みを持つ。
//!
//! - 常駐: 登録したフォルダがあると、.app に同梱した LaunchAgent（`hosted_connector_system::AGENT_PLIST`）を登録する。
//!   launchd はログイン時に `--hosted-connector` 付きでこのアプリを起動し、落ちたら起動し直す（正常に終了したら次の
//!   ログインまで起動しない）。その起動では main 窓を作らず Dock にも出さない。アプリを開き直すと main 窓を出す。
//! - 接続用ソフトは、表示しない窓（`CONNECTOR_WINDOW_LABEL`。`hosted-connector.html`）で動く。隠れていても止まらないよう
//!   WebKit の throttling を外す。この窓のコマンド（`camera_hosted_connector_*`）は `capabilities/hosted-connector.json` で
//!   この窓だけに許し、main 窓には許さない。main 窓はフォルダの登録（`camera_hosted_folders_*`）だけを持つ。
//! - ファイルは登録したフォルダの下を read-only で読む（`hosted_connector_fs.rs`）。path は native の外へ出さない。
//! - 端末資格は Keychain、休止の抑止と休止・復帰の検知は IOKit（`hosted_connector_system.rs`）。
//! - 接続用ソフトを動かす process は 1 つだけ（`CONNECTOR_LOCK_FILE` の advisory lock）。launchd の常駐と、利用者が開いた画面の
//!   process が同時に動いたら、lock を取れなかった方は取れるまで待つ（取った方が終われば引き継ぐ）。
//! - 接続用ソフトの窓を閉じた・読み直したら、その窓が持っていた休止の抑止と開いたファイルを native が全部外す。

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::error::{internal, invalid_request, parse_request, run_blocking, CameraError, INTERNAL_MESSAGE};
use crate::hosted_connector_fs::{
  self as hosted_fs, EntryInfo, ExpectedIdentity, FsError, HashOutcome, RegisteredRoot,
};
use crate::hosted_connector_system::{self as system, AgentStatus, PowerEvent};

/// 接続用ソフトの窓（表示しない）。`capabilities/hosted-connector.json` の `windows`。
pub const CONNECTOR_WINDOW_LABEL: &str = "hosted-connector";
/// launchd が付ける起動の引数（`launchd/life.niho.camera.hosted-connector.plist`）。
pub const CONNECTOR_MODE_ARG: &str = "--hosted-connector";
/// 休止・復帰を接続用ソフトの窓へ知らせる event（`{ state: "willSleep" | "didWake" }`）。
pub const POWER_EVENT: &str = "hosted-connector-power";
/// 休止の前に、接続用ソフトが NIHO へ `sleeping` を送り終えるのを待つ長さ（OS は最長 30 秒待つ）。
pub const SLEEP_GRACE: Duration = Duration::from_secs(8);

const CONNECTOR_PAGE: &str = "hosted-connector.html";
const MAIN_WINDOW_LABEL: &str = "main";
const ROOTS_FILE: &str = "hosted-connector/roots.json";
const CONNECTOR_LOCK_FILE: &str = "hosted-connector/connector.lock";
/// lock を持つ別の process が終わるのを確かめる間隔。
const LOCK_RETRY: Duration = Duration::from_secs(15);
const MAX_ROOTS: usize = 64;
const MAX_OPEN_FILES: usize = 8;
const READ_CHUNK_BYTES: usize = 4 << 20;
const MAX_VAULT_BYTES: usize = 64 * 1024;
const MAX_HOLDS: usize = 16;

pub mod hosted_code {
  /// 登録したフォルダの実体に届かない（未 mount・差し替え）
  pub const UNAVAILABLE: &str = "hostedRootUnavailable";
  pub const NOT_FOUND: &str = "hostedNotFound";
  /// 形の不正な path・symlink・通常ファイルでない
  pub const REFUSED: &str = "hostedRefused";
  /// Keychain を読めない・書けない
  pub const VAULT: &str = "hostedVaultUnavailable";
}

fn hosted_error(code: &str) -> CameraError {
  // 接続用ソフトの窓は画面を持たないので、文言は出さない（code で扱う）
  CameraError::new(code, INTERNAL_MESSAGE)
}

impl From<FsError> for CameraError {
  fn from(error: FsError) -> Self {
    match error {
      FsError::Unavailable => hosted_error(hosted_code::UNAVAILABLE),
      FsError::NotFound => hosted_error(hosted_code::NOT_FOUND),
      FsError::Refused => hosted_error(hosted_code::REFUSED),
      FsError::Io => internal(),
    }
  }
}

// ---------------------------------------------------------------------------
// 休止の前の待ち合わせ

/// 休止の知らせ（`announce` が返す ticket）に、接続用ソフトが同じ ticket で答える（`ack`）まで、休止を最長 `SLEEP_GRACE`
/// 待たせる。前の休止への遅れた答えは、次の休止の答えにならない。
#[derive(Default)]
pub struct SleepGate {
  /// (最後に知らせた ticket, 答えのあった最新の ticket)
  counts: Mutex<(u64, u64)>,
  answered: Condvar,
}

impl SleepGate {
  pub fn announce(&self) -> u64 {
    let mut counts = lock(&self.counts);
    counts.0 += 1;
    counts.0
  }

  /// 今の知らせ（最後の ticket）への答えだけを受ける。
  pub fn ack(&self, ticket: u64) {
    let mut counts = lock(&self.counts);
    if ticket == counts.0 {
      counts.1 = ticket;
      self.answered.notify_all();
    }
  }

  /// `ticket` の知らせに答えがあれば true、`timeout` を過ぎたら false。
  pub fn wait(&self, ticket: u64, timeout: Duration) -> bool {
    let counts = lock(&self.counts);
    let (counts, _) = self
      .answered
      .wait_timeout_while(counts, timeout, |counts| counts.1 < ticket)
      .unwrap_or_else(|poison| poison.into_inner());
    counts.1 >= ticket
  }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

// ---------------------------------------------------------------------------
// 状態

#[derive(Default)]
struct OpenFiles {
  next: u64,
  files: HashMap<u64, (File, String)>,
}

#[derive(Default)]
struct Holds {
  next: u64,
  assertions: HashMap<u64, u32>,
}

pub struct HostedConnectorState {
  roots: Mutex<Vec<RegisteredRoot>>,
  roots_path: Option<PathBuf>,
  files: Mutex<OpenFiles>,
  holds: Mutex<Holds>,
  sleep: SleepGate,
  watching_power: AtomicBool,
  /// 接続用ソフトを動かす process の lock（持っている間だけ Some。process が終われば OS が外す）
  connector_lock: Mutex<Option<File>>,
  lock_path: Option<PathBuf>,
  waiting_for_lock: AtomicBool,
}

impl HostedConnectorState {
  fn new(data_dir: Option<PathBuf>) -> Self {
    let roots_path = data_dir.as_ref().map(|dir| dir.join(ROOTS_FILE));
    let roots = roots_path.as_deref().map(load_roots).unwrap_or_default();
    Self {
      roots: Mutex::new(roots),
      roots_path,
      files: Mutex::default(),
      holds: Mutex::default(),
      sleep: SleepGate::default(),
      watching_power: AtomicBool::new(false),
      connector_lock: Mutex::new(None),
      lock_path: data_dir.map(|dir| dir.join(CONNECTOR_LOCK_FILE)),
      waiting_for_lock: AtomicBool::new(false),
    }
  }

  /// 別の process（launchd の常駐・開いた画面）が書き換えたかもしれない一覧を読み直す。
  fn reload_roots(&self) -> Vec<RegisteredRoot> {
    let roots = self.roots_path.as_deref().map(load_roots).unwrap_or_default();
    *lock(&self.roots) = roots.clone();
    roots
  }

  fn acquire_connector_lock(&self) -> bool {
    let mut held = lock(&self.connector_lock);
    if held.is_none() {
      *held = self.lock_path.as_deref().and_then(try_lock);
    }
    held.is_some()
  }

  /// 接続用ソフトの窓が持っていた休止の抑止と開いたファイルを外す（窓を閉じた・読み直した）。外した assertion を返す。
  fn release_page_resources(&self) -> Vec<u32> {
    lock(&self.files).files.clear();
    lock(&self.holds)
      .assertions
      .drain()
      .map(|(_, assertion)| assertion)
      .collect()
  }

  fn root(&self, id: &str) -> Result<RegisteredRoot, CameraError> {
    lock(&self.roots)
      .iter()
      .find(|root| root.id == id)
      .cloned()
      .ok_or_else(|| hosted_error(hosted_code::NOT_FOUND))
  }

  fn has_roots(&self) -> bool {
    !lock(&self.roots).is_empty()
  }
}

#[derive(Serialize, Deserialize, Default)]
struct RootsFile {
  version: u32,
  roots: Vec<RegisteredRoot>,
}

fn load_roots(path: &Path) -> Vec<RegisteredRoot> {
  std::fs::read(path)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<RootsFile>(&bytes).ok())
    .filter(|file| file.version == 1)
    .map(|file| file.roots)
    .unwrap_or_default()
}

/// 一時ファイルに書いてから置き換える（0600。途中で落ちても前の一覧が残る）。
fn save_roots(path: &Path, roots: &[RegisteredRoot]) -> Result<(), CameraError> {
  use std::os::unix::fs::OpenOptionsExt;
  let dir = path.parent().ok_or_else(internal)?;
  std::fs::create_dir_all(dir).map_err(|_| internal())?;
  let bytes = serde_json::to_vec(&RootsFile {
    version: 1,
    roots: roots.to_vec(),
  })
  .map_err(|_| internal())?;
  let temporary = path.with_extension("json.tmp");
  let mut file = std::fs::OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
    .mode(0o600)
    .open(&temporary)
    .map_err(|_| internal())?;
  file
    .write_all(&bytes)
    .and_then(|()| file.sync_all())
    .map_err(|_| internal())?;
  std::fs::rename(&temporary, path).map_err(|_| internal())
}

fn random_id(prefix: &str) -> Result<String, CameraError> {
  let mut bytes = [0u8; 16];
  File::open("/dev/urandom")
    .and_then(|mut source| source.read_exact(&mut bytes))
    .map_err(|_| internal())?;
  Ok(format!(
    "{prefix}-{}",
    bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
  ))
}

/// 排他の advisory lock を待たずに取る（取れなければ None）。process が終われば OS が外す。
fn try_lock(path: &Path) -> Option<File> {
  use std::os::unix::fs::OpenOptionsExt;
  std::fs::create_dir_all(path.parent()?).ok()?;
  let file = std::fs::OpenOptions::new()
    .read(true)
    .write(true)
    .create(true)
    .truncate(false)
    .mode(0o600)
    .open(path)
    .ok()?;
  // SAFETY: file は開いている fd。flock は開いた file description ごとの lock で、fd を閉じれば外れる。
  let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
  locked.then_some(file)
}

fn state(app: &tauri::AppHandle) -> Result<tauri::State<'_, HostedConnectorState>, CameraError> {
  app.try_state::<HostedConnectorState>().ok_or_else(internal)
}

// ---------------------------------------------------------------------------
// 起動・窓

/// launchd が常駐として起動したか（main 窓を作らず、Dock にも出さない）。
pub fn connector_mode() -> bool {
  std::env::args().any(|arg| arg == CONNECTOR_MODE_ARG)
}

pub fn install(app: &tauri::AppHandle) {
  app.manage(HostedConnectorState::new(app.path().app_data_dir().ok()));
}

/// 起動の最後に呼ぶ。登録したフォルダがあれば接続用ソフトの窓を動かす。常駐の起動でフォルダが無ければ終える
/// （正常終了なので launchd は起動し直さない）。
pub fn start(app: &tauri::AppHandle) {
  let Ok(state) = state(app) else {
    return;
  };
  if state.has_roots() {
    ensure_connector_window(app);
  } else if connector_mode() {
    system::agent_unregister();
    app.exit(0);
  }
}

/// main 窓を作る（`tauri.conf.json` の main 窓は `create: false`。常駐の起動では作らない）。既にあれば前に出す。
pub fn open_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    window.show()?;
    return window.set_focus();
  }
  let config = app
    .config()
    .app
    .windows
    .iter()
    .find(|window| window.label == MAIN_WINDOW_LABEL)
    .cloned()
    .ok_or(tauri::Error::WindowNotFound)?;
  tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
  Ok(())
}

/// アプリを開き直した（Finder・Launchpad・Dock）。常駐で main 窓が無ければ作り、Dock に出す。
pub fn reopen(app: &tauri::AppHandle) {
  let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
  let _ = open_main_window(app);
}

/// main 窓を閉じた。接続用ソフトが動いていれば、アプリは Dock から消えて裏で続ける。
pub fn main_window_closed(app: &tauri::AppHandle) {
  if app.get_webview_window(CONNECTOR_WINDOW_LABEL).is_some() {
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
  }
}

fn ensure_connector_window(app: &tauri::AppHandle) {
  let Ok(state) = state(app) else {
    return;
  };
  if app.get_webview_window(CONNECTOR_WINDOW_LABEL).is_some() {
    return;
  }
  // 別の process が動かしていれば、終わるまで待って引き継ぐ
  if !state.acquire_connector_lock() {
    wait_for_connector_lock(app);
    return;
  }
  watch_power(app);
  let built = tauri::WebviewWindowBuilder::new(
    app,
    CONNECTOR_WINDOW_LABEL,
    tauri::WebviewUrl::App(CONNECTOR_PAGE.into()),
  )
  .visible(false)
  .focused(false)
  // 隠れた窓でも timer と通信を止めない（WKWebView の inactiveSchedulingPolicy。macOS 14 以降）
  .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
  .build();
  if built.is_err() {
    crate::app_log::log_fn(app)("hosted_connector.window_failed", Value::Null);
  }
}

fn wait_for_connector_lock(app: &tauri::AppHandle) {
  let Ok(current) = state(app) else {
    return;
  };
  if current.waiting_for_lock.swap(true, Ordering::AcqRel) {
    return;
  }
  let handle = app.clone();
  let spawned = std::thread::Builder::new()
    .name("hosted-connector-lock".into())
    .spawn(move || loop {
      std::thread::sleep(LOCK_RETRY);
      let Ok(state) = state(&handle) else {
        return;
      };
      // 待っている間に登録が無くなったら、待つのをやめる
      if state.reload_roots().is_empty() {
        state.waiting_for_lock.store(false, Ordering::Release);
        return;
      }
      if state.acquire_connector_lock() {
        state.waiting_for_lock.store(false, Ordering::Release);
        let main = handle.clone();
        let _ = handle.run_on_main_thread(move || ensure_connector_window(&main));
        return;
      }
    });
  if spawned.is_err() {
    current.waiting_for_lock.store(false, Ordering::Release);
  }
}

/// 接続用ソフトの窓を閉じたか読み直した。その窓の休止の抑止と開いたファイルを外す。
pub fn release_page_resources(app: &tauri::AppHandle) {
  if let Ok(state) = state(app) {
    for assertion in state.release_page_resources() {
      system::release_awake(assertion);
    }
  }
}

/// 接続用ソフトの窓が無くなった。窓の資源を外し、lock を手放す（別の process が引き継げる）。
pub fn connector_window_closed(app: &tauri::AppHandle) {
  release_page_resources(app);
  if let Ok(state) = state(app) {
    *lock(&state.connector_lock) = None;
  }
}

fn close_connector_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window(CONNECTOR_WINDOW_LABEL) {
    let _ = window.destroy();
  }
  connector_window_closed(app);
}

fn watch_power(app: &tauri::AppHandle) {
  let Ok(state) = state(app) else {
    return;
  };
  if state.watching_power.swap(true, Ordering::AcqRel) {
    return;
  }
  let handle = app.clone();
  let watching = system::watch_system_power(Box::new(move |event| on_power(&handle, event)));
  if !watching {
    crate::app_log::log_fn(app)("hosted_connector.power_notifications_unavailable", Value::Null);
  }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PowerPayload {
  state: &'static str,
  /// 休止の知らせだけ。答え（`camera_hosted_connector_sleep_ready`）は同じ ticket を返す
  #[serde(skip_serializing_if = "Option::is_none")]
  ticket: Option<u64>,
}

fn on_power(app: &tauri::AppHandle, event: PowerEvent) {
  let Ok(state) = state(app) else {
    return;
  };
  if app.get_webview_window(CONNECTOR_WINDOW_LABEL).is_none() {
    return;
  }
  match event {
    PowerEvent::WillSleep => {
      let ticket = state.sleep.announce();
      if app
        .emit_to(
          CONNECTOR_WINDOW_LABEL,
          POWER_EVENT,
          PowerPayload {
            state: "willSleep",
            ticket: Some(ticket),
          },
        )
        .is_ok()
      {
        state.sleep.wait(ticket, SLEEP_GRACE);
      }
    }
    PowerEvent::DidWake => {
      let _ = app.emit_to(
        CONNECTOR_WINDOW_LABEL,
        POWER_EVENT,
        PowerPayload {
          state: "didWake",
          ticket: None,
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// main 窓: フォルダの登録

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedFolder {
  id: String,
  name: String,
  available: bool,
}

fn folder_view(root: &RegisteredRoot) -> HostedFolder {
  HostedFolder {
    id: root.id.clone(),
    name: root.name.clone(),
    available: hosted_fs::root_available(root),
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderRequest {
  id: String,
}

/// 登録したフォルダ（名前と、今読めるか）。path は返さない。
#[tauri::command]
pub async fn camera_hosted_folders_list(app: tauri::AppHandle) -> Result<Vec<HostedFolder>, CameraError> {
  let roots = lock(&state(&app)?.roots).clone();
  run_blocking(move || Ok(roots.iter().map(folder_view).collect())).await
}

/// フォルダの選択ダイアログで 1 つ登録する（閉じたら null）。同じフォルダは 2 つにしない。登録すると常駐を登録し、
/// 接続用ソフトを動かす。
#[tauri::command]
pub async fn camera_hosted_folders_add(app: tauri::AppHandle) -> Result<Option<HostedFolder>, CameraError> {
  let Some(picked) = crate::dialog::pick_folder("フォルダを追加").await? else {
    return Ok(None);
  };
  let id = random_id("root")?;
  let candidate = run_blocking(move || hosted_fs::register(id, &picked).map_err(CameraError::from)).await?;
  let added = {
    let state = state(&app)?;
    let mut roots = lock(&state.roots);
    if let Some(existing) = roots
      .iter()
      .find(|root| root.dev == candidate.dev && root.ino == candidate.ino)
    {
      existing.clone()
    } else {
      if roots.len() >= MAX_ROOTS {
        return Err(invalid_request());
      }
      let mut next = roots.clone();
      next.push(candidate.clone());
      let path = state.roots_path.as_deref().ok_or_else(internal)?;
      save_roots(path, &next)?;
      *roots = next;
      candidate
    }
  };
  system::agent_register();
  ensure_connector_window(&app);
  Ok(Some(folder_view(&added)))
}

/// 登録を外す（フォルダと写真は消さない）。最後の 1 つを外すと、常駐の登録を外して接続用ソフトを止める。
#[tauri::command]
pub async fn camera_hosted_folders_remove(app: tauri::AppHandle, request: Option<Value>) -> Result<(), CameraError> {
  let request: FolderRequest = parse_request(request)?;
  let empty = {
    let state = state(&app)?;
    let mut roots = lock(&state.roots);
    let next: Vec<RegisteredRoot> = roots.iter().filter(|root| root.id != request.id).cloned().collect();
    if next.len() == roots.len() {
      return Ok(());
    }
    let path = state.roots_path.as_deref().ok_or_else(internal)?;
    save_roots(path, &next)?;
    *roots = next;
    roots.is_empty()
  };
  if empty {
    system::agent_unregister();
    close_connector_window(&app);
  }
  Ok(())
}

/// 常駐（launchd の LaunchAgent）の登録の状態。
#[tauri::command]
pub async fn camera_hosted_agent_status() -> Result<AgentStatus, CameraError> {
  run_blocking(|| Ok(system::agent_status())).await
}

// ---------------------------------------------------------------------------
// 接続用ソフトの窓: ファイル・vault・休止

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRoot {
  id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootRequest {
  root_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathRequest {
  root_id: String,
  path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashRequest {
  root_id: String,
  path: String,
  expected: ExpectedIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandleRequest {
  handle: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
  handle: u64,
  entry: EntryInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultRequest {
  contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HoldRequest {
  reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseRequest {
  hold_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SleepReadyRequest {
  ticket: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldAnswer {
  /// 休止を抑えられなければ null（job は続ける）
  hold_id: Option<u64>,
}

/// 登録したフォルダの ID（名前・path は渡さない）。別の process が書き換えたかもしれないので、毎回読み直す。
#[tauri::command]
pub fn camera_hosted_connector_roots(app: tauri::AppHandle) -> Result<Vec<ConnectorRoot>, CameraError> {
  Ok(
    state(&app)?
      .reload_roots()
      .into_iter()
      .map(|root| ConnectorRoot { id: root.id })
      .collect(),
  )
}

#[tauri::command]
pub async fn camera_hosted_connector_root_status(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<&'static str, CameraError> {
  let request: RootRequest = parse_request(request)?;
  let root = state(&app)?.root(&request.root_id)?;
  run_blocking(move || {
    Ok(if hosted_fs::root_available(&root) {
      "available"
    } else {
      "unmounted"
    })
  })
  .await
}

#[tauri::command]
pub async fn camera_hosted_connector_list(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<Vec<EntryInfo>, CameraError> {
  let request: PathRequest = parse_request(request)?;
  let root = state(&app)?.root(&request.root_id)?;
  run_blocking(move || hosted_fs::list(&root, &request.path).map_err(CameraError::from)).await
}

#[tauri::command]
pub async fn camera_hosted_connector_stat(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<Option<EntryInfo>, CameraError> {
  let request: PathRequest = parse_request(request)?;
  let root = state(&app)?.root(&request.root_id)?;
  run_blocking(move || hosted_fs::stat(&root, &request.path).map_err(CameraError::from)).await
}

/// 通常ファイルを read-only で開き、handle を返す（同時に `MAX_OPEN_FILES` まで）。
#[tauri::command]
pub async fn camera_hosted_connector_open(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<OpenedFile, CameraError> {
  let request: PathRequest = parse_request(request)?;
  let root = state(&app)?.root(&request.root_id)?;
  let (file, entry) = run_blocking(move || hosted_fs::open(&root, &request.path).map_err(CameraError::from)).await?;
  let state = state(&app)?;
  let mut files = lock(&state.files);
  if files.files.len() >= MAX_OPEN_FILES {
    return Err(invalid_request());
  }
  files.next += 1;
  let handle = files.next;
  files.files.insert(handle, (file, entry.name.clone()));
  Ok(OpenedFile { handle, entry })
}

/// 開いたファイルの続きを最大 `READ_CHUNK_BYTES` 読む（raw の bytes。空なら終わり）。
#[tauri::command]
pub async fn camera_hosted_connector_read(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<tauri::ipc::Response, CameraError> {
  let request: HandleRequest = parse_request(request)?;
  let (file, name) = {
    let state = state(&app)?;
    let mut files = lock(&state.files);
    files.files.remove(&request.handle).ok_or_else(invalid_request)?
  };
  let (file, name, bytes) = run_blocking(move || {
    let mut file = file;
    let mut bytes = vec![0u8; READ_CHUNK_BYTES];
    let mut filled = 0;
    while filled < bytes.len() {
      match file.read(&mut bytes[filled..]) {
        Ok(0) => break,
        Ok(read) => filled += read,
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
        Err(_) => return Err(internal()),
      }
    }
    bytes.truncate(filled);
    Ok((file, name, bytes))
  })
  .await?;
  // 読んでいる間は表から外し、同じ handle の読みが重ならないようにする
  lock(&state(&app)?.files).files.insert(request.handle, (file, name));
  Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn camera_hosted_connector_close(app: tauri::AppHandle, request: Option<Value>) -> Result<(), CameraError> {
  let request: HandleRequest = parse_request(request)?;
  lock(&state(&app)?.files).files.remove(&request.handle);
  Ok(())
}

/// ファイル全体の SHA-256 を native で読む（bytes を画面へ渡さない）。開いた時と読み終えた時の同一性が `expected` と
/// 違えば `changed`。
#[tauri::command]
pub async fn camera_hosted_connector_hash(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<HashOutcome, CameraError> {
  let request: HashRequest = parse_request(request)?;
  let root = state(&app)?.root(&request.root_id)?;
  run_blocking(move || hosted_fs::hash(&root, &request.path, &request.expected, &|| false).map_err(CameraError::from))
    .await
}

/// vault（JSON の文字列）を Keychain から読む。無ければ null。
#[tauri::command]
pub async fn camera_hosted_connector_vault_read() -> Result<Option<String>, CameraError> {
  run_blocking(|| match system::vault_read() {
    Ok(Some(bytes)) => String::from_utf8(bytes)
      .map(Some)
      .map_err(|_| hosted_error(hosted_code::VAULT)),
    Ok(None) => Ok(None),
    Err(_) => Err(hosted_error(hosted_code::VAULT)),
  })
  .await
}

/// vault 全体を Keychain へ書く（JSON の object・最大 `MAX_VAULT_BYTES`）。
#[tauri::command]
pub async fn camera_hosted_connector_vault_write(request: Option<Value>) -> Result<(), CameraError> {
  let request: VaultRequest = parse_request(request)?;
  let is_object = serde_json::from_str::<Value>(&request.contents).is_ok_and(|value| value.is_object());
  if !is_object || request.contents.len() > MAX_VAULT_BYTES {
    return Err(invalid_request());
  }
  run_blocking(move || system::vault_write(request.contents.as_bytes()).map_err(|_| hosted_error(hosted_code::VAULT)))
    .await
}

/// job・同期・走査の間、休止を抑える。
#[tauri::command]
pub fn camera_hosted_connector_power_hold(
  app: tauri::AppHandle,
  request: Option<Value>,
) -> Result<HoldAnswer, CameraError> {
  let request: HoldRequest = parse_request(request)?;
  if !matches!(request.reason.as_str(), "jobs" | "scan" | "sync") {
    return Err(invalid_request());
  }
  let state = state(&app)?;
  let mut holds = lock(&state.holds);
  if holds.assertions.len() >= MAX_HOLDS {
    return Err(invalid_request());
  }
  let Some(assertion) = system::hold_awake(&format!("NIHO photo: {}", request.reason)) else {
    return Ok(HoldAnswer { hold_id: None });
  };
  holds.next += 1;
  let id = holds.next;
  holds.assertions.insert(id, assertion);
  Ok(HoldAnswer { hold_id: Some(id) })
}

#[tauri::command]
pub fn camera_hosted_connector_power_release(app: tauri::AppHandle, request: Option<Value>) -> Result<(), CameraError> {
  let request: ReleaseRequest = parse_request(request)?;
  if let Some(assertion) = lock(&state(&app)?.holds).assertions.remove(&request.hold_id) {
    system::release_awake(assertion);
  }
  Ok(())
}

/// 休止の知らせへの答え（NIHO へ `sleeping` を送り終えた）。同じ ticket の休止だけを進める。
#[tauri::command]
pub fn camera_hosted_connector_sleep_ready(app: tauri::AppHandle, request: Option<Value>) -> Result<(), CameraError> {
  let request: SleepReadyRequest = parse_request(request)?;
  state(&app)?.sleep.ack(request.ticket);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Arc;
  use std::time::Instant;

  #[test]
  fn sleep_waits_for_the_answer_or_the_grace() {
    let gate = Arc::new(SleepGate::default());
    let ticket = gate.announce();
    let answering = Arc::clone(&gate);
    let answer = std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(20));
      answering.ack(ticket);
    });
    assert!(gate.wait(ticket, Duration::from_secs(5)), "the answer lets sleep go on");
    answer.join().unwrap();

    let started = Instant::now();
    let unanswered = gate.announce();
    assert!(
      !gate.wait(unanswered, Duration::from_millis(50)),
      "no answer: sleep goes on after the grace"
    );
    assert!(started.elapsed() >= Duration::from_millis(50));
    // 前の休止への遅れた答えは、次の休止を通さない
    let next = gate.announce();
    gate.ack(unanswered);
    assert!(!gate.wait(next, Duration::from_millis(10)));
    gate.ack(next);
    assert!(gate.wait(next, Duration::from_millis(10)));
  }

  #[test]
  fn only_one_process_runs_the_connector_and_the_lock_passes_on() {
    let dir = std::env::temp_dir().join(format!("niho-hosted-lock-{}", std::process::id()));
    let path = dir.join(CONNECTOR_LOCK_FILE);
    // flock は開いた file description ごとなので、同じ process の 2 つ目の open は別の process と同じく取れない
    let first = try_lock(&path).expect("the first holder gets the lock");
    assert!(try_lock(&path).is_none(), "a second holder waits");
    drop(first);
    assert!(try_lock(&path).is_some(), "the lock passes on when the holder ends");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn closing_the_connector_page_releases_its_holds_and_files() {
    let dir = std::env::temp_dir().join(format!("niho-hosted-release-{}", std::process::id()));
    let state = HostedConnectorState::new(Some(dir.clone()));
    {
      let mut holds = lock(&state.holds);
      holds.assertions.insert(1, 11);
      holds.assertions.insert(2, 12);
    }
    let file = File::open("/dev/null").unwrap();
    lock(&state.files).files.insert(1, (file, "a.jpg".into()));
    let mut released = state.release_page_resources();
    released.sort_unstable();
    assert_eq!(released, vec![11, 12]);
    assert!(lock(&state.holds).assertions.is_empty());
    assert!(lock(&state.files).files.is_empty());
    assert!(state.release_page_resources().is_empty(), "nothing is released twice");
    assert!(state.acquire_connector_lock());
    assert!(state.acquire_connector_lock(), "the holder keeps it");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn roots_are_saved_atomically_and_read_back() {
    let dir = std::env::temp_dir().join(format!("niho-hosted-roots-{}", std::process::id()));
    let path = dir.join(ROOTS_FILE);
    let roots = vec![RegisteredRoot {
      id: "root-1".into(),
      name: "Photos".into(),
      path: "/synthetic/Photos".into(),
      dev: 1,
      ino: 2,
    }];
    assert!(load_roots(&path).is_empty(), "no file: no roots");
    save_roots(&path, &roots).unwrap();
    assert_eq!(load_roots(&path), roots);
    assert!(!path.with_extension("json.tmp").exists());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    std::fs::write(&path, b"{ broken").unwrap();
    assert!(load_roots(&path).is_empty(), "a broken file reads as no roots");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn ids_are_random_and_prefixed() {
    let a = random_id("root").unwrap();
    let b = random_id("root").unwrap();
    assert!(a.starts_with("root-") && a.len() == 5 + 32);
    assert_ne!(a, b);
  }

  #[test]
  fn fs_errors_map_to_stable_codes_without_paths() {
    assert_eq!(CameraError::from(FsError::Unavailable).code, hosted_code::UNAVAILABLE);
    assert_eq!(CameraError::from(FsError::Refused).code, hosted_code::REFUSED);
    assert_eq!(CameraError::from(FsError::NotFound).code, hosted_code::NOT_FOUND);
    assert_eq!(CameraError::from(FsError::Io).code, internal().code);
  }
}
