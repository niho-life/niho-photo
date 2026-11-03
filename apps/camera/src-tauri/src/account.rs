//! 公式NIHO app-connect。公開Firebase Web API keyの無いbuildはlocal-only。
//! 設定はbundled native codeで監査して与える。URLやtokenをIPCから受け取らない。
use niho_desktop_account::{
  Account, AccountPhase, AccountSnapshot, ClientId, Config, FileSecretStore, PhotoIdentity, Secret,
};
use serde::Serialize;
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

pub const PHOTO_IDENTITY_INVALIDATED_EVENT: &str = "camera-photo-identity-invalidated";

#[derive(Clone, Copy, Serialize)]
struct PhotoIdentityInvalidated {
  invalidated: bool,
}

struct SharedAccount {
  account: Account,
  invalidated: AtomicBool,
}

impl SharedAccount {
  fn new(account: Account) -> Self {
    Self {
      account,
      invalidated: AtomicBool::new(false),
    }
  }

  fn emit_invalidation(&self, app: &AppHandle) {
    self.invalidated.store(true, Ordering::SeqCst);
    let _ = app.emit(
      PHOTO_IDENTITY_INVALIDATED_EVENT,
      PhotoIdentityInvalidated { invalidated: true },
    );
  }

  fn observe(&self, app: &AppHandle) -> AccountSnapshot {
    let snapshot = self.account.snapshot();
    if snapshot.phase == AccountPhase::Connected {
      self.invalidated.store(false, Ordering::SeqCst);
    } else if (snapshot.phase == AccountPhase::Failed
      || matches!(
        snapshot.error,
        Some(niho_desktop_account::AccountError::Expired | niho_desktop_account::AccountError::AccountUnavailable)
      ))
      && !self.invalidated.swap(true, Ordering::SeqCst)
    {
      let _ = app.emit(
        PHOTO_IDENTITY_INVALIDATED_EVENT,
        PhotoIdentityInvalidated { invalidated: true },
      );
    }
    snapshot
  }
}

pub fn install(app: &tauri::AppHandle) {
  let configured = option_env!("NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY")
    .filter(|key| !key.is_empty())
    .and_then(|key| Config::production(ClientId::Camera, key).ok())
    .and_then(|config| {
      app.path().app_data_dir().ok().and_then(|dir| {
        FileSecretStore::in_data_dir(&dir.join("public-account-v2"))
          .ok()
          .map(|store| Account::new(config, Arc::new(store)))
      })
    });
  let account = Arc::new(SharedAccount::new(configured.unwrap_or_else(Account::disabled)));
  app.manage(Arc::clone(&account));
  let callbacks = Arc::clone(&account);
  let callback_app = app.clone();
  app.deep_link().on_open_url(move |event| {
    for url in event.urls() {
      let account = Arc::clone(&callbacks);
      let app = callback_app.clone();
      let raw = Secret::new(url.as_str());
      tauri::async_runtime::spawn_blocking(move || {
        let _ = account.account.handle_callback(&raw);
        account.observe(&app);
      });
    }
  });
  // 起動時に届いたURLも、同じ永続pending/単回消費の検証を通す。
  let initial = app.deep_link().get_current().ok().flatten().unwrap_or_default();
  if account.account.snapshot().available {
    let background_app = app.clone();
    std::thread::spawn(move || {
      let _ = account.account.restore();
      account.observe(&background_app);
      for url in initial {
        let _ = account.account.handle_callback(&Secret::new(url.as_str()));
        account.observe(&background_app);
      }
      loop {
        let _ = account.account.maintain();
        account.observe(&background_app);
        std::thread::sleep(std::time::Duration::from_secs(1));
      }
    });
  }
}
#[tauri::command]
pub fn camera_account_state(app: AppHandle, account: State<'_, Arc<SharedAccount>>) -> AccountSnapshot {
  account.observe(&app)
}
#[tauri::command]
pub async fn camera_account_login(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
) -> Result<(), niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  let worker = Arc::clone(&account);
  let result = tauri::async_runtime::spawn_blocking(move || worker.account.login())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?;
  account.observe(&app);
  result
}
#[tauri::command]
pub fn camera_account_cancel(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
) -> Result<(), niho_desktop_account::AccountError> {
  let refreshing = account.account.snapshot().phase == AccountPhase::Refreshing;
  let result = account.account.cancel();
  if refreshing {
    account.emit_invalidation(&app);
  } else {
    account.observe(&app);
  }
  result
}
#[tauri::command]
pub async fn camera_account_logout(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
) -> Result<(), niho_desktop_account::AccountError> {
  // UIへはnative cleanup/network完了を待たず、logout開始時点で失効を知らせる。
  account.emit_invalidation(&app);
  let account = Arc::clone(account.inner());
  tauri::async_runtime::spawn_blocking(move || account.account.logout())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?
}
#[tauri::command]
pub async fn camera_account_refresh(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
) -> Result<(), niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  let worker = Arc::clone(&account);
  let result = tauri::async_runtime::spawn_blocking(move || worker.account.refresh())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?;
  account.observe(&app);
  result
}

#[tauri::command]
pub async fn camera_photo_identity(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
) -> Result<PhotoIdentity, niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  let worker = Arc::clone(&account);
  let result = tauri::async_runtime::spawn_blocking(move || worker.account.photo_identity())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?;
  account.observe(&app);
  result
}
