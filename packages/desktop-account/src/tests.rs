use super::*;
use crate::account::Clock;
use crate::connect::{Pending, PENDING_TTL_MS};
use crate::photo_cloud::{NativePhotoRequest, PhotoHttpResponse, PhotoHttpTransport, ProviderResponse};
use crate::photo_session::{PhotoSessionResponse, PhotoSessionTransport};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::{
  atomic::{AtomicBool, AtomicU64, Ordering},
  Arc, Mutex,
};
use std::time::{Duration, Instant};
use url::Url;

#[derive(Default)]
struct MemoryStore {
  entries: Mutex<BTreeMap<&'static str, Secret>>,
  fail_pending: AtomicBool,
  fail_refresh: AtomicBool,
}
impl CredentialStore for MemoryStore {
  fn load(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    Ok(self.entries.lock().unwrap().get(kind.name()).cloned())
  }
  fn save(&self, kind: SecretKind, value: &Secret) -> Result<(), AccountError> {
    if (matches!(kind, SecretKind::Pending) && self.fail_pending.load(Ordering::SeqCst))
      || (matches!(kind, SecretKind::RefreshToken) && self.fail_refresh.load(Ordering::SeqCst))
    {
      return Err(AccountError::Storage);
    }
    self.entries.lock().unwrap().insert(kind.name(), value.clone());
    Ok(())
  }
  fn clear(&self, kind: SecretKind) -> Result<(), AccountError> {
    self.entries.lock().unwrap().remove(kind.name());
    Ok(())
  }
}
#[derive(Default)]
struct CaptureBrowser(Mutex<Option<Secret>>);
impl Browser for CaptureBrowser {
  fn open(&self, url: &Secret) -> Result<(), AccountError> {
    *self.0.lock().unwrap() = Some(url.clone());
    Ok(())
  }
}
struct TestClock(AtomicU64);
impl Clock for TestClock {
  fn now_ms(&self) -> Result<u64, AccountError> {
    Ok(self.0.load(Ordering::SeqCst))
  }
}
#[derive(Default)]
struct ServerState {
  calls: Vec<String>,
  refresh_count: u8,
  exchanged: bool,
  error: Option<(String, u16, &'static str)>,
  wrong_user: bool,
  accept_previous_refresh: bool,
}
struct MockServer {
  state: Mutex<ServerState>,
  store: Arc<MemoryStore>,
  browser: Arc<CaptureBrowser>,
}
fn connection_token(index: u8) -> String {
  char::from(b'a' + index).to_string().repeat(43)
}
impl Transport for MockServer {
  fn send(&self, config: &Config, request: &Request, _: &Cancel) -> Result<Response, AccountError> {
    let url = Url::parse(request.url.expose()).unwrap();
    let path = url.path().to_string();
    let body: Value = request
      .body
      .as_ref()
      .map(|v| serde_json::from_str(v.expose()).unwrap())
      .unwrap_or(Value::Null);
    let mut state = self.state.lock().unwrap();
    state.calls.push(path.clone());
    if let Some((failed_path, status, reason)) = &state.error {
      if *failed_path == path {
        return Ok(Response {
          status: *status,
          body: Secret::new(
            json!({"code":"UNAUTHORIZED","details":{"reason":reason},"message":"synthetic-sensitive-server-body"})
              .to_string(),
          ),
        });
      }
    }
    let value = match path.as_str() {
      "/api/auth/app-connect/exchange" => {
        assert_eq!(request.method, "POST");
        assert!(request.bearer.is_none());
        assert_eq!(body.as_object().unwrap().len(), 4);
        assert_eq!(body["clientId"], "niho-camera");
        assert_eq!(body["deviceName"], "Mac");
        let browser = self.browser.0.lock().unwrap();
        let browser_url = Url::parse(browser.as_ref().unwrap().expose()).unwrap();
        let params: BTreeMap<_, _> = browser_url.query_pairs().collect();
        assert_eq!(params["v"], "1");
        assert_eq!(browser_url.path(), "/connect/niho-camera");
        assert!(
          params["challenge"]
            == URL_SAFE_NO_PAD.encode(Sha256::digest(body["codeVerifier"].as_str().unwrap().as_bytes()))
        );
        assert!(body["code"].as_str().unwrap() == "C".repeat(43));
        assert!(!state.exchanged);
        state.exchanged = true;
        let stored = self.store.load(SecretKind::Pending)?.unwrap();
        let pending: Pending = serde_json::from_str(stored.expose()).unwrap();
        assert!(pending.consumed);
        json!({"customToken":"synthetic-custom-token", "refreshToken":connection_token(0), "connectionId":"synthetic-connection", "user":{"id":"synthetic-user"}})
      }
      "/api/auth/app-connect/refresh" => {
        assert_eq!(request.method, "POST");
        assert_eq!(body["clientId"], "niho-camera");
        let supplied = body["refreshToken"].as_str().unwrap();
        let current = supplied == connection_token(state.refresh_count);
        let previous = state.accept_previous_refresh
          && state.refresh_count > 0
          && supplied == connection_token(state.refresh_count - 1);
        if !(current || previous) {
          return Ok(Response {
            status: 401,
            body: Secret::new(json!({"details":{"reason":"app_connection_revoked"}}).to_string()),
          });
        }
        assert!(body.get("grant_type").is_none());
        state.refresh_count += 1;
        json!({"customToken":"synthetic-custom-token", "refreshToken":connection_token(state.refresh_count)})
      }
      "/v1/accounts:signInWithCustomToken" => {
        assert_eq!(request.method, "POST");
        assert_eq!(url.query_pairs().next().unwrap().0, "key");
        assert_eq!(body["token"], "synthetic-custom-token");
        assert_eq!(body["returnSecureToken"], true);
        let stored = self.store.load(SecretKind::RefreshToken)?.unwrap();
        let stored: Value = serde_json::from_str(stored.expose()).unwrap();
        // rotationはFirebase交換より前に保存されている。
        assert!(stored["refreshToken"].as_str().unwrap() == connection_token(state.refresh_count));
        json!({"idToken":"synthetic-id-token", "expiresIn":"3600", "refreshToken":"firebase-refresh-must-be-discarded"})
      }
      "/api/auth/me" => {
        assert_eq!(request.method, "GET");
        assert!(request.body.is_none());
        assert!(request.bearer.as_ref().unwrap().expose() == "synthetic-id-token");
        assert!(url.query().is_none());
        json!({"user":{"id":if state.wrong_user {"other-user"} else {"synthetic-user"},"role":"admin","tenant":"untrusted-claim"}})
      }
      "/api/auth/app-connections/synthetic-connection" => {
        assert_eq!(request.method, "DELETE");
        assert!(request.bearer.is_some());
        return Ok(Response {
          status: 204,
          body: Secret::new(""),
        });
      }
      _ => panic!("unexpected public endpoint"),
    };
    let _ = config;
    Ok(Response {
      status: 200,
      body: Secret::new(value.to_string()),
    })
  }
}
struct Fixture {
  account: Arc<Account>,
  store: Arc<MemoryStore>,
  browser: Arc<CaptureBrowser>,
  server: Arc<MockServer>,
  clock: Arc<TestClock>,
  config: Config,
}
impl Fixture {
  fn new() -> Self {
    Self::with_photo_session(Arc::new(StaticPhotoSession::valid()))
  }
  fn with_photo_session(photo_session: Arc<dyn PhotoSessionTransport>) -> Self {
    let config = Config::mock("http://127.0.0.1:12345");
    let store = Arc::new(MemoryStore::default());
    let browser = Arc::new(CaptureBrowser::default());
    let clock = Arc::new(TestClock(AtomicU64::new(1_000_000)));
    let server = Arc::new(MockServer {
      state: Mutex::new(ServerState::default()),
      store: store.clone(),
      browser: browser.clone(),
    });
    let account = Arc::new(
      Account::with_adapters(config.clone(), store.clone(), browser.clone(), server.clone())
        .with_photo_session(photo_session)
        .with_clock(clock.clone()),
    );
    Self {
      account,
      store,
      browser,
      server,
      clock,
      config,
    }
  }
  fn with_photo_http(photo_http: Arc<dyn PhotoHttpTransport>) -> Self {
    let config = Config::mock("http://127.0.0.1:12345");
    let store = Arc::new(MemoryStore::default());
    let browser = Arc::new(CaptureBrowser::default());
    let clock = Arc::new(TestClock(AtomicU64::new(1_000_000)));
    let server = Arc::new(MockServer {
      state: Mutex::new(ServerState::default()),
      store: store.clone(),
      browser: browser.clone(),
    });
    let account = Arc::new(
      Account::with_adapters(config.clone(), store.clone(), browser.clone(), server.clone())
        .with_photo_session(Arc::new(StaticPhotoSession::valid()))
        .with_photo_http(photo_http)
        .with_clock(clock.clone()),
    );
    Self {
      account,
      store,
      browser,
      server,
      clock,
      config,
    }
  }
  fn callback(&self) -> Secret {
    let browser = self.browser.0.lock().unwrap();
    let browser = Url::parse(browser.as_ref().unwrap().expose()).unwrap();
    let state = browser
      .query_pairs()
      .find(|(key, _)| key == "state")
      .unwrap()
      .1
      .into_owned();
    Secret::new(format!("niho-camera://auth?code={}&state={state}", "C".repeat(43)))
  }
  fn login(&self) {
    self.account.login().unwrap();
    self.account.handle_callback(&self.callback()).unwrap();
  }
}

struct StaticPhotoSession {
  status: u16,
  body: String,
  calls: AtomicU64,
}
impl StaticPhotoSession {
  fn valid() -> Self {
    Self::new(200, valid_photo_identity())
  }
  fn new(status: u16, body: Value) -> Self {
    Self {
      status,
      body: body.to_string(),
      calls: AtomicU64::new(0),
    }
  }
}
impl PhotoSessionTransport for StaticPhotoSession {
  fn send(&self, config: &Config, bearer: &Secret) -> Result<PhotoSessionResponse, AccountError> {
    assert_eq!(config.client, ClientId::Camera);
    assert_eq!(
      config.api_url("/api/auth/photo-connect/mac-session").path(),
      "/api/auth/photo-connect/mac-session"
    );
    assert_eq!(bearer.expose(), "synthetic-id-token");
    self.calls.fetch_add(1, Ordering::SeqCst);
    Ok(PhotoSessionResponse {
      status: self.status,
      body: Secret::new(self.body.clone()),
    })
  }
}

fn valid_photo_identity() -> Value {
  json!({
    "actor": { "id": "synthetic-user" },
    "sessionId": "synthetic-connection",
    "sessionEpoch": "synthetic-epoch",
    "expiresAt": "1970-01-01T01:00:00.000Z",
    "clientId": "niho-camera",
    "audience": "niho-photo",
    "refreshRequired": false
  })
}
#[test]
fn real_contract_config_is_fixed_https_and_public_key_is_not_a_client_secret() {
  let config = Config::production(ClientId::Camera, "synthetic-public-web-key").unwrap();
  let pending = Pending::new(ClientId::Camera, 1).unwrap();
  let url = Url::parse(config.connect_url(&pending).expose()).unwrap();
  assert_eq!(url.origin().ascii_serialization(), "https://niho.life");
  assert_eq!(url.path(), "/connect/niho-camera");
  assert!(!url.as_str().contains(pending.verifier.expose()));
  assert!(!url.as_str().contains("client_secret"));
  assert_eq!(config.identity_url().host_str(), Some("identitytoolkit.googleapis.com"));
  assert!(Config::production(ClientId::Camera, "").is_err());
  assert!(Config::production(ClientId::Camera, "key?redirect=other").is_err());
  assert!(!format!("{config:?}").contains("synthetic-public-web-key"));
}
#[test]
fn pkce_vector_and_separate_state_have_the_registered_shape() {
  let mut pending = Pending::new(ClientId::Camera, 1).unwrap();
  pending.verifier = Secret::new("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  let config = Config::production(ClientId::Camera, "public-key").unwrap();
  let url = Url::parse(config.connect_url(&pending).expose()).unwrap();
  assert_eq!(
    url.query_pairs().find(|(key, _)| key == "challenge").unwrap().1,
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
  assert_eq!(pending.state.expose().len(), 43);
  assert!(!equal(&pending.state, &pending.verifier));
  assert_eq!(format!("{pending:?}"), "Pending([REDACTED])");
}
fn equal(a: &Secret, b: &Secret) -> bool {
  a.expose() == b.expose()
}
#[test]
fn callbacks_reject_noncanonical_redirects_duplicate_unknown_fields_and_malformed_secrets() {
  let good = format!("niho-camera://auth?code={}&state={}", "C".repeat(43), "S".repeat(43));
  assert!(parse_callback(ClientId::Camera, &Secret::new(&good)).is_ok());
  for invalid in [
    good.replace("niho-camera", "niho-docs"),
    good.replace("://auth?", "://auth/?"),
    good.replace("://auth?", ":///auth?"),
    good.replace("://auth?", ":auth?"),
    good.replace("://auth?", "://auth:80?"),
    good.replace("://auth?", "://other?"),
    format!("{good}&state=second"),
    format!("{good}&code=second"),
    format!("{good}&unknown=1"),
    format!("{good}#fragment"),
    good.replace("code=", "code=short"),
  ] {
    assert_eq!(
      parse_callback(ClientId::Camera, &Secret::new(invalid)).unwrap_err(),
      AccountError::InvalidRedirect
    );
  }
}
#[test]
fn sign_in_refresh_and_me_follow_the_real_public_contract_without_exposing_claims() {
  let f = Fixture::new();
  f.login();
  assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
  f.account.refresh().unwrap();
  let state = f.server.state.lock().unwrap();
  assert_eq!(
    state.calls,
    [
      "/api/auth/app-connect/exchange",
      "/v1/accounts:signInWithCustomToken",
      "/api/auth/me",
      "/api/auth/app-connect/refresh",
      "/v1/accounts:signInWithCustomToken",
      "/api/auth/me"
    ]
  );
  drop(state);
  let view = serde_json::to_string(&f.account.snapshot()).unwrap();
  for forbidden in ["token", "admin", "tenant", "synthetic-user"] {
    assert!(!view.contains(forbidden));
  }
  let saved = f.store.load(SecretKind::RefreshToken).unwrap().unwrap();
  assert!(!saved.expose().contains("firebase-refresh"));
  assert!(!saved.expose().contains("synthetic-id-token"));
  assert!(!saved.expose().contains("synthetic-custom-token"));
  f.account.logout().unwrap();
  assert_eq!(
    f.server.state.lock().unwrap().calls.last().map(String::as_str),
    Some("/api/auth/app-connections/synthetic-connection")
  );
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
}
#[test]
fn wrong_state_does_not_consume_the_good_attempt_and_callback_is_single_use() {
  let f = Fixture::new();
  f.account.login().unwrap();
  let callback = f.callback();
  let url = Url::parse(callback.expose()).unwrap();
  let state = url
    .query_pairs()
    .find(|(key, _)| key == "state")
    .unwrap()
    .1
    .into_owned();
  assert_eq!(
    f.account
      .handle_callback(&Secret::new(callback.expose().replace(&state, &"Z".repeat(43))))
      .unwrap_err(),
    AccountError::InvalidState
  );
  assert!(f.server.state.lock().unwrap().calls.is_empty());
  f.account.handle_callback(&callback).unwrap();
  let calls = f.server.state.lock().unwrap().calls.len();
  assert!(f.account.handle_callback(&callback).is_err());
  assert_eq!(f.server.state.lock().unwrap().calls.len(), calls);
}
#[test]
fn pending_survives_restart_expires_and_never_replays_consumed_codes() {
  let f = Fixture::new();
  f.account.login().unwrap();
  let callback = f.callback();
  let restored = Account::with_adapters(f.config.clone(), f.store.clone(), f.browser.clone(), f.server.clone())
    .with_clock(f.clock.clone());
  restored.restore().unwrap();
  assert_eq!(restored.snapshot().phase, AccountPhase::Waiting);
  restored.handle_callback(&callback).unwrap();
  let f = Fixture::new();
  f.account.login().unwrap();
  let raw = f.store.load(SecretKind::Pending).unwrap().unwrap();
  let mut pending: Pending = serde_json::from_str(raw.expose()).unwrap();
  pending.consumed = true;
  f.store.save(SecretKind::Pending, &pending.encode().unwrap()).unwrap();
  f.account.restore().unwrap();
  assert!(f.account.handle_callback(&f.callback()).is_err());
  assert!(f.server.state.lock().unwrap().calls.is_empty());
  let f = Fixture::new();
  f.account.login().unwrap();
  f.clock.0.fetch_add(PENDING_TTL_MS, Ordering::SeqCst);
  assert_eq!(
    f.account.handle_callback(&f.callback()).unwrap_err(),
    AccountError::Expired
  );
  assert_eq!(f.account.snapshot().error, Some(AccountError::Expired));
  assert!(f.account.snapshot().local_editing_available);
}
#[test]
fn refresh_rotation_is_saved_before_identity_failure_and_recovered_from_store() {
  let f = Fixture::new();
  f.login();
  f.server.state.lock().unwrap().error = Some(("/v1/accounts:signInWithCustomToken".into(), 500, "temporary"));
  assert_eq!(f.account.refresh().unwrap_err(), AccountError::Network);
  assert_eq!(f.account.snapshot().phase, AccountPhase::Offline);
  let saved = f.store.load(SecretKind::RefreshToken).unwrap().unwrap();
  assert!(saved.expose().contains(&connection_token(1)));
  f.server.state.lock().unwrap().error = None;
  f.account.restore().unwrap();
  assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
}
#[test]
fn pause_preserves_connection_but_revocation_expiry_and_deleted_account_fail_closed() {
  for (status, reason, expected, retained) in [
    (404, "app_connect_disabled", AccountError::Paused, true),
    (503, "unavailable", AccountError::Network, true),
    (401, "app_connection_revoked", AccountError::Expired, false),
    (401, "session_revoked", AccountError::Expired, false),
    (403, "firebase_user_disabled", AccountError::AccountUnavailable, false),
  ] {
    let f = Fixture::new();
    f.login();
    f.server.state.lock().unwrap().error = Some(("/api/auth/app-connect/refresh".into(), status, reason));
    assert_eq!(f.account.refresh().unwrap_err(), expected);
    assert_eq!(f.store.load(SecretKind::RefreshToken).unwrap().is_some(), retained);
    assert!(f.account.snapshot().local_editing_available);
    assert!(!format!("{:?}", f.account.snapshot()).contains("sensitive"));
  }
}
#[test]
fn me_rejection_or_identity_mismatch_never_produces_connected_state() {
  let f = Fixture::new();
  f.server.state.lock().unwrap().wrong_user = true;
  f.account.login().unwrap();
  assert_eq!(
    f.account.handle_callback(&f.callback()).unwrap_err(),
    AccountError::InvalidResponse
  );
  assert_eq!(f.account.snapshot().phase, AccountPhase::Failed);
  let f = Fixture::new();
  f.server.state.lock().unwrap().error = Some(("/api/auth/me".into(), 401, "app_connection_revoked"));
  f.account.login().unwrap();
  assert_eq!(
    f.account.handle_callback(&f.callback()).unwrap_err(),
    AccountError::Expired
  );
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
}
#[test]
fn pending_and_rotation_store_failures_are_not_login_successes() {
  let f = Fixture::new();
  f.store.fail_pending.store(true, Ordering::SeqCst);
  assert_eq!(f.account.login().unwrap_err(), AccountError::Storage);
  assert_eq!(f.account.snapshot().error, Some(AccountError::Storage));
  assert!(f.browser.0.lock().unwrap().is_none());
  let f = Fixture::new();
  f.login();
  f.store.fail_refresh.store(true, Ordering::SeqCst);
  assert_eq!(f.account.refresh().unwrap_err(), AccountError::Storage);
  assert_eq!(
    f.server
      .state
      .lock()
      .unwrap()
      .calls
      .iter()
      .filter(|p| p.as_str() == "/v1/accounts:signInWithCustomToken")
      .count(),
    1
  );
}
#[test]
fn secrets_callbacks_requests_and_responses_are_redacted() {
  let value = Secret::new("synthetic-sensitive-value");
  let request = Request {
    method: "POST",
    url: value.clone(),
    body: Some(value.clone()),
    bearer: Some(value.clone()),
  };
  let response = Response {
    status: 200,
    body: value.clone(),
  };
  for text in [format!("{value:?}"), format!("{request:?}"), format!("{response:?}")] {
    assert!(!text.contains(value.expose()));
  }
  let f = Fixture::new();
  f.account.login().unwrap();
  let callback = parse_callback(ClientId::Camera, &f.callback()).unwrap();
  assert_eq!(format!("{callback:?}"), "Callback([REDACTED])");
}
#[test]
fn local_only_build_never_opens_browser_or_storage_and_needs_no_login_for_editing() {
  let account = Account::disabled();
  assert_eq!(account.login().unwrap_err(), AccountError::NotConfigured);
  assert_eq!(account.snapshot().phase, AccountPhase::LocalOnly);
  assert!(account.snapshot().local_editing_available);
}
#[test]
fn rust_contract_matches_photo_docs_versioned_spec() {
  let contract: Value = serde_json::from_str(SAFETY_CONTRACT).unwrap();
  assert_eq!(contract["version"], SAFETY_CONTRACT_VERSION);
  let phases = [
    AccountPhase::LocalOnly,
    AccountPhase::SignedOut,
    AccountPhase::Waiting,
    AccountPhase::Refreshing,
    AccountPhase::Connected,
    AccountPhase::Offline,
    AccountPhase::Failed,
  ];
  assert_eq!(serde_json::to_value(phases).unwrap(), contract["phases"]);
  let errors = [
    AccountError::NotConfigured,
    AccountError::InvalidConfig,
    AccountError::Busy,
    AccountError::Cancelled,
    AccountError::Expired,
    AccountError::InvalidRedirect,
    AccountError::InvalidState,
    AccountError::InvalidResponse,
    AccountError::Rejected,
    AccountError::Network,
    AccountError::Paused,
    AccountError::AccountUnavailable,
    AccountError::Browser,
    AccountError::Storage,
    AccountError::Internal,
  ];
  assert_eq!(serde_json::to_value(errors).unwrap(), contract["errorCodes"]);
}

#[test]
fn photo_identity_accepts_only_the_closed_safe_camera_dto() {
  let photo = Arc::new(StaticPhotoSession::valid());
  let f = Fixture::with_photo_session(photo.clone());
  f.login();
  let identity = f.account.photo_identity().unwrap();
  assert_eq!(
    serde_json::to_value(identity).unwrap(),
    json!({
      "userId": "synthetic-user",
      "sessionId": "synthetic-connection",
      "sessionEpoch": "synthetic-epoch",
      "transport": "mac-bearer",
      "expiresAt": "1970-01-01T01:00:00.000Z"
    })
  );
  assert_eq!(photo.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn photo_identity_rejects_unknown_secret_missing_malformed_expired_and_wrong_contract_fields() {
  let mut secret_extra = valid_photo_identity();
  secret_extra["token"] = json!("synthetic-secret-must-not-cross");
  let mut actor_extra = valid_photo_identity();
  actor_extra["actor"]["email"] = json!("private@example.invalid");
  let mut missing = valid_photo_identity();
  missing.as_object_mut().unwrap().remove("sessionEpoch");
  let mut malformed_date = valid_photo_identity();
  malformed_date["expiresAt"] = json!("1970-02-30T01:00:00.000Z");
  let mut expired = valid_photo_identity();
  expired["expiresAt"] = json!("1970-01-01T00:16:40.000Z");
  let mut too_far = valid_photo_identity();
  too_far["expiresAt"] = json!("1970-02-02T00:16:40.001Z");
  let mut audience = valid_photo_identity();
  audience["audience"] = json!("another-audience");
  let mut client = valid_photo_identity();
  client["clientId"] = json!("niho-docs");
  let mut refresh = valid_photo_identity();
  refresh["refreshRequired"] = json!(true);
  let mut wrong_actor = valid_photo_identity();
  wrong_actor["actor"]["id"] = json!("another-user");
  let mut format_character = valid_photo_identity();
  format_character["sessionId"] = json!("hidden\u{200b}separator");

  for body in [
    secret_extra,
    actor_extra,
    missing,
    malformed_date,
    expired,
    too_far,
    audience,
    client,
    refresh,
    wrong_actor,
    format_character,
    json!([]),
  ] {
    let f = Fixture::with_photo_session(Arc::new(StaticPhotoSession::new(200, body)));
    f.login();
    assert_eq!(f.account.photo_identity().unwrap_err(), AccountError::InvalidResponse);
    assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
  }
}

#[test]
fn photo_identity_rejects_a_different_native_connection_session() {
  let mut value = valid_photo_identity();
  value["sessionId"] = json!("different-connection");
  let f = Fixture::with_photo_session(Arc::new(StaticPhotoSession::new(200, value)));
  f.login();
  assert_eq!(f.account.photo_identity().unwrap_err(), AccountError::InvalidResponse);
}

#[test]
fn photo_identity_feature_pause_preserves_the_native_connection() {
  let photo = Arc::new(StaticPhotoSession::new(
    401,
    json!({"code":"UNAUTHORIZED","details":{"reason":"app_connect_disabled"}}),
  ));
  let f = Fixture::with_photo_session(photo);
  f.login();
  assert_eq!(f.account.photo_identity().unwrap_err(), AccountError::Paused);
  assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_some());
}

#[test]
fn photo_identity_rejects_oversize_and_revocation_invalidates_the_account() {
  let oversize = Arc::new(StaticPhotoSession {
    status: 200,
    body: "x".repeat(64 * 1024 + 1),
    calls: AtomicU64::new(0),
  });
  let f = Fixture::with_photo_session(oversize);
  f.login();
  assert_eq!(f.account.photo_identity().unwrap_err(), AccountError::InvalidResponse);

  for reason in [
    "app_connection_revoked",
    "session_revoked",
    "mac_connection_rejected",
    "mac_token_invalid",
    "mac_token_expired",
    "mac_token_scope_invalid",
    "mac_auth_time_invalid",
  ] {
    let photo = Arc::new(StaticPhotoSession::new(
      401,
      json!({"code":"UNAUTHORIZED","details":{"reason":reason},"message":"synthetic-sensitive"}),
    ));
    let f = Fixture::with_photo_session(photo.clone());
    f.login();
    assert_eq!(f.account.photo_identity().unwrap_err(), AccountError::Expired);
    assert_eq!(f.account.snapshot().phase, AccountPhase::Failed);
    assert_eq!(f.account.snapshot().error, Some(AccountError::Expired));
    assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
    assert_eq!(f.account.photo_identity().unwrap_err(), AccountError::Expired);
    assert_eq!(photo.calls.load(Ordering::SeqCst), 1);
  }
}

#[test]
fn disabled_and_docs_accounts_never_call_photo_http() {
  let photo = Arc::new(StaticPhotoSession::valid());
  assert_eq!(
    Account::disabled().photo_identity().unwrap_err(),
    AccountError::NotConfigured
  );

  let mut config = Config::mock("http://127.0.0.1:12345");
  config.client = ClientId::Docs;
  let account = Account::with_adapters(
    config,
    Arc::new(MemoryStore::default()),
    Arc::new(CaptureBrowser::default()),
    Arc::new(MockServer {
      state: Mutex::new(ServerState::default()),
      store: Arc::new(MemoryStore::default()),
      browser: Arc::new(CaptureBrowser::default()),
    }),
  )
  .with_photo_session(photo.clone());
  assert_eq!(account.photo_identity().unwrap_err(), AccountError::NotConfigured);
  assert_eq!(photo.calls.load(Ordering::SeqCst), 0);
}

struct DelayedPhotoSession {
  received: AtomicBool,
  release: AtomicBool,
}
impl PhotoSessionTransport for DelayedPhotoSession {
  fn send(&self, _: &Config, bearer: &Secret) -> Result<PhotoSessionResponse, AccountError> {
    assert_eq!(bearer.expose(), "synthetic-id-token");
    self.received.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(3);
    while !self.release.load(Ordering::SeqCst) {
      assert!(Instant::now() < deadline);
      std::thread::sleep(Duration::from_millis(2));
    }
    Ok(PhotoSessionResponse {
      status: 200,
      body: Secret::new(valid_photo_identity().to_string()),
    })
  }
}

#[test]
fn delayed_photo_identity_cannot_survive_logout_or_refresh_generation_changes() {
  for logout in [true, false] {
    let photo = Arc::new(DelayedPhotoSession {
      received: AtomicBool::new(false),
      release: AtomicBool::new(false),
    });
    let f = Fixture::with_photo_session(photo.clone());
    f.login();
    let account = Arc::clone(&f.account);
    let pending = std::thread::spawn(move || account.photo_identity());
    let deadline = Instant::now() + Duration::from_secs(3);
    while !photo.received.load(Ordering::SeqCst) {
      assert!(Instant::now() < deadline);
      std::thread::sleep(Duration::from_millis(2));
    }
    if logout {
      f.account.logout().unwrap();
    } else {
      f.account.refresh().unwrap();
    }
    photo.release.store(true, Ordering::SeqCst);
    assert_eq!(pending.join().unwrap().unwrap_err(), AccountError::Cancelled);
  }
}

struct RotatingExpiryPhotoSession(AtomicU64);
impl PhotoSessionTransport for RotatingExpiryPhotoSession {
  fn send(&self, _: &Config, _: &Secret) -> Result<PhotoSessionResponse, AccountError> {
    let mut body = valid_photo_identity();
    if self.0.fetch_add(1, Ordering::SeqCst) > 0 {
      body["expiresAt"] = json!("1970-01-01T01:00:01.000Z");
    }
    Ok(PhotoSessionResponse {
      status: 200,
      body: Secret::new(body.to_string()),
    })
  }
}

#[test]
fn expiry_refresh_keeps_the_same_logical_photo_identity_scope() {
  let f = Fixture::with_photo_session(Arc::new(RotatingExpiryPhotoSession(AtomicU64::new(0))));
  f.login();
  let first = f.account.photo_identity().unwrap();
  let second = f.account.photo_identity().unwrap();
  assert_eq!(first.user_id, second.user_id);
  assert_eq!(first.session_id, second.session_id);
  assert_eq!(first.session_epoch, second.session_epoch);
  assert_eq!(first.transport, second.transport);
  assert_ne!(first.expires_at, second.expires_at);
}

fn photo_scope(identity: &PhotoIdentity) -> PhotoScopeCapture {
  PhotoScopeCapture {
    user_id: identity.user_id.clone(),
    session_id: identity.session_id.clone(),
    session_epoch: identity.session_epoch.clone(),
    transport: identity.transport.clone(),
  }
}

#[test]
fn native_file_commit_checks_scope_and_expiry_before_touching_destination() {
  let f = Fixture::with_photo_session(Arc::new(StaticPhotoSession::new(200, valid_photo_identity())));
  f.login();
  let mut scope = photo_scope(&f.account.photo_identity().unwrap());
  assert_eq!(f.account.with_current_photo_scope(&scope, || Ok(7)), Ok(7));
  scope.session_epoch.push_str("-other");
  assert_eq!(
    f.account
      .with_current_photo_scope(&scope, || panic!("wrong scope must not commit")),
    Err::<(), _>(AccountError::Cancelled)
  );
  scope = photo_scope(&f.account.photo_identity().unwrap());
  f.clock.0.store(3_600_001, Ordering::SeqCst);
  assert_eq!(
    f.account
      .with_current_photo_scope(&scope, || panic!("expired scope must not commit")),
    Err::<(), _>(AccountError::Cancelled)
  );
}

#[test]
fn logout_waits_for_an_already_authorized_native_file_commit() {
  use std::sync::mpsc;
  let f = Fixture::with_photo_session(Arc::new(StaticPhotoSession::new(200, valid_photo_identity())));
  f.login();
  let scope = photo_scope(&f.account.photo_identity().unwrap());
  let account = Arc::clone(&f.account);
  let (entered_tx, entered_rx) = mpsc::channel();
  let (release_tx, release_rx) = mpsc::channel();
  let commit = std::thread::spawn(move || {
    account.with_current_photo_scope(&scope, || {
      entered_tx.send(()).unwrap();
      release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
      Ok(())
    })
  });
  entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
  let account = Arc::clone(&f.account);
  let (attempt_tx, attempt_rx) = mpsc::channel();
  let (done_tx, done_rx) = mpsc::channel();
  let logout = std::thread::spawn(move || {
    attempt_tx.send(()).unwrap();
    let result = account.logout();
    done_tx.send(()).unwrap();
    result
  });
  attempt_rx.recv_timeout(Duration::from_secs(3)).unwrap();
  assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
  release_tx.send(()).unwrap();
  assert_eq!(commit.join().unwrap(), Ok(()));
  assert_eq!(logout.join().unwrap(), Ok(()));
}

fn native_photo_value() -> Value {
  json!({
    "id":"photo","libraryId":"library","storageState":"stored","lifecycle":"active",
    "fileName":"synthetic.jpg","format":"jpeg","hasEdits":false,"addedAt":"1970-01-01T00:16:40.000Z",
    "capturedAt":null,"width":1,"height":1,
    "original":{"id":"upa_opaque","kind":"original","sha256":format!("{:x}", Sha256::digest(b"x")),
      "sizeBytes":1,"contentType":"image/jpeg","width":1,"height":1},
    "recipe":{"revision":0,"settings":{"v":1,"engine":"niho-14"},"settingsSha256":"b".repeat(64),
      "baseVersion":null,"maskSurfaceIds":[],"updatedAt":"1970-01-01T00:16:40.000Z"},
    "media":{"state":"pending"}
  })
}

struct ContentStatusPhotoHttp {
  status: u16,
  received: Arc<AtomicBool>,
  release: Arc<AtomicBool>,
}

impl ContentStatusPhotoHttp {
  fn immediate(status: u16) -> Self {
    Self {
      status,
      received: Arc::new(AtomicBool::new(false)),
      release: Arc::new(AtomicBool::new(true)),
    }
  }
}

impl PhotoHttpTransport for ContentStatusPhotoHttp {
  fn send(
    &self,
    _: &Config,
    bearer: &Secret,
    request: &NativePhotoRequest,
    content: bool,
  ) -> Result<PhotoHttpResponse, AccountError> {
    assert_eq!(bearer.expose(), "synthetic-id-token");
    if content {
      self.received.store(true, Ordering::SeqCst);
      let deadline = Instant::now() + Duration::from_secs(3);
      while !self.release.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
      }
      if self.status == 0 {
        return Err(AccountError::Network);
      }
      return Ok(PhotoHttpResponse {
        status: self.status,
        content_length: Some(0),
        content_type: Some("application/json".into()),
        sha256: None,
        total_bytes: None,
        body: Box::new(Cursor::new(Vec::<u8>::new())),
      });
    }
    assert!(request.url.path().ends_with("/photos/photo"));
    let bytes = serde_json::to_vec(&native_photo_value()).unwrap();
    Ok(PhotoHttpResponse {
      status: 200,
      content_length: Some(bytes.len() as u64),
      content_type: Some("application/json".into()),
      sha256: None,
      total_bytes: None,
      body: Box::new(Cursor::new(bytes)),
    })
  }
}

#[test]
fn guarded_cache_read_rejects_bytes_if_logout_or_refresh_occurs_during_io() {
  for refresh in [false, true] {
    let f = Fixture::new();
    f.login();
    let scope = photo_scope(&f.account.photo_identity().unwrap());
    let result = f.account.photo_content_read_guarded(&scope, || {
      if refresh {
        f.account.refresh().unwrap();
      } else {
        f.account.logout().unwrap();
      }
      Ok(vec![7_u8])
    });
    assert_eq!(result, Err(AccountError::Cancelled));
  }
}

#[test]
fn content_401_invalidates_only_its_captured_generation() {
  let http = Arc::new(ContentStatusPhotoHttp::immediate(401));
  let f = Fixture::with_photo_http(http);
  f.login();
  let scope = photo_scope(&f.account.photo_identity().unwrap());
  let metadata = f
    .account
    .photo_content_metadata(&scope, "photo", "upa_opaque", None)
    .unwrap();
  assert_eq!(
    f.account
      .photo_content_download(&scope, &metadata, &mut Vec::new(), &PhotoDownloadCancel::default(),),
    Err(AccountError::Expired)
  );
  assert_eq!(f.account.snapshot().phase, AccountPhase::Failed);
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
  assert_eq!(
    f.account.photo_content_read_guarded(&scope, || Ok(vec![1_u8])),
    Err(AccountError::Expired)
  );

  let received = Arc::new(AtomicBool::new(false));
  let release = Arc::new(AtomicBool::new(false));
  let http = Arc::new(ContentStatusPhotoHttp {
    status: 401,
    received: Arc::clone(&received),
    release: Arc::clone(&release),
  });
  let f = Fixture::with_photo_http(http);
  f.login();
  let scope = photo_scope(&f.account.photo_identity().unwrap());
  let metadata = f
    .account
    .photo_content_metadata(&scope, "photo", "upa_opaque", None)
    .unwrap();
  let account = Arc::clone(&f.account);
  let pending = std::thread::spawn(move || {
    account.photo_content_download(&scope, &metadata, &mut Vec::new(), &PhotoDownloadCancel::default())
  });
  let deadline = Instant::now() + Duration::from_secs(3);
  while !received.load(Ordering::SeqCst) {
    assert!(Instant::now() < deadline);
    std::thread::sleep(Duration::from_millis(2));
  }
  f.account.refresh().unwrap();
  release.store(true, Ordering::SeqCst);
  assert_eq!(pending.join().unwrap(), Err(AccountError::Cancelled));
  assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_some());
}

#[test]
fn content_transient_status_does_not_permanently_logout() {
  for status in [0, 429, 503] {
    let f = Fixture::with_photo_http(Arc::new(ContentStatusPhotoHttp::immediate(status)));
    f.login();
    let scope = photo_scope(&f.account.photo_identity().unwrap());
    let metadata = f
      .account
      .photo_content_metadata(&scope, "photo", "upa_opaque", None)
      .unwrap();
    let expected = if status == 0 {
      AccountError::Network
    } else {
      AccountError::InvalidResponse
    };
    assert_eq!(
      f.account
        .photo_content_download(&scope, &metadata, &mut Vec::new(), &PhotoDownloadCancel::default(),),
      Err(expected)
    );
    assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
    assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_some());
  }
}

struct PausedTransport {
  path: &'static str,
  server: Arc<MockServer>,
  received: Arc<AtomicBool>,
  release: Arc<AtomicBool>,
}
impl Transport for PausedTransport {
  fn send(&self, config: &Config, request: &Request, cancel: &Cancel) -> Result<Response, AccountError> {
    let response = self.server.send(config, request, cancel)?;
    if Url::parse(request.url.expose()).unwrap().path() == self.path {
      self.received.store(true, Ordering::SeqCst);
      let deadline = Instant::now() + Duration::from_secs(3);
      while !self.release.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
      }
    }
    Ok(response)
  }
}
#[test]
fn cancel_logout_and_duplicate_callbacks_cannot_restore_late_exchange_results() {
  for logout in [false, true] {
    let f = Fixture::new();
    let received = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let account = Arc::new(
      Account::with_adapters(
        f.config.clone(),
        f.store.clone(),
        f.browser.clone(),
        Arc::new(PausedTransport {
          path: "/api/auth/app-connect/exchange",
          server: f.server.clone(),
          received: received.clone(),
          release: release.clone(),
        }),
      )
      .with_clock(f.clock.clone()),
    );
    account.login().unwrap();
    let callback = f.callback();
    let worker_account = account.clone();
    let callback_copy = callback.clone();
    let worker = std::thread::spawn(move || worker_account.handle_callback(&callback_copy));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !received.load(Ordering::SeqCst) {
      assert!(Instant::now() < deadline);
      std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(account.handle_callback(&callback).unwrap_err(), AccountError::Busy);
    if logout {
      account.logout().unwrap();
    } else {
      account.cancel().unwrap();
    }
    release.store(true, Ordering::SeqCst);
    assert_eq!(worker.join().unwrap().unwrap_err(), AccountError::Cancelled);
    assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
    assert_eq!(account.snapshot().phase, AccountPhase::SignedOut);
  }
}
#[test]
fn maintenance_refreshes_before_expiry_and_backs_off_without_clearing_connection() {
  let f = Fixture::new();
  f.login();
  let calls = f.server.state.lock().unwrap().calls.len();
  f.account.maintain().unwrap();
  assert_eq!(f.server.state.lock().unwrap().calls.len(), calls);
  f.clock.0.fetch_add(3_300_000, Ordering::SeqCst);
  f.account.maintain().unwrap();
  assert_eq!(f.server.state.lock().unwrap().refresh_count, 1);
  f.clock.0.fetch_add(3_300_000, Ordering::SeqCst);
  f.server.state.lock().unwrap().error = Some(("/api/auth/app-connect/refresh".into(), 503, "temporary"));
  assert_eq!(f.account.maintain().unwrap_err(), AccountError::Network);
  let calls = f.server.state.lock().unwrap().calls.len();
  f.account.maintain().unwrap();
  assert_eq!(f.server.state.lock().unwrap().calls.len(), calls);
  f.clock.0.fetch_add(1000, Ordering::SeqCst);
  assert_eq!(f.account.maintain().unwrap_err(), AccountError::Network);
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_some());
}

#[test]
fn cancelling_after_refresh_save_or_before_me_commit_never_restores_a_new_login() {
  for path in ["/v1/accounts:signInWithCustomToken", "/api/auth/me"] {
    for logout in [false, true] {
      let f = Fixture::new();
      let received = Arc::new(AtomicBool::new(false));
      let release = Arc::new(AtomicBool::new(false));
      let account = Arc::new(
        Account::with_adapters(
          f.config.clone(),
          f.store.clone(),
          f.browser.clone(),
          Arc::new(PausedTransport {
            path,
            server: f.server.clone(),
            received: received.clone(),
            release: release.clone(),
          }),
        )
        .with_clock(f.clock.clone()),
      );
      account.login().unwrap();
      let callback = f.callback();
      let worker_account = account.clone();
      let worker = std::thread::spawn(move || worker_account.handle_callback(&callback));
      let deadline = Instant::now() + Duration::from_secs(3);
      while !received.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
      }
      assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_some());
      if logout {
        account.logout().unwrap();
      } else {
        account.cancel().unwrap();
      }
      assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
      release.store(true, Ordering::SeqCst);
      assert_eq!(worker.join().unwrap().unwrap_err(), AccountError::Cancelled);
      account.restore().unwrap();
      assert_eq!(account.snapshot().phase, AccountPhase::SignedOut);
      assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
    }
  }
}
#[test]
fn an_existing_connection_cannot_be_replaced_by_a_new_login_and_refresh_cancel_keeps_it() {
  let f = Fixture::new();
  f.login();
  assert_eq!(f.account.login().unwrap_err(), AccountError::Busy);
  let received = Arc::new(AtomicBool::new(false));
  let release = Arc::new(AtomicBool::new(false));
  let account = Arc::new(
    Account::with_adapters(
      f.config.clone(),
      f.store.clone(),
      f.browser.clone(),
      Arc::new(PausedTransport {
        path: "/api/auth/me",
        server: f.server.clone(),
        received: received.clone(),
        release: release.clone(),
      }),
    )
    .with_clock(f.clock.clone()),
  );
  let worker_account = account.clone();
  let worker = std::thread::spawn(move || worker_account.refresh());
  let deadline = Instant::now() + Duration::from_secs(3);
  while !received.load(Ordering::SeqCst) {
    assert!(Instant::now() < deadline);
    std::thread::sleep(Duration::from_millis(2));
  }
  account.cancel().unwrap();
  release.store(true, Ordering::SeqCst);
  assert_eq!(worker.join().unwrap().unwrap_err(), AccountError::Cancelled);
  assert_eq!(account.snapshot().phase, AccountPhase::Offline);
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_some());
  assert_eq!(account.login().unwrap_err(), AccountError::Busy);
}
#[test]
fn rotation_save_failure_retries_only_within_server_grace_and_expired_old_token_is_removed() {
  for grace in [true, false] {
    let f = Fixture::new();
    f.login();
    let old = f.store.load(SecretKind::RefreshToken).unwrap().unwrap();
    f.store.fail_refresh.store(true, Ordering::SeqCst);
    assert_eq!(f.account.refresh().unwrap_err(), AccountError::Storage);
    assert!(f.store.load(SecretKind::RefreshToken).unwrap().unwrap().expose() == old.expose());
    f.store.fail_refresh.store(false, Ordering::SeqCst);
    f.server.state.lock().unwrap().accept_previous_refresh = grace;
    if grace {
      f.account.refresh().unwrap();
      assert_eq!(f.account.snapshot().phase, AccountPhase::Connected);
    } else {
      assert_eq!(f.account.refresh().unwrap_err(), AccountError::Expired);
      assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
    }
  }
}

#[test]
fn real_http_mock_runs_exchange_firebase_me_and_connection_refresh_rotation() {
  use std::io::{Read, Write};
  use std::net::TcpListener;
  let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
  listener.set_nonblocking(true).unwrap();
  let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
  let config = Config::mock(&origin);
  let store = Arc::new(MemoryStore::default());
  let browser = Arc::new(CaptureBrowser::default());
  let server = Arc::new(MockServer {
    state: Mutex::new(ServerState::default()),
    store: store.clone(),
    browser: browser.clone(),
  });
  let worker_server = server.clone();
  let worker_config = config.clone();
  let worker = std::thread::spawn(move || {
    let deadline = Instant::now() + Duration::from_secs(5);
    for _ in 0..6 {
      let mut stream = loop {
        match listener.accept() {
          Ok((stream, _)) => break stream,
          Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
          }
          Err(_) => panic!("mock connection failed"),
        }
      };
      stream.set_nonblocking(false).unwrap();
      stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
      let mut bytes = Vec::new();
      let end = loop {
        let mut chunk = [0; 2048];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
          break index + 4;
        }
      };
      let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
      let mut lines = header.lines();
      let first = lines.next().unwrap();
      let parts: Vec<_> = first.split(' ').collect();
      let mut length = 0;
      let mut bearer = None;
      for line in lines {
        if let Some((key, value)) = line.split_once(':') {
          if key.eq_ignore_ascii_case("content-length") {
            length = value.trim().parse::<usize>().unwrap();
          }
          if key.eq_ignore_ascii_case("authorization") {
            bearer = Some(Secret::new(value.trim().strip_prefix("Bearer ").unwrap()));
          }
        }
      }
      while bytes.len() < end + length {
        let mut chunk = [0; 2048];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&chunk[..count]);
      }
      let request = Request {
        method: if parts[0] == "POST" { "POST" } else { "GET" },
        url: Secret::new(format!("{origin}{}", parts[1])),
        body: if length > 0 {
          Some(Secret::new(std::str::from_utf8(&bytes[end..end + length]).unwrap()))
        } else {
          None
        },
        bearer,
      };
      let response = worker_server
        .send(&worker_config, &request, &Cancel::default())
        .unwrap();
      let body = response.body.expose();
      write!(
        stream,
        "HTTP/1.1 {} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        response.status,
        body.len()
      )
      .unwrap();
    }
  });
  let account = Account::with_adapters(config, store.clone(), browser.clone(), Arc::new(HttpTransport));
  account.login().unwrap();
  let connect = Url::parse(browser.0.lock().unwrap().as_ref().unwrap().expose()).unwrap();
  let state = connect
    .query_pairs()
    .find(|(key, _)| key == "state")
    .unwrap()
    .1
    .into_owned();
  account
    .handle_callback(&Secret::new(format!(
      "niho-camera://auth?code={}&state={state}",
      "C".repeat(43)
    )))
    .unwrap();
  account.refresh().unwrap();
  assert_eq!(account.snapshot().phase, AccountPhase::Connected);
  worker.join().unwrap();
}

#[test]
fn initial_identity_failure_restores_only_an_explicitly_retryable_connection() {
  for (status, reason, recoverable) in [
    (503, "temporary", true),
    (404, "app_connect_disabled", true),
    (400, "invalid_custom_token", false),
  ] {
    let f = Fixture::new();
    f.account.login().unwrap();
    f.server.state.lock().unwrap().error = Some(("/v1/accounts:signInWithCustomToken".into(), status, reason));
    assert!(f.account.handle_callback(&f.callback()).is_err());
    assert_eq!(f.store.load(SecretKind::RefreshToken).unwrap().is_some(), recoverable);
    f.server.state.lock().unwrap().error = None;
    f.account.restore().unwrap();
    assert_eq!(
      f.account.snapshot().phase,
      if recoverable {
        AccountPhase::Connected
      } else {
        AccountPhase::SignedOut
      }
    );
  }
}

#[test]
fn transport_rejects_unknown_endpoints_and_token_urls_before_network_access() {
  let config = Config::production(ClientId::Camera, "public-web-key").unwrap();
  for target in [
    "https://other.example/steal",
    "https://niho.life/api/auth/me?access_token=synthetic",
    "http://niho.life/api/auth/me",
  ] {
    let request = Request {
      method: "GET",
      url: Secret::new(target),
      body: None,
      bearer: Some(Secret::new("synthetic-token")),
    };
    assert_eq!(
      HttpTransport.send(&config, &request, &Cancel::default()).unwrap_err(),
      AccountError::InvalidConfig
    );
  }
}

#[test]
fn exchange_network_failure_without_saved_credentials_requires_a_fresh_login_not_refresh() {
  let f = Fixture::new();
  f.account.login().unwrap();
  let old_callback = f.callback();
  let old_connect = f.browser.0.lock().unwrap().as_ref().unwrap().expose().to_string();
  f.server.state.lock().unwrap().error = Some(("/api/auth/app-connect/exchange".into(), 503, "temporary"));
  assert_eq!(
    f.account.handle_callback(&old_callback).unwrap_err(),
    AccountError::Network
  );
  assert_eq!(f.account.snapshot().phase, AccountPhase::Failed);
  assert!(f.store.load(SecretKind::RefreshToken).unwrap().is_none());
  let calls = f.server.state.lock().unwrap().calls.len();
  f.clock.0.fetch_add(1_000_000, Ordering::SeqCst);
  f.account.maintain().unwrap();
  assert_eq!(f.server.state.lock().unwrap().calls.len(), calls);
  f.account.login().unwrap();
  assert!(f.browser.0.lock().unwrap().as_ref().unwrap().expose() != old_connect);
  assert_eq!(
    f.account.handle_callback(&old_callback).unwrap_err(),
    AccountError::InvalidState
  );
  assert_eq!(f.server.state.lock().unwrap().calls.len(), calls);
}

/// 共有アルバムの合成の上流: 追加の答えに upload の ticket を付け、ticket の先は 8MiB ごとに受ける。
struct SharingPhotoHttp {
  status: u16,
  size_bytes: u64,
  sent_paths: Mutex<Vec<String>>,
  puts: Mutex<Vec<(u64, usize)>>,
}

impl SharingPhotoHttp {
  fn new(status: u16, size_bytes: u64) -> Self {
    Self {
      status,
      size_bytes,
      sent_paths: Mutex::new(Vec::new()),
      puts: Mutex::new(Vec::new()),
    }
  }
}

impl PhotoHttpTransport for SharingPhotoHttp {
  fn send(
    &self,
    _: &Config,
    bearer: &Secret,
    request: &NativePhotoRequest,
    content: bool,
  ) -> Result<PhotoHttpResponse, AccountError> {
    assert_eq!(bearer.expose(), "synthetic-id-token");
    assert!(!content);
    self.sent_paths.lock().unwrap().push(request.url.path().to_owned());
    let (status, value) = if self.status == 401 {
      (
        401,
        json!({ "error": { "code": "unauthenticated", "requestId": "r", "retryable": false } }),
      )
    } else {
      (
        200,
        json!({
          "value": {
            "item": { "id": "synthetic-item", "state": "preparing" },
            "upload": {
              "upload": { "id": "synthetic-upload", "sizeBytes": self.size_bytes, "state": "reserved" },
              "ticket": {
                "url": "https://storage.googleapis.com/synthetic-bucket/upload?upload_id=synthetic",
                "method": "PUT",
                "headers": { "Content-Type": "image/jpeg" },
                "expiresAt": "2099-01-01T00:00:00.000Z",
                "resumeOffsetBytes": 0
              }
            }
          },
          "replayed": false
        }),
      )
    };
    let bytes = serde_json::to_vec(&value).unwrap();
    Ok(PhotoHttpResponse {
      status,
      content_length: Some(bytes.len() as u64),
      content_type: Some("application/json".into()),
      sha256: None,
      total_bytes: None,
      body: Box::new(Cursor::new(bytes)),
    })
  }

  fn provider_put(
    &self,
    url: &Url,
    content_type: &str,
    offset: u64,
    total: u64,
    body: &[u8],
  ) -> Result<ProviderResponse, AccountError> {
    assert_eq!(url.host_str(), Some("storage.googleapis.com"));
    assert_eq!(content_type, "image/jpeg");
    self.puts.lock().unwrap().push((offset, body.len()));
    let end = offset + body.len() as u64;
    if end == total {
      Ok(ProviderResponse::synthetic(200, None))
    } else {
      Ok(ProviderResponse::synthetic(308, Some(&format!("bytes=0-{}", end - 1))))
    }
  }
}

fn sharing_add_request() -> SharingRequest {
  SharingRequest::parse(
    "POST",
    "/cloud/sharing/v1/albums/synthetic-album/file-items",
    Some(json!({ "rendition": { "contentType": "image/jpeg" } })),
    Some("synthetic-key".into()),
  )
  .unwrap()
}

#[test]
fn sharing_requests_keep_upload_tickets_native_and_upload_in_chunks() {
  let size = 9 * 1024 * 1024;
  let http = Arc::new(SharingPhotoHttp::new(200, size));
  let f = Fixture::with_photo_http(Arc::clone(&http) as Arc<dyn PhotoHttpTransport>);
  f.login();
  let scope = photo_scope(&f.account.photo_identity().unwrap());
  let response = f.account.photo_sharing_request(&scope, &sharing_add_request()).unwrap();
  assert_eq!(
    http.sent_paths.lock().unwrap().as_slice(),
    ["/api/synthetic-sharing/v1/albums/synthetic-album/file-items"]
  );
  assert_eq!(response.tickets.len(), 1);
  let shown = response.body["value"]["upload"]["ticket"]["url"].as_str().unwrap();
  assert_eq!(sharing_ticket_handle(shown), Some(response.tickets[0].handle.as_str()));
  assert!(!serde_json::to_string(&response.body).unwrap().contains("googleapis"));

  let bytes = vec![7_u8; size as usize];
  f.account
    .photo_sharing_upload(&scope, &response.tickets[0].ticket, &bytes)
    .unwrap();
  assert_eq!(
    http.puts.lock().unwrap().as_slice(),
    [(0, 8 * 1024 * 1024), (8 * 1024 * 1024, 1024 * 1024)]
  );
  // 大きさの違う bytes は送らない
  assert_eq!(
    f.account
      .photo_sharing_upload(&scope, &response.tickets[0].ticket, &bytes[1..]),
    Err(AccountError::InvalidResponse)
  );
}

#[test]
fn a_refused_sharing_session_invalidates_the_photo_identity() {
  let f = Fixture::with_photo_http(Arc::new(SharingPhotoHttp::new(401, 1)));
  f.login();
  let scope = photo_scope(&f.account.photo_identity().unwrap());
  let response = f.account.photo_sharing_request(&scope, &sharing_add_request()).unwrap();
  assert_eq!(response.status, 401);
  assert!(response.tickets.is_empty());
  assert_eq!(f.account.snapshot().phase, AccountPhase::Failed);
}

#[test]
fn sharing_json_and_content_routes_do_not_cross() {
  let http = Arc::new(SharingPhotoHttp::new(200, 1));
  let f = Fixture::with_photo_http(http);
  f.login();
  let scope = photo_scope(&f.account.photo_identity().unwrap());
  let download = SharingRequest::parse(
    "GET",
    "/cloud/sharing/v1/albums/synthetic-album/items/synthetic-item/renditions/synthetic-rendition/content?variant=full",
    None,
    None,
  )
  .unwrap();
  assert!(matches!(
    f.account.photo_sharing_request(&scope, &download),
    Err(AccountError::InvalidResponse)
  ));
  let list = SharingRequest::parse("GET", "/cloud/sharing/v1/albums", None, None).unwrap();
  let mut bytes = Vec::new();
  assert_eq!(
    f.account
      .photo_sharing_content(&scope, &list, &mut bytes, &PhotoDownloadCancel::default())
      .unwrap_err(),
    AccountError::InvalidResponse
  );
  assert!(bytes.is_empty());
}
