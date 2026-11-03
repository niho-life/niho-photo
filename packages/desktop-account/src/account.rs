use crate::connect::{equal, secret_43, Pending};
use crate::photo_session::{parse_response, HttpPhotoSession, PhotoSessionTransport};
use crate::{
  AccountError, Browser, Cancel, ClientId, Config, CredentialStore, ExternalBrowser, HttpTransport, PhotoIdentity,
  Request, Response, Secret, SecretKind, Transport, SAFETY_CONTRACT_VERSION,
};
use serde::{Deserialize, Serialize};
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

    let response = match adapters.photo_session.send(&adapters.config, &access) {
      Ok(response) => response,
      Err(error) => return Err(error),
    };
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
    let inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
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
    Ok(identity)
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
