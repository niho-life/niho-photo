use crate::{AccountError, ClientId, Config, Secret};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Duration;
use zeroize::Zeroizing;

pub(crate) const PHOTO_AUDIENCE: &str = "niho-photo";
const PHOTO_SESSION_PATH: &str = "/api/auth/photo-connect/mac-session";
const MAX_RESPONSE: u64 = 64 * 1024;
const MAX_LIFETIME_MS: u64 = 31 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PhotoIdentityTransport {
  MacBearer,
}

/// Safe UI fencing metadata. It is not an authorization proof.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhotoIdentity {
  pub user_id: String,
  pub session_id: String,
  pub session_epoch: String,
  pub transport: PhotoIdentityTransport,
  pub expires_at: String,
}

pub(crate) struct PhotoSessionResponse {
  pub status: u16,
  pub body: Secret,
}

pub(crate) trait PhotoSessionTransport: Send + Sync {
  fn send(&self, config: &Config, bearer: &Secret) -> Result<PhotoSessionResponse, AccountError>;
}

pub(crate) struct HttpPhotoSession;

impl PhotoSessionTransport for HttpPhotoSession {
  fn send(&self, config: &Config, bearer: &Secret) -> Result<PhotoSessionResponse, AccountError> {
    if config.client != ClientId::Camera {
      return Err(AccountError::NotConfigured);
    }
    let url = config.api_url(PHOTO_SESSION_PATH);
    if url.path() != PHOTO_SESSION_PATH
      || url.query().is_some()
      || url.fragment().is_some()
      || !url.username().is_empty()
      || url.password().is_some()
    {
      return Err(AccountError::InvalidConfig);
    }
    if url.scheme() != "https" {
      return Err(AccountError::InvalidConfig);
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = reqwest::blocking::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(5))
      .timeout(Duration::from_secs(10))
      .no_proxy();
    let builder = builder.https_only(true);
    let response = builder
      .build()
      .map_err(|_| AccountError::Network)?
      .post(url)
      .header("Accept", "application/json")
      .header("Content-Length", "0")
      .bearer_auth(bearer.expose())
      .body(Vec::new())
      .send()
      .map_err(|_| AccountError::Network)?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE)
      || response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        != Some("application/json")
    {
      return Err(AccountError::InvalidResponse);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
      .take(MAX_RESPONSE + 1)
      .read_to_end(&mut bytes)
      .map_err(|_| AccountError::Network)?;
    if bytes.len() as u64 > MAX_RESPONSE {
      return Err(AccountError::InvalidResponse);
    }
    let body = std::str::from_utf8(&bytes)
      .map(Secret::new)
      .map_err(|_| AccountError::InvalidResponse)?;
    Ok(PhotoSessionResponse { status, body })
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Actor {
  id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireIdentity {
  actor: Actor,
  session_id: String,
  session_epoch: String,
  expires_at: String,
  client_id: String,
  audience: String,
  refresh_required: bool,
}

pub(crate) fn parse_response(
  response: PhotoSessionResponse,
  now_ms: u64,
  expected_user_id: &str,
  expected_session_id: &str,
) -> Result<PhotoIdentity, AccountError> {
  if response.body.expose().len() as u64 > MAX_RESPONSE {
    return Err(AccountError::InvalidResponse);
  }
  if response.status != 200 {
    return Err(classify_rejection(response));
  }
  let wire: WireIdentity = serde_json::from_str(response.body.expose()).map_err(|_| AccountError::InvalidResponse)?;
  let expires_at_ms = parse_strict_iso(&wire.expires_at).ok_or(AccountError::InvalidResponse)?;
  if wire.client_id != ClientId::Camera.as_str()
    || wire.audience != PHOTO_AUDIENCE
    || wire.refresh_required
    || !opaque_id(&wire.actor.id)
    || !opaque_id(&wire.session_id)
    || !opaque_id(&wire.session_epoch)
    || wire.actor.id != expected_user_id
    || wire.session_id != expected_session_id
    || expires_at_ms <= now_ms
    || expires_at_ms > now_ms.saturating_add(MAX_LIFETIME_MS)
  {
    return Err(AccountError::InvalidResponse);
  }
  Ok(PhotoIdentity {
    user_id: wire.actor.id,
    session_id: wire.session_id,
    session_epoch: wire.session_epoch,
    transport: PhotoIdentityTransport::MacBearer,
    expires_at: wire.expires_at,
  })
}

fn classify_rejection(response: PhotoSessionResponse) -> AccountError {
  let value: serde_json::Value = serde_json::from_str(response.body.expose()).unwrap_or_default();
  let reason = value
    .get("details")
    .and_then(|details| details.get("reason"))
    .and_then(|reason| reason.as_str())
    .unwrap_or_default();
  let code = value.get("code").and_then(|code| code.as_str()).unwrap_or_default();
  if reason == "app_connect_disabled" {
    AccountError::Paused
  } else if matches!(
    reason,
    "app_connection_revoked"
      | "session_revoked"
      | "mac_connection_rejected"
      | "mac_token_invalid"
      | "mac_token_expired"
      | "mac_token_scope_invalid"
      | "mac_auth_time_invalid"
  ) {
    AccountError::Expired
  } else if code == "ACCOUNT_DELETED" || reason == "firebase_user_disabled" {
    AccountError::AccountUnavailable
  } else if response.status == 429 || response.status >= 500 {
    AccountError::Network
  } else {
    AccountError::Rejected
  }
}

fn opaque_id(value: &str) -> bool {
  !value.is_empty()
    && value == value.trim()
    && value.len() <= 256
    && !value
      .chars()
      .any(|character| character.is_control() || is_format_character(character))
}

fn is_format_character(character: char) -> bool {
  matches!(
    character as u32,
    0x00ad | 0x061c | 0x06dd | 0x070f | 0x08e2 | 0x180e | 0xfeff | 0x110bd | 0x110cd | 0xe0001
  ) || matches!(
    character as u32,
    0x0600..=0x0605
      | 0x0890..=0x0891
      | 0x17b4..=0x17b5
      | 0x200b..=0x200f
      | 0x202a..=0x202e
      | 0x2060..=0x2064
      | 0x2066..=0x206f
      | 0xfff9..=0xfffb
      | 0x13430..=0x1343f
      | 0x1bca0..=0x1bca3
      | 0x1d173..=0x1d17a
      | 0xe0020..=0xe007f
  )
}

fn parse_strict_iso(value: &str) -> Option<u64> {
  let bytes = value.as_bytes();
  if bytes.len() != 24
    || bytes[4] != b'-'
    || bytes[7] != b'-'
    || bytes[10] != b'T'
    || bytes[13] != b':'
    || bytes[16] != b':'
    || bytes[19] != b'.'
    || bytes[23] != b'Z'
  {
    return None;
  }
  let year = digits(bytes, 0, 4)?;
  let month = digits(bytes, 5, 2)?;
  let day = digits(bytes, 8, 2)?;
  let hour = digits(bytes, 11, 2)?;
  let minute = digits(bytes, 14, 2)?;
  let second = digits(bytes, 17, 2)?;
  let millis = digits(bytes, 20, 3)?;
  if year < 1970 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
    return None;
  }
  let month_days = [
    31,
    if leap_year(year) { 29 } else { 28 },
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if day == 0 || day > month_days[(month - 1) as usize] {
    return None;
  }
  let days_before_year = (1970..year)
    .map(|value| if leap_year(value) { 366_u64 } else { 365 })
    .sum::<u64>();
  let days_before_month = month_days[..(month - 1) as usize]
    .iter()
    .map(|value| u64::from(*value))
    .sum::<u64>();
  days_before_year
    .checked_add(days_before_month)?
    .checked_add(u64::from(day - 1))?
    .checked_mul(86_400_000)?
    .checked_add(u64::from(hour) * 3_600_000)?
    .checked_add(u64::from(minute) * 60_000)?
    .checked_add(u64::from(second) * 1000)?
    .checked_add(u64::from(millis))
}

fn digits(bytes: &[u8], start: usize, count: usize) -> Option<u32> {
  bytes.get(start..start + count)?.iter().try_fold(0_u32, |value, byte| {
    byte.is_ascii_digit().then(|| value * 10 + u32::from(*byte - b'0'))
  })
}

fn leap_year(year: u32) -> bool {
  year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}
