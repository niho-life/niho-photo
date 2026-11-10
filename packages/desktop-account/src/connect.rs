use crate::{AccountError, Secret};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc,
};
use std::time::Duration;
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::Zeroizing;

pub const PENDING_TTL_MS: u64 = 10 * 60 * 1000;
const MAX_RESPONSE: u64 = 64 * 1024;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ClientId {
  #[serde(rename = "niho-camera")]
  Camera,
  #[serde(rename = "niho-docs")]
  Docs,
}
impl ClientId {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Camera => "niho-camera",
      Self::Docs => "niho-docs",
    }
  }
}
#[derive(Clone)]
pub struct Config {
  pub(crate) client: ClientId,
  origin: Url,
  identity_origin: Url,
  public_firebase_web_api_key: String,
  /// 共有アルバムの上流の prefix（build の設定。無ければ共有の通信を閉じる）。
  sharing_prefix: Option<String>,
  #[cfg(test)]
  mock_http: bool,
}
impl std::fmt::Debug for Config {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("AppConnectConfig")
      .field("client", &self.client)
      .finish_non_exhaustive()
  }
}
impl Config {
  /// 公開Web API keyはclient secretではない。productionの宛先は公開契約の固定HTTPSのみ。
  pub fn production(client: ClientId, public_firebase_web_api_key: &str) -> Result<Self, AccountError> {
    if public_firebase_web_api_key.is_empty()
      || public_firebase_web_api_key.len() > 256
      || !public_firebase_web_api_key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
      return Err(AccountError::InvalidConfig);
    }
    Ok(Self {
      client,
      origin: Url::parse("https://niho.life").map_err(|_| AccountError::InvalidConfig)?,
      identity_origin: Url::parse("https://identitytoolkit.googleapis.com").map_err(|_| AccountError::InvalidConfig)?,
      public_firebase_web_api_key: public_firebase_web_api_key.into(),
      sharing_prefix: None,
      #[cfg(test)]
      mock_http: false,
    })
  }
  /// 共有アルバム（`/cloud/sharing/v1`）の上流の prefix として使える形か（`/api/` で始まる固定の path）。
  pub fn sharing_prefix_is_valid(prefix: &str) -> bool {
    prefix.starts_with("/api/")
      && !prefix.ends_with('/')
      && prefix.len() <= 128
      && !prefix.contains("//")
      && prefix.split('/').all(|segment| segment != "." && segment != "..")
      && prefix
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"/-".contains(&b))
  }
  /// 共有アルバムの上流の prefix を足す（build の設定）。
  pub fn with_sharing_prefix(mut self, prefix: &str) -> Result<Self, AccountError> {
    if !Self::sharing_prefix_is_valid(prefix) {
      return Err(AccountError::InvalidConfig);
    }
    self.sharing_prefix = Some(prefix.to_owned());
    Ok(self)
  }
  pub(crate) fn sharing_prefix(&self) -> Option<&str> {
    self.sharing_prefix.as_deref()
  }
  #[cfg(test)]
  pub(crate) fn mock(origin: &str) -> Self {
    let origin = Url::parse(origin).unwrap();
    assert_eq!(origin.scheme(), "http");
    assert_eq!(origin.host_str(), Some("127.0.0.1"));
    Self {
      origin: origin.clone(),
      identity_origin: origin,
      client: ClientId::Camera,
      public_firebase_web_api_key: "synthetic-public-web-key".into(),
      sharing_prefix: Some("/api/synthetic-sharing/v1".into()),
      mock_http: true,
    }
  }
  pub(crate) fn connect_url(&self, pending: &Pending) -> Secret {
    let mut url = self
      .origin
      .join(&format!("/connect/{}", self.client.as_str()))
      .expect("static path");
    url
      .query_pairs_mut()
      .append_pair("v", "1")
      .append_pair(
        "challenge",
        &URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.expose().as_bytes())),
      )
      .append_pair("state", pending.state.expose());
    Secret::new(url.as_str())
  }
  pub(crate) fn api_url(&self, path: &str) -> Url {
    self.origin.join(path).expect("static API path")
  }
  pub(crate) fn identity_url(&self) -> Url {
    let mut url = self
      .identity_origin
      .join("/v1/accounts:signInWithCustomToken")
      .expect("static identity path");
    url
      .query_pairs_mut()
      .append_pair("key", &self.public_firebase_web_api_key);
    url
  }
  fn allows(&self, request: &Request) -> bool {
    let Ok(url) = Url::parse(request.url.expose()) else {
      return false;
    };
    if url == self.identity_url() {
      return request.method == "POST" && request.bearer.is_none();
    }
    if url.origin() != self.origin.origin()
      || !url.username().is_empty()
      || url.password().is_some()
      || url.fragment().is_some()
    {
      return false;
    }
    match (request.method, url.path()) {
      ("POST", "/api/auth/app-connect/exchange" | "/api/auth/app-connect/refresh") => {
        url.query().is_none() && request.bearer.is_none()
      }
      ("GET", "/api/auth/me") => url.query().is_none() && request.bearer.is_some() && request.body.is_none(),
      ("DELETE", path) => {
        path.strip_prefix("/api/auth/app-connections/").is_some_and(|id| {
          !id.is_empty() && id.len() <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        }) && url.query() == Some("reason=logout")
          && request.bearer.is_some()
          && request.body.is_none()
      }
      _ => false,
    }
  }
}
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);
impl Cancel {
  pub fn cancel(&self) {
    self.0.store(true, Ordering::SeqCst);
  }
  pub fn check(&self) -> Result<(), AccountError> {
    if self.0.load(Ordering::SeqCst) {
      Err(AccountError::Cancelled)
    } else {
      Ok(())
    }
  }
}
pub(crate) fn random_secret() -> Result<Secret, AccountError> {
  let mut bytes = Zeroizing::new([0u8; 32]);
  getrandom::fill(&mut *bytes).map_err(|_| AccountError::Internal)?;
  Ok(Secret::new(URL_SAFE_NO_PAD.encode(*bytes)))
}
pub(crate) fn equal(a: &str, b: &str) -> bool {
  bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
pub(crate) fn secret_43(value: &str) -> bool {
  value.len() == 43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Pending {
  pub verifier: Secret,
  pub state: Secret,
  pub client: ClientId,
  pub started_at_ms: u64,
  pub consumed: bool,
}
impl std::fmt::Debug for Pending {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("Pending([REDACTED])")
  }
}
impl Pending {
  pub fn new(client: ClientId, started_at_ms: u64) -> Result<Self, AccountError> {
    Ok(Self {
      verifier: random_secret()?,
      state: random_secret()?,
      client,
      started_at_ms,
      consumed: false,
    })
  }
  pub fn valid(&self, client: ClientId, now: u64) -> bool {
    self.client == client
      && secret_43(self.verifier.expose())
      && secret_43(self.state.expose())
      && now
        .checked_sub(self.started_at_ms)
        .is_some_and(|age| age < PENDING_TTL_MS)
  }
  pub fn encode(&self) -> Result<Secret, AccountError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Record<'a> {
      verifier: &'a str,
      state: &'a str,
      client: ClientId,
      started_at_ms: u64,
      consumed: bool,
    }
    serde_json::to_string(&Record {
      verifier: self.verifier.expose(),
      state: self.state.expose(),
      client: self.client,
      started_at_ms: self.started_at_ms,
      consumed: self.consumed,
    })
    .map(Secret::new)
    .map_err(|_| AccountError::Storage)
  }
}
pub struct Callback {
  pub(crate) code: Secret,
  pub(crate) state: Secret,
}
impl std::fmt::Debug for Callback {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("Callback([REDACTED])")
  }
}
pub fn parse_callback(client: ClientId, raw: &Secret) -> Result<Callback, AccountError> {
  if raw.expose().len() > 4096 || !raw.expose().starts_with(&format!("{}://auth?", client.as_str())) {
    return Err(AccountError::InvalidRedirect);
  }
  let url = Url::parse(raw.expose()).map_err(|_| AccountError::InvalidRedirect)?;
  if url.scheme() != client.as_str()
    || url.host_str() != Some("auth")
    || !url.path().is_empty()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.port().is_some()
    || url.fragment().is_some()
  {
    return Err(AccountError::InvalidRedirect);
  }
  let mut params = BTreeMap::new();
  for (key, value) in url.query_pairs() {
    if !["code", "state"].contains(&key.as_ref()) || params.insert(key.into_owned(), value.into_owned()).is_some() {
      return Err(AccountError::InvalidRedirect);
    }
  }
  let code = params.get("code").ok_or(AccountError::InvalidRedirect)?;
  let state = params.get("state").ok_or(AccountError::InvalidRedirect)?;
  if !secret_43(code)
    || !(22..=128).contains(&state.len())
    || !state.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
  {
    return Err(AccountError::InvalidRedirect);
  }
  Ok(Callback {
    code: Secret::new(code),
    state: Secret::new(state),
  })
}
pub trait Browser: Send + Sync {
  fn open(&self, url: &Secret) -> Result<(), AccountError>;
}
pub struct ExternalBrowser;
impl Browser for ExternalBrowser {
  fn open(&self, url: &Secret) -> Result<(), AccountError> {
    #[cfg(target_os = "macos")]
    {
      let result = std::process::Command::new("/usr/bin/open")
        .arg("--")
        .arg(url.expose())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| AccountError::Browser)?;
      if result.success() {
        Ok(())
      } else {
        Err(AccountError::Browser)
      }
    }
    #[cfg(not(target_os = "macos"))]
    {
      let _ = url;
      Err(AccountError::Browser)
    }
  }
}
/// URL/header/bodyはnative adapterだけで扱い、Debugでは値を出さない。
pub struct Request {
  pub method: &'static str,
  pub url: Secret,
  pub body: Option<Secret>,
  pub bearer: Option<Secret>,
}
impl std::fmt::Debug for Request {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("Request([REDACTED])")
  }
}
pub struct Response {
  pub status: u16,
  pub body: Secret,
}
impl std::fmt::Debug for Response {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str("Response([REDACTED])")
  }
}
pub trait Transport: Send + Sync {
  fn send(&self, config: &Config, request: &Request, cancel: &Cancel) -> Result<Response, AccountError>;
}
pub struct HttpTransport;
impl Transport for HttpTransport {
  fn send(&self, config: &Config, request: &Request, cancel: &Cancel) -> Result<Response, AccountError> {
    cancel.check()?;
    if !config.allows(request) {
      return Err(AccountError::InvalidConfig);
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = reqwest::blocking::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .timeout(Duration::from_secs(10))
      .no_proxy();
    #[cfg(test)]
    let builder = builder.https_only(!config.mock_http);
    #[cfg(not(test))]
    let builder = {
      let _ = config;
      builder.https_only(true)
    };
    let client = builder.build().map_err(|_| AccountError::Network)?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| AccountError::Internal)?;
    let mut builder = client
      .request(method, request.url.expose())
      .header("Accept", "application/json");
    if let Some(body) = &request.body {
      builder = builder
        .header("Content-Type", "application/json")
        .body(body.expose().to_string());
    }
    if let Some(token) = &request.bearer {
      builder = builder.bearer_auth(token.expose());
    }
    let response = builder.send().map_err(|_| AccountError::Network)?;
    cancel.check()?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE) {
      return Err(AccountError::InvalidResponse);
    }
    if status != 204
      && response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        != Some("application/json")
    {
      return Err(AccountError::InvalidResponse);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
      .take(MAX_RESPONSE + 1)
      .read_to_end(&mut bytes)
      .map_err(|_| AccountError::Network)?;
    cancel.check()?;
    if bytes.len() as u64 > MAX_RESPONSE {
      return Err(AccountError::InvalidResponse);
    }
    let body = std::str::from_utf8(&bytes)
      .map(Secret::new)
      .map_err(|_| AccountError::InvalidResponse)?;
    Ok(Response { status, body })
  }
}
