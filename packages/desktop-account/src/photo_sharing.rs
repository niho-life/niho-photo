//! 共有アルバム（`/cloud/sharing/v1`、Epic #240 / B08 #249）の native 通信。route の表と応答の意味の検査は画面の
//! 共有の client（`@niho/photo-cloud-library` の `SharingWire`）が持ち、ここは本人クラウド v2 の native と同じく、
//! 資格・宛先・upload の ticket を native に閉じる。
//!
//! - 宛先は固定の origin と build の設定の上流の prefix（`Config::with_sharing_prefix`）だけ。画面が渡すのは route の表で
//!   作った `/cloud/sharing/v1/...` の path・query・body・冪等 key で、形を確かめてから prefix を付け替える。BFF だけの
//!   経路（保留の招待）は送らない。
//! - 応答は大きさ・JSON の深さを確かめる。upload の ticket（bearer の URL）は native に取り出し、画面へは
//!   `https://upload.native.invalid/<handle>` の形の代わりを渡す。ticket・token・URL がほかに残っていれば拒む。
//! - 完成写真の upload は native が ticket の先へ 8MiB ずつ送り、download は SHA-256 と長さを確かめてから渡す。

use crate::photo_cloud::{
  parse_ticket, valid_content_type, valid_key, validate_json_shape, validate_no_transport_material, NativePhotoRequest,
  PhotoHttpResponse,
};
use crate::{AccountError, Config, NativeUploadTicket, PhotoDownloadCancel, PhotoScopeCapture};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use zeroize::Zeroizing;

/// 画面の route の表の prefix（`SHARING_CLOUD_PATH_PREFIX`）。
pub const SHARING_ROUTE_PREFIX: &str = "/cloud/sharing/v1";
/// 画面へ渡す ticket の代わりの host（`.invalid` は名前解決されない）。
pub const SHARING_TICKET_HOST: &str = "upload.native.invalid";

const JSON_MAX: u64 = 4 * 1024 * 1024;
const ERROR_MAX: u64 = 64 * 1024;
const BODY_MAX: usize = 256 * 1024;
const SUFFIX_MAX: usize = 1024;
const QUERY_MAX: usize = 1024;
const SEGMENT_MAX: usize = 512;
const MAX_DEPTH: usize = 38;
const MAX_TICKETS: usize = 4;
pub const SHARING_CONTENT_MAX: u64 = 200 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SharingMethod {
  Get,
  Post,
  Put,
  Delete,
}

impl SharingMethod {
  fn as_str(self) -> &'static str {
    match self {
      Self::Get => "GET",
      Self::Post => "POST",
      Self::Put => "PUT",
      Self::Delete => "DELETE",
    }
  }
}

/// 画面が route の表で作った 1 つの要求。
#[derive(Clone, Debug)]
pub struct SharingRequest {
  method: SharingMethod,
  suffix: String,
  query: Option<String>,
  body: Option<Vec<u8>>,
  idempotency_key: Option<String>,
}

fn segment_ok(segment: &str) -> bool {
  if segment.is_empty() || segment.len() > SEGMENT_MAX || segment == "." || segment == ".." {
    return false;
  }
  let bytes = segment.as_bytes();
  let mut index = 0;
  let mut decoded = Vec::with_capacity(bytes.len());
  while index < bytes.len() {
    let byte = bytes[index];
    if byte == b'%' {
      let hex = segment
        .get(index + 1..index + 3)
        .filter(|pair| pair.bytes().all(|b| b.is_ascii_hexdigit()))
        .and_then(|pair| u8::from_str_radix(pair, 16).ok());
      let Some(value) = hex else {
        return false;
      };
      decoded.push(value);
      index += 3;
      continue;
    }
    // encodeURIComponent の出力（opaque segment）
    if !(byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte)) {
      return false;
    }
    decoded.push(byte);
    index += 1;
  }
  // 復号して別の区切り・親への移動にならないこと
  !(decoded == b"." || decoded == b".." || decoded.contains(&b'/') || decoded.contains(&b'\\') || decoded.contains(&0))
}

fn query_ok(query: &str) -> bool {
  !query.is_empty()
    && query.len() <= QUERY_MAX
    && query.split('&').all(|pair| {
      let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
      !key.is_empty()
        && key.bytes().all(|b| b.is_ascii_alphanumeric())
        && value
          .bytes()
          .all(|b| b.is_ascii_alphanumeric() || b"-_.~%+*!'()".contains(&b))
    })
}

impl SharingRequest {
  /// `path` は `/cloud/sharing/v1/...`（query を含んでよい）。GET・DELETE は body なし、POST・PUT は JSON の object。
  pub fn parse(
    method: &str,
    path: &str,
    body: Option<Value>,
    idempotency_key: Option<String>,
  ) -> Result<Self, AccountError> {
    let method = match method {
      "GET" => SharingMethod::Get,
      "POST" => SharingMethod::Post,
      "PUT" => SharingMethod::Put,
      "DELETE" => SharingMethod::Delete,
      _ => return Err(AccountError::InvalidResponse),
    };
    let rest = path
      .strip_prefix(SHARING_ROUTE_PREFIX)
      .filter(|rest| rest.starts_with('/'))
      .ok_or(AccountError::InvalidResponse)?;
    let (suffix, query) = match rest.split_once('?') {
      Some((suffix, query)) => (suffix, Some(query)),
      None => (rest, None),
    };
    if suffix.len() > SUFFIX_MAX
      || !suffix[1..].split('/').all(segment_ok)
      || query.is_some_and(|query| !query_ok(query))
    {
      return Err(AccountError::InvalidResponse);
    }
    // 保留の招待は BFF だけの経路（native には cookie がない）
    if suffix == "/invites/pending" || suffix.starts_with("/invites/pending/") {
      return Err(AccountError::InvalidResponse);
    }
    let body = match (method, body) {
      (SharingMethod::Get | SharingMethod::Delete, None) => None,
      (SharingMethod::Post | SharingMethod::Put, Some(value @ Value::Object(_))) => {
        validate_json_shape(&value, 0, MAX_DEPTH)?;
        let bytes = serde_json::to_vec(&value).map_err(|_| AccountError::Internal)?;
        if bytes.len() > BODY_MAX {
          return Err(AccountError::InvalidResponse);
        }
        Some(bytes)
      }
      _ => return Err(AccountError::InvalidResponse),
    };
    if idempotency_key
      .as_deref()
      .is_some_and(|key| method == SharingMethod::Get || !valid_key(key))
    {
      return Err(AccountError::InvalidResponse);
    }
    Ok(Self {
      method,
      suffix: suffix.to_owned(),
      query: query.map(str::to_owned),
      body,
      idempotency_key,
    })
  }

  pub fn is_get(&self) -> bool {
    self.method == SharingMethod::Get
  }

  /// 上流の固定の宛先（origin と build の設定の prefix）。
  pub(crate) fn native(
    &self,
    config: &Config,
    capture: &PhotoScopeCapture,
  ) -> Result<NativePhotoRequest, AccountError> {
    let prefix = config.sharing_prefix().ok_or(AccountError::NotConfigured)?;
    let mut url = config.api_url(&format!("{prefix}{}", self.suffix));
    url.set_query(self.query.as_deref());
    Ok(NativePhotoRequest {
      method: self.method.as_str(),
      url,
      body: self.body.clone(),
      idempotency_key: self.idempotency_key.clone(),
      capture: capture.clone(),
    })
  }
}

/// upload の ticket（native に留める）と、画面へ渡した代わりの handle。
#[derive(Clone)]
pub struct SharingUploadTicket {
  pub handle: String,
  pub upload_id: String,
  pub ticket: NativeUploadTicket,
}

#[derive(Clone, Serialize)]
pub struct SharingJsonResponse {
  pub status: u16,
  pub body: Value,
  #[serde(skip)]
  pub tickets: Vec<SharingUploadTicket>,
}

fn random_handle() -> Result<String, AccountError> {
  let mut bytes = [0_u8; 16];
  getrandom::fill(&mut bytes).map_err(|_| AccountError::Internal)?;
  Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn placeholder(handle: &str, ticket: &NativeUploadTicket) -> Value {
  serde_json::json!({
    "url": format!("https://{SHARING_TICKET_HOST}/{handle}"),
    "method": "PUT",
    "headers": {},
    "expiresAt": ticket.expires_at,
    "resumeOffsetBytes": ticket.resume_offset_bytes,
  })
}

/// `{ upload: { id, sizeBytes, ... }, ticket: {...} }` の ticket を取り出して null にする（深さは JSON の検査で制限済み）。
fn take_tickets(value: &mut Value, found: &mut Vec<(String, NativeUploadTicket)>) -> Result<(), AccountError> {
  match value {
    Value::Array(values) => {
      for value in values {
        take_tickets(value, found)?;
      }
    }
    Value::Object(map) => {
      if map.get("ticket").is_some_and(Value::is_object) {
        let upload = map
          .get("upload")
          .and_then(Value::as_object)
          .ok_or(AccountError::InvalidResponse)?;
        let upload_id = upload
          .get("id")
          .and_then(Value::as_str)
          .filter(|id| !id.is_empty() && id.len() <= 512)
          .ok_or(AccountError::InvalidResponse)?
          .to_owned();
        let size_bytes = upload
          .get("sizeBytes")
          .and_then(Value::as_u64)
          .filter(|size| *size > 0 && *size <= SHARING_CONTENT_MAX)
          .ok_or(AccountError::InvalidResponse)?;
        let raw = map.get("ticket").cloned().unwrap_or(Value::Null);
        let content_type = ticket_content_type(&raw)?;
        let ticket = parse_ticket(&raw, &content_type, size_bytes)?;
        if found.len() >= MAX_TICKETS {
          return Err(AccountError::InvalidResponse);
        }
        map.insert("ticket".into(), Value::Null);
        found.push((upload_id, ticket));
      }
      for (key, child) in map.iter_mut() {
        if key != "ticket" {
          take_tickets(child, found)?;
        }
      }
    }
    _ => {}
  }
  Ok(())
}

fn ticket_content_type(ticket: &Value) -> Result<String, AccountError> {
  let content_type = ticket
    .get("headers")
    .and_then(Value::as_object)
    .and_then(|headers| {
      headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
        .and_then(|(_, value)| value.as_str())
    })
    .ok_or(AccountError::InvalidResponse)?;
  if !valid_content_type(content_type) || !matches!(content_type, "image/jpeg" | "image/png") {
    return Err(AccountError::InvalidResponse);
  }
  Ok(content_type.to_owned())
}

/// 置いた null を、取り出した順に代わりの ticket へ戻す。
fn put_placeholders(value: &mut Value, tickets: &[SharingUploadTicket], next: &mut usize) {
  match value {
    Value::Array(values) => {
      for value in values {
        put_placeholders(value, tickets, next);
      }
    }
    Value::Object(map) => {
      let carries = map.get("ticket").is_some_and(Value::is_null)
        && map
          .get("upload")
          .and_then(Value::as_object)
          .and_then(|upload| upload.get("id"))
          .and_then(Value::as_str)
          .is_some_and(|id| tickets.get(*next).is_some_and(|ticket| ticket.upload_id == id));
      if carries {
        let ticket = &tickets[*next];
        map.insert("ticket".into(), placeholder(&ticket.handle, &ticket.ticket));
        *next += 1;
      }
      for (key, child) in map.iter_mut() {
        if key != "ticket" {
          put_placeholders(child, tickets, next);
        }
      }
    }
    _ => {}
  }
}

/// 応答の JSON を読み、ticket を native に取り出して代わりを置く。
pub(crate) fn read_sharing_json(response: PhotoHttpResponse) -> Result<SharingJsonResponse, AccountError> {
  let success = (200..300).contains(&response.status);
  let limit = if success { JSON_MAX } else { ERROR_MAX };
  if response.content_length.is_some_and(|value| value > limit)
    || response
      .content_type
      .as_deref()
      .and_then(|value| value.split(';').next())
      != Some("application/json")
  {
    return Err(AccountError::InvalidResponse);
  }
  let mut bytes = Zeroizing::new(Vec::new());
  response
    .body
    .take(limit + 1)
    .read_to_end(&mut bytes)
    .map_err(|_| AccountError::Network)?;
  if bytes.len() as u64 > limit {
    return Err(AccountError::InvalidResponse);
  }
  let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| AccountError::InvalidResponse)?;
  validate_json_shape(&value, 0, MAX_DEPTH)?;
  if !value.is_object() {
    return Err(AccountError::InvalidResponse);
  }
  let mut tickets = Vec::new();
  if success {
    let mut found = Vec::new();
    take_tickets(&mut value, &mut found)?;
    for (upload_id, ticket) in found {
      tickets.push(SharingUploadTicket {
        handle: random_handle()?,
        upload_id,
        ticket,
      });
    }
  }
  // ticket を取り出した後に、ほかの資格・URL が残っていれば渡さない
  validate_no_transport_material(&value, false)?;
  let mut next = 0;
  put_placeholders(&mut value, &tickets, &mut next);
  if next != tickets.len() {
    return Err(AccountError::InvalidResponse);
  }
  Ok(SharingJsonResponse {
    status: response.status,
    body: value,
    tickets,
  })
}

/// error の JSON の `error.code`。
pub(crate) fn error_code(value: &Value) -> Option<&str> {
  value
    .get("error")
    .and_then(|error| error.get("code"))
    .and_then(Value::as_str)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingContentMetadata {
  pub content_type: String,
  pub sha256: String,
  pub total_bytes: u64,
}

/// 完成写真・thumbnail の bytes を、宣言の SHA-256・長さ・形式と照合しながら書く。
pub(crate) fn stream_sharing_content<W: Write>(
  mut response: PhotoHttpResponse,
  writer: &mut W,
  cancel: &PhotoDownloadCancel,
  mut current: impl FnMut() -> Result<(), AccountError>,
) -> Result<SharingContentMetadata, AccountError> {
  let total_bytes = response
    .total_bytes
    .as_deref()
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|value| *value > 0 && *value <= SHARING_CONTENT_MAX)
    .ok_or(AccountError::InvalidResponse)?;
  let sha256 = response
    .sha256
    .clone()
    .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .ok_or(AccountError::InvalidResponse)?;
  let content_type = response
    .content_type
    .clone()
    .filter(|value| matches!(value.as_str(), "image/jpeg" | "image/png"))
    .ok_or(AccountError::InvalidResponse)?;
  if response.status != 200 || response.content_length.is_some_and(|length| length != total_bytes) {
    return Err(AccountError::InvalidResponse);
  }
  let mut hasher = Sha256::new();
  let mut total = 0_u64;
  let mut buffer = vec![0_u8; 64 * 1024];
  loop {
    cancel.check()?;
    current()?;
    let count = response.body.read(&mut buffer).map_err(|_| AccountError::Network)?;
    if count == 0 {
      break;
    }
    total = total.checked_add(count as u64).ok_or(AccountError::InvalidResponse)?;
    if total > total_bytes {
      return Err(AccountError::InvalidResponse);
    }
    hasher.update(&buffer[..count]);
    writer.write_all(&buffer[..count]).map_err(|_| AccountError::Storage)?;
  }
  cancel.check()?;
  current()?;
  let digest = format!("{:x}", hasher.finalize());
  if total != total_bytes || !crate::connect::equal(&digest, &sha256) {
    return Err(AccountError::InvalidResponse);
  }
  writer.flush().map_err(|_| AccountError::Storage)?;
  Ok(SharingContentMetadata {
    content_type,
    sha256,
    total_bytes,
  })
}

/// 画面へ渡した代わりの ticket の URL から handle を取り出す。
pub fn sharing_ticket_handle(url: &str) -> Option<&str> {
  let handle = url.strip_prefix(&format!("https://{SHARING_TICKET_HOST}/"))?;
  (handle.len() == 32 && handle.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(handle)
}

#[cfg(test)]
#[path = "photo_sharing_tests.rs"]
mod tests;
