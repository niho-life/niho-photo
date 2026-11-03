//! 公式NIHO app-connect。公開Firebase Web API keyの無いbuildはlocal-only。
//! 設定はbundled native codeで監査して与える。URLやtokenをIPCから受け取らない。
use niho_desktop_account::{
  Account, AccountPhase, AccountSnapshot, ClientId, Config, FileSecretStore, PhotoIdentity, Secret,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

pub const PHOTO_IDENTITY_INVALIDATED_EVENT: &str = "camera-photo-identity-invalidated";

#[derive(Clone, Copy, Serialize)]
struct PhotoIdentityInvalidated {
  invalidated: bool,
}

pub(crate) struct SharedAccount {
  account: Account,
  photo_identity: PhotoIdentityFence,
}

/// Fences logout, refresh, and fresh-login transitions around reads that
/// return the native photo identity. The account's own lock protects native
/// credentials; this generation also protects the response while the HTTP
/// read is in flight.
#[derive(Default)]
struct PhotoIdentityFence {
  state: Mutex<PhotoIdentityFenceState>,
}

#[derive(Default)]
struct PhotoIdentityFenceState {
  generation: u64,
  invalidated: bool,
  terminal: bool,
  login_generation: Option<u64>,
}

impl PhotoIdentityFence {
  fn generation(&self) -> Result<u64, niho_desktop_account::AccountError> {
    self
      .state
      .lock()
      .map(|state| state.generation)
      .map_err(|_| niho_desktop_account::AccountError::Internal)
  }

  fn begin_read(&self) -> Result<u64, niho_desktop_account::AccountError> {
    let state = self
      .state
      .lock()
      .map_err(|_| niho_desktop_account::AccountError::Internal)?;
    if state.invalidated {
      return Err(niho_desktop_account::AccountError::Expired);
    }
    Ok(state.generation)
  }

  fn read_is_current(&self, generation: u64) -> bool {
    self
      .state
      .lock()
      .is_ok_and(|state| !state.invalidated && state.generation == generation)
  }

  fn begin_refresh(&self) -> Result<u64, niho_desktop_account::AccountError> {
    let state = self
      .state
      .lock()
      .map_err(|_| niho_desktop_account::AccountError::Internal)?;
    if state.terminal {
      return Err(niho_desktop_account::AccountError::Expired);
    }
    Ok(state.generation)
  }

  fn finish_refresh(&self, generation: u64) -> bool {
    let Ok(mut state) = self.state.lock() else { return false };
    if state.generation != generation || state.terminal {
      return false;
    }
    state.generation = state.generation.saturating_add(1);
    state.invalidated = false;
    true
  }

  fn arm_login(&self) -> Result<u64, niho_desktop_account::AccountError> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| niho_desktop_account::AccountError::Internal)?;
    state.generation = state.generation.saturating_add(1);
    let generation = state.generation;
    state.login_generation = Some(generation);
    Ok(generation)
  }

  fn login_generation(&self) -> Option<u64> {
    self.state.lock().ok()?.login_generation
  }

  fn finish_login(&self, generation: u64) -> bool {
    let Ok(mut state) = self.state.lock() else { return false };
    if state.generation != generation || state.login_generation != Some(generation) {
      return false;
    }
    state.generation = state.generation.saturating_add(1);
    state.invalidated = false;
    state.terminal = false;
    state.login_generation = None;
    true
  }

  fn clear_login_permit(&self, generation: u64) {
    if let Ok(mut state) = self.state.lock() {
      if state.generation == generation && state.login_generation == Some(generation) {
        state.login_generation = None;
      }
    }
  }

  fn invalidate_terminal(&self) {
    if let Ok(mut state) = self.state.lock() {
      state.generation = state.generation.saturating_add(1);
      state.invalidated = true;
      state.terminal = true;
      state.login_generation = None;
    }
  }

  fn invalidate_terminal_if_current(&self, generation: u64) -> bool {
    let Ok(mut state) = self.state.lock() else { return true };
    if state.generation != generation || state.terminal || state.login_generation.is_some() {
      return false;
    }
    state.generation = state.generation.saturating_add(1);
    state.invalidated = true;
    state.terminal = true;
    state.login_generation = None;
    true
  }

  fn invalidate_recoverable(&self) {
    if let Ok(mut state) = self.state.lock() {
      state.generation = state.generation.saturating_add(1);
      state.invalidated = true;
      state.login_generation = None;
    }
  }
}

impl SharedAccount {
  fn new(account: Account) -> Self {
    Self {
      account,
      photo_identity: PhotoIdentityFence::default(),
    }
  }

  fn emit_invalidation(&self, app: &AppHandle) {
    self.photo_identity.invalidate_terminal();
    self.emit_invalidated(app);
  }

  fn emit_invalidated(&self, app: &AppHandle) {
    let _ = app.emit(
      PHOTO_IDENTITY_INVALIDATED_EVENT,
      PhotoIdentityInvalidated { invalidated: true },
    );
  }

  fn observe(&self, app: &AppHandle) -> AccountSnapshot {
    let generation = self.photo_identity.generation().ok();
    let snapshot = self.account.snapshot();
    if (snapshot.phase == AccountPhase::Failed
      || matches!(
        snapshot.error,
        Some(niho_desktop_account::AccountError::Expired | niho_desktop_account::AccountError::AccountUnavailable)
      ))
      && generation.is_some_and(|generation| self.photo_identity.invalidate_terminal_if_current(generation))
    {
      self.emit_invalidated(app);
    }
    snapshot
  }
}

#[cfg(test)]
mod photo_identity_fence_tests {
  use super::PhotoIdentityFence;
  use niho_desktop_account::AccountError;

  #[test]
  fn logout_blocks_new_reads_and_fences_an_in_flight_read() {
    let fence = PhotoIdentityFence::default();
    let read_generation = fence.begin_read().unwrap();

    fence.invalidate_terminal();

    assert_eq!(fence.begin_read(), Err(AccountError::Expired));
    assert!(!fence.read_is_current(read_generation));
  }

  #[test]
  fn refresh_started_before_logout_cannot_reopen_the_identity_fence() {
    let fence = PhotoIdentityFence::default();
    let refresh_generation = fence.begin_refresh().unwrap();

    fence.invalidate_terminal();

    assert!(!fence.finish_refresh(refresh_generation));
    assert_eq!(fence.begin_refresh(), Err(AccountError::Expired));
  }

  #[test]
  fn cancelling_a_refresh_cannot_downgrade_an_active_logout() {
    let fence = PhotoIdentityFence::default();
    fence.invalidate_terminal();

    fence.invalidate_recoverable();

    assert_eq!(fence.begin_refresh(), Err(AccountError::Expired));
    assert_eq!(fence.begin_read(), Err(AccountError::Expired));
  }

  #[test]
  fn only_a_fresh_login_callback_can_clear_terminal_invalidation() {
    let fence = PhotoIdentityFence::default();
    fence.invalidate_terminal();
    assert!(fence.arm_login().is_ok());

    let callback_generation = fence.login_generation().unwrap();
    assert_eq!(fence.login_generation(), Some(callback_generation));
    assert!(fence.finish_login(callback_generation));
    assert!(fence.begin_read().is_ok());
  }

  #[test]
  fn callback_started_before_logout_cannot_clear_its_invalidation() {
    let fence = PhotoIdentityFence::default();
    assert!(fence.arm_login().is_ok());
    let callback_generation = fence.login_generation().unwrap();

    fence.invalidate_terminal();

    assert!(!fence.finish_login(callback_generation));
    assert_eq!(fence.begin_read(), Err(AccountError::Expired));
  }

  #[test]
  fn a_stale_failure_observation_cannot_overwrite_a_fresh_login() {
    let fence = PhotoIdentityFence::default();
    let observed_generation = fence.generation().unwrap();
    let login_generation = fence.arm_login().unwrap();

    assert!(!fence.invalidate_terminal_if_current(observed_generation));
    assert_eq!(fence.login_generation(), Some(login_generation));
    assert!(fence.finish_login(login_generation));
    assert!(fence.begin_read().is_ok());
  }

  #[test]
  fn a_new_successful_refresh_can_clear_recoverable_cancellation() {
    let fence = PhotoIdentityFence::default();
    let cancelled_generation = fence.begin_refresh().unwrap();
    fence.invalidate_recoverable();
    assert!(!fence.finish_refresh(cancelled_generation));

    let retry_generation = fence.begin_refresh().unwrap();
    assert!(fence.finish_refresh(retry_generation));
    assert!(fence.begin_read().is_ok());
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
        let login_generation = account.photo_identity.login_generation();
        let result = account.account.handle_callback(&raw);
        if result.is_ok() {
          if let Some(generation) = login_generation {
            account.photo_identity.finish_login(generation);
          }
        }
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
        if let Ok(generation) = account.photo_identity.begin_refresh() {
          let before = account.account.snapshot().phase;
          let result = account.account.maintain();
          if result.is_ok()
            && before != AccountPhase::Connected
            && account.account.snapshot().phase == AccountPhase::Connected
          {
            account.photo_identity.finish_refresh(generation);
          }
        }
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
  let login_generation = account.photo_identity.arm_login()?;
  let worker = Arc::clone(&account);
  let result = match tauri::async_runtime::spawn_blocking(move || worker.account.login()).await {
    Ok(result) => result,
    Err(_) => {
      account.photo_identity.clear_login_permit(login_generation);
      return Err(niho_desktop_account::AccountError::Internal);
    }
  };
  if result.is_err() {
    account.photo_identity.clear_login_permit(login_generation);
  }
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
    account.photo_identity.invalidate_recoverable();
    account.emit_invalidated(&app);
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
  let refresh_generation = account.photo_identity.begin_refresh()?;
  let worker = Arc::clone(&account);
  let result = tauri::async_runtime::spawn_blocking(move || worker.account.refresh())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?;
  if result.is_ok() && !account.photo_identity.finish_refresh(refresh_generation) {
    return Err(niho_desktop_account::AccountError::Cancelled);
  }
  account.observe(&app);
  result
}

#[tauri::command]
pub async fn camera_photo_identity(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
) -> Result<PhotoIdentity, niho_desktop_account::AccountError> {
  let account = Arc::clone(account.inner());
  let read_generation = account.photo_identity.begin_read()?;
  let worker = Arc::clone(&account);
  let result = tauri::async_runtime::spawn_blocking(move || worker.account.photo_identity())
    .await
    .map_err(|_| niho_desktop_account::AccountError::Internal)?;
  account.observe(&app);
  match result {
    Ok(identity) if account.photo_identity.read_is_current(read_generation) => Ok(identity),
    Ok(_) => Err(niho_desktop_account::AccountError::Cancelled),
    Err(error) => Err(error),
  }
}
