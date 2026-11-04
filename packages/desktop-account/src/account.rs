use crate::connect::{equal, secret_43, Pending};
use crate::photo_cloud::{
  content_request, native_copy_request, native_request, original_metadata, original_metadata_for_photo,
  parse_renew_upload, parse_start_upload, parse_upload, parse_upload_receipt, provider_ack, read_json_response,
  read_native_upload_response, stream_verified_content, CapturedPhotoAuthority, HttpPhotoCloud, PhotoHttpTransport,
};
use crate::photo_session::{parse_response, parse_strict_iso, HttpPhotoSession, PhotoSessionTransport};
use crate::{
  AccountError, Browser, Cancel, ClientId, Config, CredentialStore, ExternalBrowser, HttpTransport, NativeCopyTarget,
  NativeProviderAck, NativeStartUpload, NativeUpload, NativeUploadTicket, PhotoContentMetadata, PhotoDownloadCancel,
  PhotoIdentity, PhotoJsonResponse, PhotoOperation, PhotoRequest, PhotoScopeCapture, Request, Response, Secret,
  SecretKind, Transport, SAFETY_CONTRACT_VERSION,
};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountPhase {
  LocalOnly,
  SignedOut,
  Waiting,
  Refreshing,
  Connected,
  Offline,
  Failed,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
  pub contract_version: u32,
  pub phase: AccountPhase,
  pub available: bool,
  pub local_editing_available: bool,
  pub error: Option<AccountError>,
}
struct Inner {
  phase: AccountPhase,
  error: Option<AccountError>,
  generation: u64,
  cancel: Option<Cancel>,
  access: Option<Secret>,
  photo_identity: Option<PhotoIdentity>,
  photo_identity_expires_at_ms: u64,
  expires_at_ms: u64,
  next_attempt_ms: u64,
  retry_delay_ms: u64,
}
struct Adapters {
  config: Config,
  store: Arc<dyn CredentialStore>,
  browser: Arc<dyn Browser>,
  transport: Arc<dyn Transport>,
  photo_session: Arc<dyn PhotoSessionTransport>,
  photo_http: Arc<dyn PhotoHttpTransport>,
}
pub(crate) trait Clock: Send + Sync {
  fn now_ms(&self) -> Result<u64, AccountError>;
}
struct SystemClock;
impl Clock for SystemClock {
  fn now_ms(&self) -> Result<u64, AccountError> {
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .ok()
      .and_then(|v| v.as_millis().try_into().ok())
      .ok_or(AccountError::Internal)
  }
}
pub struct Account {
  adapters: Option<Adapters>,
  inner: Mutex<Inner>,
  clock: Arc<dyn Clock>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConnection {
  version: u32,
  client: crate::ClientId,
  refresh_token: Secret,
  connection_id: String,
  user_id: String,
}
impl StoredConnection {
  fn encode(&self) -> Result<Secret, AccountError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Record<'a> {
      version: u32,
      client: crate::ClientId,
      refresh_token: &'a str,
      connection_id: &'a str,
      user_id: &'a str,
    }
    serde_json::to_string(&Record {
      version: self.version,
      client: self.client,
      refresh_token: self.refresh_token.expose(),
      connection_id: &self.connection_id,
      user_id: &self.user_id,
    })
    .map(Secret::new)
    .map_err(|_| AccountError::Storage)
  }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeResponse {
  custom_token: Secret,
  refresh_token: Secret,
  connection_id: String,
  user: User,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshResponse {
  custom_token: Secret,
  refresh_token: Secret,
}
#[derive(Deserialize)]
struct User {
  id: String,
}
#[derive(Deserialize)]
struct MeResponse {
  user: User,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInResponse {
  id_token: Secret,
  expires_in: serde_json::Value,
}
fn opaque_id(value: &str) -> bool {
  !value.is_empty() && value.len() <= 256 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn token(value: &Secret) -> bool {
  !value.expose().is_empty() && value.expose().len() <= 16384 && value.expose().bytes().all(|b| b.is_ascii_graphic())
}
fn json_request<T: Serialize>(url: url::Url, body: &T) -> Result<Request, AccountError> {
  Ok(Request {
    method: "POST",
    url: Secret::new(url.as_str()),
    body: Some(Secret::new(
      serde_json::to_string(body).map_err(|_| AccountError::Internal)?,
    )),
    bearer: None,
  })
}
fn accepted(response: Response) -> Result<Secret, AccountError> {
  if response.status == 200 {
    return Ok(response.body);
  }
  // 生のbody/messageは外へ返さない。認識する固定分類だけを拾う。
  let value: serde_json::Value = serde_json::from_str(response.body.expose()).unwrap_or_default();
  let reason = value
    .get("details")
    .and_then(|v| v.get("reason"))
    .and_then(|v| v.as_str())
    .unwrap_or_default();
  let code = value.get("code").and_then(|v| v.as_str()).unwrap_or_default();
  Err(if reason == "app_connect_disabled" {
    AccountError::Paused
  } else if reason == "code_expired" || matches!(reason, "app_connection_revoked" | "session_revoked") {
    AccountError::Expired
  } else if code == "ACCOUNT_DELETED" || reason == "firebase_user_disabled" {
    AccountError::AccountUnavailable
  } else if response.status == 429 || response.status >= 500 {
    AccountError::Network
  } else {
    AccountError::Rejected
  })
}
impl Account {
  pub fn disabled() -> Self {
    Self::build(None, Arc::new(SystemClock))
  }
  pub fn new(config: Config, store: Arc<dyn CredentialStore>) -> Self {
    Self::with_adapters(config, store, Arc::new(ExternalBrowser), Arc::new(HttpTransport))
  }
  pub fn with_adapters(
    config: Config,
    store: Arc<dyn CredentialStore>,
    browser: Arc<dyn Browser>,
    transport: Arc<dyn Transport>,
  ) -> Self {
    Self::build(
      Some(Adapters {
        config,
        store,
        browser,
        transport,
        photo_session: Arc::new(HttpPhotoSession),
        photo_http: Arc::new(HttpPhotoCloud),
      }),
      Arc::new(SystemClock),
    )
  }
  #[cfg(test)]
  pub(crate) fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
    self.clock = clock;
    self
  }
  #[cfg(test)]
  pub(crate) fn with_photo_session(mut self, photo_session: Arc<dyn PhotoSessionTransport>) -> Self {
    self.adapters.as_mut().expect("configured test account").photo_session = photo_session;
    self
  }
  #[cfg(test)]
  pub(crate) fn with_photo_http(mut self, photo_http: Arc<dyn PhotoHttpTransport>) -> Self {
    self.adapters.as_mut().expect("configured test account").photo_http = photo_http;
    self
  }
  fn preflight_error(&self, error: AccountError) -> AccountError {
    if matches!(
      error,
      AccountError::Storage | AccountError::Internal | AccountError::Expired
    ) {
      if let Ok(mut inner) = self.inner.lock() {
        inner.phase = AccountPhase::Failed;
        inner.error = Some(error);
        inner.access = None;
      }
    }
    error
  }
  fn build(adapters: Option<Adapters>, clock: Arc<dyn Clock>) -> Self {
    let phase = if adapters.is_some() {
      AccountPhase::SignedOut
    } else {
      AccountPhase::LocalOnly
    };
    Self {
      adapters,
      clock,
      inner: Mutex::new(Inner {
        phase,
        error: None,
        generation: 0,
        cancel: None,
        access: None,
        photo_identity: None,
        photo_identity_expires_at_ms: 0,
        expires_at_ms: 0,
        next_attempt_ms: u64::MAX,
        retry_delay_ms: 1000,
      }),
    }
  }
  pub fn snapshot(&self) -> AccountSnapshot {
    let Ok(mut inner) = self.inner.lock() else {
      return AccountSnapshot {
        contract_version: SAFETY_CONTRACT_VERSION,
        phase: AccountPhase::Failed,
        available: false,
        local_editing_available: true,
        error: Some(AccountError::Internal),
      };
    };
    if inner.phase == AccountPhase::Connected && self.clock.now_ms().map_or(true, |v| v >= inner.expires_at_ms) {
      inner.phase = AccountPhase::Offline;
      inner.error = Some(AccountError::Expired);
      inner.access = None;
    }
    if inner.phase == AccountPhase::Waiting && inner.cancel.is_none() {
      if let Some(adapters) = &self.adapters {
        let valid = self.pending(adapters).is_ok_and(|p| !p.consumed);
        if !valid {
          inner.phase = AccountPhase::Failed;
          inner.error = Some(AccountError::Expired);
          let _ = adapters.store.clear(SecretKind::Pending);
        }
      }
    }
    AccountSnapshot {
      contract_version: SAFETY_CONTRACT_VERSION,
      phase: inner.phase,
      available: self.adapters.is_some(),
      local_editing_available: true,
      error: inner.error,
    }
  }
  fn pending(&self, adapters: &Adapters) -> Result<Pending, AccountError> {
    let raw = adapters.store.load(SecretKind::Pending)?.ok_or(AccountError::Expired)?;
    let pending: Pending = serde_json::from_str(raw.expose()).map_err(|_| AccountError::Storage)?;
    if !pending.valid(adapters.config.client, self.clock.now_ms()?) {
      return Err(AccountError::Expired);
    }
    Ok(pending)
  }
  /// pendingはbrowserより先に永続化する。cold startのdeep linkでも同じ試行を継続できる。
  pub fn login(&self) -> Result<(), AccountError> {
    self.begin_login().map_err(|error| self.preflight_error(error))
  }
  fn begin_login(&self) -> Result<(), AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let (generation, pending) = {
      let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      if inner.cancel.is_some()
        || self.pending(adapters).is_ok_and(|p| !p.consumed)
        || adapters.store.load(SecretKind::RefreshToken)?.is_some()
      {
        return Err(AccountError::Busy);
      }
      let pending = Pending::new(adapters.config.client, self.clock.now_ms()?)?;
      adapters.store.save(SecretKind::Pending, &pending.encode()?)?;
      inner.generation = inner.generation.checked_add(1).ok_or(AccountError::Internal)?;
      inner.phase = AccountPhase::Waiting;
      inner.error = None;
      (inner.generation, pending)
    };
    if adapters.browser.open(&adapters.config.connect_url(&pending)).is_err() {
      let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      if inner.generation == generation {
        adapters.store.clear(SecretKind::Pending)?;
        inner.phase = AccountPhase::Failed;
        inner.error = Some(AccountError::Browser);
      }
      return Err(AccountError::Browser);
    }
    Ok(())
  }
  /// OS callbackだけから呼ぶ。IPCで任意URLを受け取るコマンドは公開しない。
  pub fn handle_callback(&self, raw: &Secret) -> Result<(), AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let callback = crate::parse_callback(adapters.config.client, raw)?;
    let (generation, cancel, pending) = {
      let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      if inner.cancel.is_some() {
        return Err(AccountError::Busy);
      }
      let mut pending = self.pending(adapters)?;
      if pending.consumed {
        return Err(AccountError::Rejected);
      }
      if !equal(callback.state.expose(), pending.state.expose()) {
        return Err(AccountError::InvalidState);
      }
      pending.consumed = true;
      // crash/restart後も同じcodeを再交換しない印をHTTPより前に書く。
      adapters.store.save(SecretKind::Pending, &pending.encode()?)?;
      let cancel = Cancel::default();
      inner.cancel = Some(cancel.clone());
      inner.phase = AccountPhase::Waiting;
      (inner.generation, cancel, pending)
    };
    let result = (|| {
      #[derive(Serialize)]
      #[serde(rename_all = "camelCase")]
      struct Body<'a> {
        client_id: &'a str,
        code: &'a str,
        code_verifier: &'a str,
        device_name: &'a str,
      }
      let request = json_request(
        adapters.config.api_url("/api/auth/app-connect/exchange"),
        &Body {
          client_id: adapters.config.client.as_str(),
          code: callback.code.expose(),
          code_verifier: pending.verifier.expose(),
          device_name: "Mac",
        },
      )?;
      let response = self.call(adapters, &request, &cancel)?;
      let response: ExchangeResponse =
        serde_json::from_str(response.expose()).map_err(|_| AccountError::InvalidResponse)?;
      if !secret_43(response.refresh_token.expose())
        || !opaque_id(&response.connection_id)
        || !opaque_id(&response.user.id)
        || !token(&response.custom_token)
      {
        return Err(AccountError::InvalidResponse);
      }
      let stored = StoredConnection {
        version: SAFETY_CONTRACT_VERSION,
        client: adapters.config.client,
        refresh_token: response.refresh_token,
        connection_id: response.connection_id,
        user_id: response.user.id,
      };
      self.save_connection(adapters, &stored, generation, &cancel)?;
      self.sign_in(adapters, &response.custom_token, &stored, generation, &cancel, true)
    })();
    self.finish(adapters, generation, result, true)
  }
  fn call(&self, adapters: &Adapters, request: &Request, cancel: &Cancel) -> Result<Secret, AccountError> {
    cancel.check()?;
    let response = adapters.transport.send(&adapters.config, request, cancel)?;
    cancel.check()?;
    accepted(response)
  }
  fn save_connection(
    &self,
    adapters: &Adapters,
    stored: &StoredConnection,
    generation: u64,
    cancel: &Cancel,
  ) -> Result<(), AccountError> {
    let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    cancel.check()?;
    if inner.generation != generation {
      return Err(AccountError::Cancelled);
    }
    adapters.store.save(SecretKind::RefreshToken, &stored.encode()?)
  }
  fn sign_in(
    &self,
    adapters: &Adapters,
    custom: &Secret,
    connection: &StoredConnection,
    generation: u64,
    cancel: &Cancel,
    cleanup_on_failure: bool,
  ) -> Result<(), AccountError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Body<'a> {
      token: &'a str,
      return_secure_token: bool,
    }
    let request = json_request(
      adapters.config.identity_url(),
      &Body {
        token: custom.expose(),
        return_secure_token: true,
      },
    )?;
    let response = self.call(adapters, &request, cancel)?;
    let response: SignInResponse =
      serde_json::from_str(response.expose()).map_err(|_| AccountError::InvalidResponse)?;
    let seconds = response
      .expires_in
      .as_u64()
      .or_else(|| response.expires_in.as_str().and_then(|v| v.parse().ok()))
      .ok_or(AccountError::InvalidResponse)?;
    if !(1..=3600).contains(&seconds) || !token(&response.id_token) {
      return Err(AccountError::InvalidResponse);
    }
    let result = (|| {
      // Firebase refreshToken / JWT role等は一切読まない。固定HTTPS NIHO serverの/me受理が必要。
      let request = Request {
        method: "GET",
        url: Secret::new(adapters.config.api_url("/api/auth/me").as_str()),
        body: None,
        bearer: Some(response.id_token.clone()),
      };
      let me = self.call(adapters, &request, cancel)?;
      let me: MeResponse = serde_json::from_str(me.expose()).map_err(|_| AccountError::InvalidResponse)?;
      if me.user.id != connection.user_id {
        return Err(AccountError::InvalidResponse);
      }
      let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      cancel.check()?;
      if inner.generation != generation {
        return Err(AccountError::Cancelled);
      }
      inner.access = Some(response.id_token.clone());
      inner.expires_at_ms = self
        .clock
        .now_ms()?
        .checked_add(seconds * 1000)
        .ok_or(AccountError::Internal)?;
      inner.next_attempt_ms = inner
        .expires_at_ms
        .saturating_sub(300_000)
        .max(self.clock.now_ms()? + 1000);
      inner.retry_delay_ms = 1000;
      inner.phase = AccountPhase::Connected;
      inner.error = None;
      Ok(())
    })();
    if result.is_err() && cleanup_on_failure {
      self.cleanup_connection(adapters, &response.id_token, &connection.connection_id);
    }
    result
  }
  fn cleanup_connection(&self, adapters: &Adapters, id_token: &Secret, connection_id: &str) {
    let mut url = adapters
      .config
      .api_url(&format!("/api/auth/app-connections/{connection_id}"));
    url.query_pairs_mut().append_pair("reason", "logout");
    let request = Request {
      method: "DELETE",
      url: Secret::new(url.as_str()),
      body: None,
      bearer: Some(id_token.clone()),
    };
    let response = adapters.transport.send(&adapters.config, &request, &Cancel::default());
    let removed = match response {
      Ok(response) if response.status == 204 => true,
      Ok(response) => matches!(accepted(response), Err(AccountError::Expired)),
      Err(_) => false,
    };
    if removed {
      if let Ok(_inner) = self.inner.lock() {
        // 新しいloginが既に別の接続を保存していたら触らない。
        if let Ok(Some(raw)) = adapters.store.load(SecretKind::RefreshToken) {
          if serde_json::from_str::<StoredConnection>(raw.expose())
            .is_ok_and(|current| current.connection_id == connection_id)
          {
            let _ = adapters.store.clear(SecretKind::RefreshToken);
          }
        }
      }
    }
  }
  /// NIHO接続refresh tokenを回転させ、永続化してからFirebaseへ交換する。
  pub fn refresh(&self) -> Result<(), AccountError> {
    self.refresh_inner().map_err(|error| self.preflight_error(error))
  }
  fn refresh_inner(&self) -> Result<(), AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let (generation, cancel, mut stored) = {
      let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      if inner.cancel.is_some() || self.pending(adapters).is_ok_and(|p| !p.consumed) {
        return Err(AccountError::Busy);
      }
      let raw = adapters
        .store
        .load(SecretKind::RefreshToken)?
        .ok_or(AccountError::Expired)?;
      let stored: StoredConnection = serde_json::from_str(raw.expose()).map_err(|_| AccountError::Storage)?;
      if stored.version != SAFETY_CONTRACT_VERSION
        || stored.client != adapters.config.client
        || !secret_43(stored.refresh_token.expose())
        || !opaque_id(&stored.connection_id)
        || !opaque_id(&stored.user_id)
      {
        return Err(AccountError::Storage);
      }
      inner.generation = inner.generation.checked_add(1).ok_or(AccountError::Internal)?;
      let cancel = Cancel::default();
      inner.cancel = Some(cancel.clone());
      inner.phase = AccountPhase::Refreshing;
      inner.error = None;
      (inner.generation, cancel, stored)
    };
    let result = (|| {
      #[derive(Serialize)]
      #[serde(rename_all = "camelCase")]
      struct Body<'a> {
        client_id: &'a str,
        refresh_token: &'a str,
      }
      let request = json_request(
        adapters.config.api_url("/api/auth/app-connect/refresh"),
        &Body {
          client_id: adapters.config.client.as_str(),
          refresh_token: stored.refresh_token.expose(),
        },
      )?;
      let response = self.call(adapters, &request, &cancel)?;
      let response: RefreshResponse =
        serde_json::from_str(response.expose()).map_err(|_| AccountError::InvalidResponse)?;
      if !secret_43(response.refresh_token.expose())
        || equal(response.refresh_token.expose(), stored.refresh_token.expose())
        || !token(&response.custom_token)
      {
        return Err(AccountError::InvalidResponse);
      }
      stored.refresh_token = response.refresh_token;
      self.save_connection(adapters, &stored, generation, &cancel)?;
      self.sign_in(adapters, &response.custom_token, &stored, generation, &cancel, false)
    })();
    self.finish(adapters, generation, result, false)
  }
  fn finish(
    &self,
    adapters: &Adapters,
    generation: u64,
    mut result: Result<(), AccountError>,
    callback: bool,
  ) -> Result<(), AccountError> {
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    if inner.generation != generation {
      return Err(AccountError::Cancelled);
    }
    inner.cancel = None;
    if callback && adapters.store.clear(SecretKind::Pending).is_err() {
      result = Err(AccountError::Storage);
    }
    if matches!(result, Err(AccountError::Expired | AccountError::AccountUnavailable))
      && adapters.store.clear(SecretKind::RefreshToken).is_err()
    {
      result = Err(AccountError::Storage);
    }
    if callback
      && result.is_err()
      && !matches!(result, Err(AccountError::Network | AccountError::Paused))
      && adapters.store.clear(SecretKind::RefreshToken).is_err()
    {
      result = Err(AccountError::Storage);
    }
    if let Err(error) = result {
      inner.access = None;
      inner.error = Some(error);
      let recoverable = matches!(error, AccountError::Network | AccountError::Paused)
        && adapters
          .store
          .load(SecretKind::RefreshToken)
          .is_ok_and(|record| record.is_some());
      inner.phase = if recoverable {
        inner.next_attempt_ms = self.clock.now_ms()?.saturating_add(inner.retry_delay_ms);
        inner.retry_delay_ms = (inner.retry_delay_ms * 2).min(300_000);
        AccountPhase::Offline
      } else {
        inner.next_attempt_ms = u64::MAX;
        AccountPhase::Failed
      };
    }
    result
  }
  /// cold start: 有効なpendingは継続し、消費済みpendingは再送せず破棄する。
  pub fn restore(&self) -> Result<(), AccountError> {
    self.restore_inner().map_err(|error| self.preflight_error(error))
  }
  fn restore_inner(&self) -> Result<(), AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    {
      let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      if inner.cancel.is_some() {
        return Err(AccountError::Busy);
      }
      if self.pending(adapters).is_ok_and(|p| !p.consumed) {
        inner.phase = AccountPhase::Waiting;
        return Ok(());
      }
      adapters.store.clear(SecretKind::Pending)?;
      if adapters.store.load(SecretKind::RefreshToken)?.is_none() {
        inner.phase = AccountPhase::SignedOut;
        return Ok(());
      }
    }
    self.refresh()
  }
  /// 短期ID tokenは5分前にNIHO接続tokenから更新。一時失敗は1秒から最大5分のbackoff。
  pub fn maintain(&self) -> Result<(), AccountError> {
    let now = self.clock.now_ms()?;
    let due = {
      let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      inner.cancel.is_none()
        && matches!(inner.phase, AccountPhase::Connected | AccountPhase::Offline)
        && now >= inner.next_attempt_ms
    };
    if due {
      self.refresh()
    } else {
      Ok(())
    }
  }
  /// Camera専用の固定server endpointから、安全な本人session metadataだけを読む。
  pub fn photo_identity(&self) -> Result<PhotoIdentity, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    if adapters.config.client != ClientId::Camera {
      return Err(AccountError::NotConfigured);
    }
    let (generation, access, connection) = {
      let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
      let now = self.clock.now_ms()?;
      if inner.phase != AccountPhase::Connected || inner.cancel.is_some() || now >= inner.expires_at_ms {
        return Err(AccountError::Expired);
      }
      let access = inner.access.as_ref().cloned().ok_or(AccountError::Expired)?;
      let raw = adapters
        .store
        .load(SecretKind::RefreshToken)?
        .ok_or(AccountError::Expired)?;
      let connection: StoredConnection = serde_json::from_str(raw.expose()).map_err(|_| AccountError::Storage)?;
      if connection.version != SAFETY_CONTRACT_VERSION
        || connection.client != ClientId::Camera
        || !opaque_id(&connection.connection_id)
        || !opaque_id(&connection.user_id)
      {
        return Err(AccountError::Storage);
      }
      (inner.generation, access, connection)
    };

    let response = adapters.photo_session.send(&adapters.config, &access)?;
    let identity = match parse_response(
      response,
      self.clock.now_ms()?,
      &connection.user_id,
      &connection.connection_id,
    ) {
      Ok(identity) => identity,
      Err(error @ (AccountError::Expired | AccountError::AccountUnavailable)) => {
        self.invalidate_photo_identity(adapters, generation, error)?;
        return Err(error);
      }
      Err(error) => return Err(error),
    };

    let fresh_now = self.clock.now_ms()?;
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    if inner.generation != generation
      || inner.phase != AccountPhase::Connected
      || inner.cancel.is_some()
      || fresh_now >= inner.expires_at_ms
      || inner
        .access
        .as_ref()
        .is_none_or(|fresh| !equal(fresh.expose(), access.expose()))
    {
      return Err(AccountError::Cancelled);
    }
    let raw = adapters
      .store
      .load(SecretKind::RefreshToken)?
      .ok_or(AccountError::Cancelled)?;
    let fresh: StoredConnection = serde_json::from_str(raw.expose()).map_err(|_| AccountError::Storage)?;
    if fresh.version != connection.version
      || fresh.client != connection.client
      || fresh.user_id != connection.user_id
      || fresh.connection_id != connection.connection_id
    {
      return Err(AccountError::Cancelled);
    }
    inner.photo_identity_expires_at_ms = parse_strict_iso(&identity.expires_at).ok_or(AccountError::InvalidResponse)?;
    inner.photo_identity = Some(identity.clone());
    Ok(identity)
  }

  /// Camera専用の固定C00 operation。URL・headers・credentialはcallerから受け取らない。
  pub fn photo_request(
    &self,
    capture: &PhotoScopeCapture,
    request: &PhotoRequest,
  ) -> Result<PhotoJsonResponse, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let response = self.send_photo_json(adapters, &authority, request)?;
    self.ensure_photo_authority(adapters, &authority)?;
    if response.status == 401
      && response
        .body
        .get("error")
        .and_then(|value| value.get("code"))
        .and_then(|value| value.as_str())
        == Some("unauthenticated")
    {
      self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
    }
    Ok(response)
  }

  /// Native-only upload bootstrap. Ticket-bearing replies stay in Rust memory.
  #[allow(clippy::too_many_arguments)]
  pub fn photo_copy_start(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    target: &NativeCopyTarget,
    size_bytes: u64,
    sha256: &str,
    content_type: &str,
    idempotency_key: &str,
  ) -> Result<NativeStartUpload, AccountError> {
    if size_bytes == 0
      || size_bytes > 200 * 1024 * 1024
      || sha256.len() != 64
      || !sha256
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
      || match target {
        NativeCopyTarget::Original { file_name, format } => {
          file_name.is_empty()
            || file_name.len() > 255
            || file_name.contains('/')
            || file_name.contains('\\')
            || !matches!(
              (format.as_str(), content_type),
              ("jpeg", "image/jpeg") | ("png", "image/png")
            )
        }
        NativeCopyTarget::Mask { photo_id } => {
          photo_id.is_empty() || size_bytes > 8 * 1024 * 1024 || content_type != "image/png"
        }
      }
    {
      return Err(AccountError::InvalidResponse);
    }
    let body = match target {
      NativeCopyTarget::Original { file_name, format } => serde_json::json!({
        "target": { "kind": "original", "fileName": file_name, "format": format },
        "sizeBytes": size_bytes, "sha256": sha256, "contentType": content_type,
      }),
      NativeCopyTarget::Mask { photo_id } => serde_json::json!({
        "target": { "kind": "mask", "photoId": photo_id },
        "sizeBytes": size_bytes, "sha256": sha256, "contentType": content_type,
      }),
    };
    let bytes = serde_json::to_vec(&body).map_err(|_| AccountError::Internal)?;
    if bytes.len() > 64 * 1024 {
      return Err(AccountError::InvalidResponse);
    }
    let value = self.send_native_copy(
      capture,
      library_id,
      "POST",
      &["uploads"],
      Some(bytes),
      Some(idempotency_key.to_owned()),
    )?;
    let result = parse_start_upload(&value, library_id, content_type)?;
    if let NativeStartUpload::Upload {
      ticket: Some(ticket), ..
    } = &result
    {
      self.validate_live_ticket(ticket)?;
    }
    Ok(result)
  }

  pub fn photo_copy_get(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    upload_id: &str,
  ) -> Result<NativeUpload, AccountError> {
    let value = self.send_native_copy(capture, library_id, "GET", &["uploads", upload_id], None, None)?;
    parse_upload(&value, library_id)
  }

  pub fn photo_copy_renew(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    upload_id: &str,
    content_type: &str,
  ) -> Result<(NativeUpload, NativeUploadTicket), AccountError> {
    let value = self.send_native_copy(
      capture,
      library_id,
      "POST",
      &["uploads", upload_id, "renew"],
      Some(b"{}".to_vec()),
      None,
    )?;
    let result = parse_renew_upload(&value, library_id, content_type)?;
    self.validate_live_ticket(&result.1)?;
    Ok(result)
  }

  pub fn photo_copy_complete(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    upload_id: &str,
    idempotency_key: &str,
  ) -> Result<NativeUpload, AccountError> {
    let value = self.send_native_copy(
      capture,
      library_id,
      "POST",
      &["uploads", upload_id, "complete"],
      Some(b"{}".to_vec()),
      Some(idempotency_key.to_owned()),
    )?;
    parse_upload_receipt(&value, library_id)
  }

  pub fn photo_copy_cancel(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    upload_id: &str,
    idempotency_key: &str,
  ) -> Result<NativeUpload, AccountError> {
    let value = self.send_native_copy(
      capture,
      library_id,
      "POST",
      &["uploads", upload_id, "cancel"],
      Some(b"{}".to_vec()),
      Some(idempotency_key.to_owned()),
    )?;
    parse_upload_receipt(&value, library_id)
  }

  pub fn photo_copy_mask_get(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    photo_id: &str,
    surface_id: &str,
  ) -> Result<serde_json::Value, AccountError> {
    let value = self.send_native_copy(
      capture,
      library_id,
      "GET",
      &["photos", photo_id, "masks", surface_id],
      None,
      None,
    )?;
    crate::photo_cloud::validate_native_mask_asset(&value)?;
    Ok(value)
  }

  pub fn photo_copy_put(
    &self,
    capture: &PhotoScopeCapture,
    ticket: &NativeUploadTicket,
    offset: u64,
    total: u64,
    body: &[u8],
  ) -> Result<NativeProviderAck, AccountError> {
    self.validate_live_ticket(ticket)?;
    if total != ticket.size_bytes
      || ticket.resume_offset_bytes != offset
      || body.is_empty()
      || body.len() > 8 * 1024 * 1024
      || offset.checked_add(body.len() as u64).is_none_or(|end| end > total)
    {
      return Err(AccountError::InvalidResponse);
    }
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let response = adapters
      .photo_http
      .provider_put(&ticket.url, &ticket.content_type, offset, total, body)?;
    self.ensure_photo_authority(adapters, &authority)?;
    provider_ack(response, offset, body.len() as u64, total)
  }

  pub fn photo_copy_probe(
    &self,
    capture: &PhotoScopeCapture,
    ticket: &NativeUploadTicket,
    total: u64,
  ) -> Result<NativeProviderAck, AccountError> {
    self.validate_live_ticket(ticket)?;
    if total != ticket.size_bytes {
      return Err(AccountError::InvalidResponse);
    }
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let response = adapters
      .photo_http
      .provider_probe(&ticket.url, &ticket.content_type, total)?;
    self.ensure_photo_authority(adapters, &authority)?;
    let acknowledgement = provider_ack(response, 0, total, total)?;
    if acknowledgement.next_offset < ticket.resume_offset_bytes {
      return Err(AccountError::InvalidResponse);
    }
    Ok(acknowledgement)
  }

  fn send_native_copy(
    &self,
    capture: &PhotoScopeCapture,
    library_id: &str,
    method: &'static str,
    suffix: &[&str],
    body: Option<Vec<u8>>,
    idempotency_key: Option<String>,
  ) -> Result<serde_json::Value, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let request = native_copy_request(
      &adapters.config,
      &authority.scope,
      method,
      suffix,
      body,
      idempotency_key,
    )?;
    let response = adapters
      .photo_http
      .send(&adapters.config, &authority.access, &request, false)?;
    let value = match read_native_upload_response(response, library_id) {
      Ok(value) => value,
      Err(AccountError::Expired) => {
        self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
        return Err(AccountError::Expired);
      }
      Err(error) => return Err(error),
    };
    self.ensure_photo_authority(adapters, &authority)?;
    Ok(value)
  }

  fn validate_live_ticket(&self, ticket: &NativeUploadTicket) -> Result<(), AccountError> {
    let expires = parse_strict_iso(&ticket.expires_at).ok_or(AccountError::InvalidResponse)?;
    if expires <= self.clock.now_ms()?
      || !crate::photo_cloud::trusted_upload_url(&ticket.url)
      || !matches!(ticket.content_type.as_str(), "image/jpeg" | "image/png")
    {
      return Err(AccountError::Expired);
    }
    Ok(())
  }

  pub fn photo_scope_current(&self, capture: &PhotoScopeCapture) -> Result<(), AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    self.capture_photo_authority(adapters, capture).map(|_| ())
  }

  /// Cache bytes may cross IPC only when the same native authority is current both before and after the file read.
  pub fn photo_content_read_guarded(
    &self,
    capture: &PhotoScopeCapture,
    read: impl FnOnce() -> Result<Vec<u8>, AccountError>,
  ) -> Result<Vec<u8>, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let value = read()?;
    self.ensure_photo_authority(adapters, &authority)?;
    Ok(value)
  }

  pub fn photo_content_metadata(
    &self,
    capture: &PhotoScopeCapture,
    photo_id: &str,
    asset_id: &str,
  ) -> Result<PhotoContentMetadata, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let get = PhotoRequest::parse(
      PhotoOperation::PhotosGet,
      serde_json::json!({ "photoId": photo_id }),
      None,
    )?;
    let photo = self.send_photo_json(adapters, &authority, &get)?;
    if photo.status == 401 {
      self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
      return Err(AccountError::Expired);
    }
    if photo.status != 200 {
      return Err(AccountError::Rejected);
    }
    original_metadata(&photo.body, photo_id, asset_id)
  }

  /// 実STORED originalをfresh Photo metadataへ束縛し、全bytes/SHA/EOF検証しながらnative writerへ流す。
  pub fn photo_content_download<W: Write>(
    &self,
    capture: &PhotoScopeCapture,
    expected: &PhotoContentMetadata,
    writer: &mut W,
    cancel: &PhotoDownloadCancel,
  ) -> Result<PhotoContentMetadata, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let get = PhotoRequest::parse(
      PhotoOperation::PhotosGet,
      serde_json::json!({ "photoId": expected.photo_id }),
      None,
    )?;
    let photo = self.send_photo_json(adapters, &authority, &get)?;
    if photo.status == 401 {
      self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
      return Err(AccountError::Expired);
    }
    if photo.status != 200 {
      return Err(AccountError::Rejected);
    }
    let metadata = original_metadata(&photo.body, &expected.photo_id, &expected.asset_id)?;
    if &metadata != expected {
      return Err(AccountError::InvalidResponse);
    }
    self.ensure_photo_authority(adapters, &authority)?;
    cancel.check()?;
    let request = content_request(
      &adapters.config,
      &authority.scope,
      &expected.photo_id,
      &expected.asset_id,
    );
    let response = adapters
      .photo_http
      .send(&adapters.config, &authority.access, &request, true)?;
    if response.status == 401 {
      self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
      return Err(AccountError::Expired);
    }
    stream_verified_content(response, expected, writer, cancel, || {
      self.ensure_photo_authority(adapters, &authority)
    })?;
    self.ensure_photo_authority(adapters, &authority)?;
    Ok(metadata)
  }

  /// Native Save As専用。fresh Photoからoriginal IDをnative内で解決し、検証済み全bytesだけをwriterへ渡す。
  pub fn photo_original_download<W: Write>(
    &self,
    capture: &PhotoScopeCapture,
    photo_id: &str,
    writer: &mut W,
    cancel: &PhotoDownloadCancel,
  ) -> Result<(PhotoContentMetadata, String), AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let authority = self.capture_photo_authority(adapters, capture)?;
    let get = PhotoRequest::parse(
      PhotoOperation::PhotosGet,
      serde_json::json!({ "photoId": photo_id }),
      None,
    )?;
    let photo = self.send_photo_json(adapters, &authority, &get)?;
    if photo.status == 401 {
      self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
      return Err(AccountError::Expired);
    }
    if photo.status != 200 {
      return Err(AccountError::Rejected);
    }
    let (metadata, file_name) = original_metadata_for_photo(&photo.body, photo_id)?;
    self.ensure_photo_authority(adapters, &authority)?;
    cancel.check()?;
    let request = content_request(&adapters.config, &authority.scope, photo_id, &metadata.asset_id);
    let response = adapters
      .photo_http
      .send(&adapters.config, &authority.access, &request, true)?;
    if response.status == 401 {
      self.invalidate_photo_identity(adapters, authority.generation, AccountError::Expired)?;
      return Err(AccountError::Expired);
    }
    stream_verified_content(response, &metadata, writer, cancel, || {
      self.ensure_photo_authority(adapters, &authority)
    })?;
    self.ensure_photo_authority(adapters, &authority)?;
    Ok((metadata, file_name))
  }

  fn send_photo_json(
    &self,
    adapters: &Adapters,
    authority: &CapturedPhotoAuthority,
    request: &PhotoRequest,
  ) -> Result<PhotoJsonResponse, AccountError> {
    self.ensure_photo_authority(adapters, authority)?;
    let native = native_request(&adapters.config, &authority.scope, request);
    let response = adapters
      .photo_http
      .send(&adapters.config, &authority.access, &native, false)?;
    let response = read_json_response(response, request.operation())?;
    self.ensure_photo_authority(adapters, authority)?;
    Ok(response)
  }

  fn capture_photo_authority(
    &self,
    adapters: &Adapters,
    capture: &PhotoScopeCapture,
  ) -> Result<CapturedPhotoAuthority, AccountError> {
    if adapters.config.client != ClientId::Camera
      || capture.transport != crate::PhotoIdentityTransport::MacBearer
      || !opaque_id(&capture.user_id)
      || !opaque_id(&capture.session_id)
      || !opaque_id(&capture.session_epoch)
    {
      return Err(AccountError::Rejected);
    }
    let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    let now = self.clock.now_ms()?;
    if inner.phase != AccountPhase::Connected
      || inner.cancel.is_some()
      || now >= inner.expires_at_ms
      || now >= inner.photo_identity_expires_at_ms
    {
      return Err(AccountError::Expired);
    }
    let identity = inner.photo_identity.as_ref().ok_or(AccountError::Expired)?;
    if identity.user_id != capture.user_id
      || identity.session_id != capture.session_id
      || identity.session_epoch != capture.session_epoch
      || identity.transport != capture.transport
    {
      return Err(AccountError::Rejected);
    }
    let access = inner.access.as_ref().cloned().ok_or(AccountError::Expired)?;
    let raw = adapters
      .store
      .load(SecretKind::RefreshToken)?
      .ok_or(AccountError::Expired)?;
    let connection: StoredConnection = serde_json::from_str(raw.expose()).map_err(|_| AccountError::Storage)?;
    if connection.version != SAFETY_CONTRACT_VERSION
      || connection.client != ClientId::Camera
      || !opaque_id(&connection.connection_id)
      || !opaque_id(&connection.user_id)
      || connection.user_id != capture.user_id
      || connection.connection_id != capture.session_id
    {
      return Err(AccountError::Rejected);
    }
    Ok(CapturedPhotoAuthority {
      generation: inner.generation,
      access,
      connection_id: connection.connection_id,
      user_id: connection.user_id,
      scope: capture.clone(),
    })
  }

  /// Runs a short native commit under the same lock as logout, refresh and
  /// session revocation. The callback must not call back into this Account.
  pub fn with_current_photo_scope<T>(
    &self,
    capture: &PhotoScopeCapture,
    commit: impl FnOnce() -> Result<T, AccountError>,
  ) -> Result<T, AccountError> {
    let adapters = self.adapters.as_ref().ok_or(AccountError::NotConfigured)?;
    let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    let now = self.clock.now_ms()?;
    if adapters.config.client != ClientId::Camera
      || inner.phase != AccountPhase::Connected
      || inner.cancel.is_some()
      || inner.access.is_none()
      || now >= inner.expires_at_ms
      || now >= inner.photo_identity_expires_at_ms
      || inner.photo_identity.as_ref().is_none_or(|identity| {
        identity.user_id != capture.user_id
          || identity.session_id != capture.session_id
          || identity.session_epoch != capture.session_epoch
          || identity.transport != capture.transport
      })
    {
      return Err(AccountError::Cancelled);
    }
    let result = commit();
    drop(inner);
    result
  }

  fn ensure_photo_authority(
    &self,
    adapters: &Adapters,
    authority: &CapturedPhotoAuthority,
  ) -> Result<(), AccountError> {
    let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    let now = self.clock.now_ms()?;
    if inner.generation != authority.generation
      || inner.phase != AccountPhase::Connected
      || inner.cancel.is_some()
      || now >= inner.expires_at_ms
      || now >= inner.photo_identity_expires_at_ms
      || inner.photo_identity.as_ref().is_none_or(|identity| {
        identity.user_id != authority.scope.user_id
          || identity.session_id != authority.scope.session_id
          || identity.session_epoch != authority.scope.session_epoch
          || identity.transport != authority.scope.transport
      })
      || inner
        .access
        .as_ref()
        .is_none_or(|fresh| !equal(fresh.expose(), authority.access.expose()))
    {
      return Err(AccountError::Cancelled);
    }
    let raw = adapters
      .store
      .load(SecretKind::RefreshToken)?
      .ok_or(AccountError::Cancelled)?;
    let fresh: StoredConnection = serde_json::from_str(raw.expose()).map_err(|_| AccountError::Storage)?;
    if fresh.client != ClientId::Camera
      || fresh.connection_id != authority.connection_id
      || fresh.user_id != authority.user_id
      || authority.scope.user_id != fresh.user_id
      || authority.scope.session_id != fresh.connection_id
    {
      return Err(AccountError::Cancelled);
    }
    Ok(())
  }

  fn invalidate_photo_identity(
    &self,
    adapters: &Adapters,
    generation: u64,
    error: AccountError,
  ) -> Result<(), AccountError> {
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    if inner.generation != generation {
      return Err(AccountError::Cancelled);
    }
    inner.generation = inner.generation.checked_add(1).ok_or(AccountError::Internal)?;
    inner.access = None;
    inner.photo_identity = None;
    inner.photo_identity_expires_at_ms = 0;
    inner.cancel = None;
    inner.next_attempt_ms = u64::MAX;
    inner.phase = AccountPhase::Failed;
    inner.error = Some(error);
    adapters.store.clear(SecretKind::RefreshToken)?;
    Ok(())
  }
  pub fn cancel(&self) -> Result<(), AccountError> {
    self.cancel_inner().map_err(|error| self.preflight_error(error))
  }
  fn cancel_inner(&self) -> Result<(), AccountError> {
    let Some(adapters) = &self.adapters else {
      return Ok(());
    };
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    if let Some(cancel) = inner.cancel.take() {
      cancel.cancel();
    }
    inner.generation = inner.generation.checked_add(1).ok_or(AccountError::Internal)?;
    adapters.store.clear(SecretKind::Pending)?;
    let refreshing = inner.phase == AccountPhase::Refreshing;
    if inner.phase == AccountPhase::Waiting {
      adapters.store.clear(SecretKind::RefreshToken)?;
    }
    inner.next_attempt_ms = u64::MAX;
    inner.phase = if refreshing {
      AccountPhase::Offline
    } else {
      AccountPhase::SignedOut
    };
    inner.error = Some(AccountError::Cancelled);
    inner.access = None;
    inner.photo_identity = None;
    inner.photo_identity_expires_at_ms = 0;
    Ok(())
  }
  /// このMacの資格を削除する。server側の全接続失効を意味しない。
  pub fn logout(&self) -> Result<(), AccountError> {
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    let cleanup = self.adapters.as_ref().and_then(|adapters| {
      let id_token = inner.access.as_ref()?.clone();
      let raw = adapters.store.load(SecretKind::RefreshToken).ok()??;
      let connection: StoredConnection = serde_json::from_str(raw.expose()).ok()?;
      opaque_id(&connection.connection_id).then_some((id_token, connection.connection_id))
    });
    if let Some(cancel) = inner.cancel.take() {
      cancel.cancel();
    }
    inner.generation = inner.generation.checked_add(1).ok_or(AccountError::Internal)?;
    inner.access = None;
    inner.photo_identity = None;
    inner.photo_identity_expires_at_ms = 0;
    if let Some(adapters) = &self.adapters {
      if adapters
        .store
        .clear(SecretKind::Pending)
        .and_then(|_| adapters.store.clear(SecretKind::RefreshToken))
        .is_err()
      {
        inner.phase = AccountPhase::Failed;
        inner.error = Some(AccountError::Storage);
        return Err(AccountError::Storage);
      }
    }
    inner.phase = if self.adapters.is_some() {
      AccountPhase::SignedOut
    } else {
      AccountPhase::LocalOnly
    };
    inner.error = None;
    drop(inner);
    if let (Some(adapters), Some((id_token, connection_id))) = (&self.adapters, cleanup) {
      self.cleanup_connection(adapters, &id_token, &connection_id);
    }
    Ok(())
  }
}
