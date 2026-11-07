//! 共有アルバム（`/cloud/sharing/v1`、Epic #240 / B08 #249）の Mac の native 通信。画面の共有の client
//! （`@niho/photo-cloud-library` の `SharingTransport`）が route の表で作った要求を受け、本人クラウド v2 と同じく、
//! 資格・宛先・upload の ticket を native に閉じる（`niho_desktop_account` の `photo_sharing_*`）。
//!
//! - 宛先は固定の origin と build の設定（`NIHO_PHOTO_SHARING_API_PREFIX`）の上流の prefix だけ。未設定の公開の build では
//!   `camera_sharing_status` が閉じていると答え、画面は共有アルバムを出さない。
//! - upload の ticket は native に置き、画面には `https://upload.native.invalid/<handle>` の代わりを渡す。完成写真の bytes は
//!   raw IPC で受け、native が ticket の先へ送る。
//! - download（完成写真・thumbnail）は native で SHA-256 と長さを確かめてから、handle で 1MiB ずつ渡す。

use crate::account::SharedAccount;
use niho_desktop_account::{
  photo_ephemeral_id, sharing_ticket_handle, AccountError, NativeUploadTicket, PhotoDownloadCancel, PhotoScopeCapture,
  SharingContentMetadata, SharingRequest, SharingUploadTicket, SHARING_CONTENT_MAX,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const MAX_TICKETS: usize = 16;
const TICKET_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_CONTENTS: usize = 4;
const MAX_CONTENT_HELD: usize = 256 * 1024 * 1024;
const CONTENT_TTL: Duration = Duration::from_secs(5 * 60);
const READ_CHUNK: usize = 1024 * 1024;
/// raw IPC の upload の添え書き（`{ scope, ticketUrl, contentType }`）。
pub const UPLOAD_HEADER: &str = "x-niho-photo-sharing-upload";

struct HeldTicket {
  scope: PhotoScopeCapture,
  ticket: NativeUploadTicket,
  held_at: Instant,
}

struct HeldContent {
  scope: PhotoScopeCapture,
  bytes: Vec<u8>,
  held_at: Instant,
}

#[derive(Default)]
pub struct PhotoSharingState {
  tickets: Mutex<HashMap<String, HeldTicket>>,
  contents: Mutex<HashMap<String, HeldContent>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl PhotoSharingState {
  fn hold_tickets(&self, scope: &PhotoScopeCapture, tickets: &[SharingUploadTicket]) {
    let mut held = lock(&self.tickets);
    held.retain(|_, ticket| ticket.held_at.elapsed() < TICKET_TTL);
    for ticket in tickets {
      while held.len() >= MAX_TICKETS {
        let oldest = held
          .iter()
          .min_by_key(|(_, ticket)| ticket.held_at)
          .map(|(handle, _)| handle.clone());
        match oldest {
          Some(handle) => {
            held.remove(&handle);
          }
          None => break,
        }
      }
      held.insert(
        ticket.handle.clone(),
        HeldTicket {
          scope: scope.clone(),
          ticket: ticket.ticket.clone(),
          held_at: Instant::now(),
        },
      );
    }
  }

  fn ticket(&self, handle: &str, scope: &PhotoScopeCapture) -> Result<NativeUploadTicket, AccountError> {
    let held = lock(&self.tickets);
    let ticket = held.get(handle).ok_or(AccountError::Expired)?;
    if &ticket.scope != scope || ticket.held_at.elapsed() >= TICKET_TTL {
      return Err(AccountError::Expired);
    }
    Ok(ticket.ticket.clone())
  }

  fn release_ticket(&self, handle: &str) {
    lock(&self.tickets).remove(handle);
  }

  fn hold_content(&self, scope: &PhotoScopeCapture, bytes: Vec<u8>) -> Result<String, AccountError> {
    let handle = photo_ephemeral_id()?;
    let mut held = lock(&self.contents);
    held.retain(|_, content| content.held_at.elapsed() < CONTENT_TTL);
    loop {
      let total: usize = held.values().map(|content| content.bytes.len()).sum();
      if held.len() < MAX_CONTENTS && total + bytes.len() <= MAX_CONTENT_HELD {
        break;
      }
      let oldest = held
        .iter()
        .min_by_key(|(_, content)| content.held_at)
        .map(|(handle, _)| handle.clone());
      match oldest {
        Some(handle) => {
          held.remove(&handle);
        }
        None => return Err(AccountError::Busy),
      }
    }
    held.insert(
      handle.clone(),
      HeldContent {
        scope: scope.clone(),
        bytes,
        held_at: Instant::now(),
      },
    );
    Ok(handle)
  }

  fn read_content(&self, handle: &str, scope: &PhotoScopeCapture, offset: usize) -> Result<Vec<u8>, AccountError> {
    let held = lock(&self.contents);
    let content = held.get(handle).ok_or(AccountError::Expired)?;
    if &content.scope != scope || content.held_at.elapsed() >= CONTENT_TTL || offset > content.bytes.len() {
      return Err(AccountError::Expired);
    }
    let end = (offset + READ_CHUNK).min(content.bytes.len());
    Ok(content.bytes[offset..end].to_vec())
  }

  fn release_content(&self, handle: &str) {
    lock(&self.contents).remove(handle);
  }
}

pub fn install(app: &AppHandle) {
  app.manage(Arc::new(PhotoSharingState::default()));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingStatus {
  configured: bool,
}

/// 共有アルバムの通信が開いているか（build の設定の上流の prefix があるか）。
#[tauri::command]
pub fn camera_sharing_status(account: State<'_, Arc<SharedAccount>>) -> SharingStatus {
  SharingStatus {
    configured: account.account.sharing_configured(),
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingRequestInput {
  scope: PhotoScopeCapture,
  method: String,
  path: String,
  body: Option<Value>,
  idempotency_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingResponseOutput {
  status: u16,
  body: Value,
}

/// route の表の 1 つの要求（JSON）。upload の ticket は native に置き、代わりを返す。
#[tauri::command]
pub async fn camera_sharing_request(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
  state: State<'_, Arc<PhotoSharingState>>,
  input: SharingRequestInput,
) -> Result<SharingResponseOutput, AccountError> {
  let generation = account.begin_photo_operation()?;
  let account = Arc::clone(account.inner());
  let state = Arc::clone(state.inner());
  let request = SharingRequest::parse(&input.method, &input.path, input.body, input.idempotency_key)?;
  let scope = input.scope.clone();
  let worker = Arc::clone(&account);
  let response = tauri::async_runtime::spawn_blocking(move || worker.account.photo_sharing_request(&scope, &request))
    .await
    .map_err(|_| AccountError::Internal)?;
  let current = account.ensure_photo_operation_current(generation);
  account.observe(&app);
  // 閉じた 401 は画面へ届けて scope を失効させる（v2 と同じ）。それ以外は今の操作であることを確かめる
  let response = match response {
    Ok(response) if response.status == 401 => response,
    other => {
      current?;
      other?
    }
  };
  state.hold_tickets(&input.scope, &response.tickets);
  Ok(SharingResponseOutput {
    status: response.status,
    body: response.body,
  })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadInput {
  scope: PhotoScopeCapture,
  ticket_url: String,
  content_type: String,
}

/// 完成写真の bytes（raw IPC）を、native に置いた ticket の先へ送る。
#[tauri::command]
pub async fn camera_sharing_upload(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), AccountError> {
  let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
    return Err(AccountError::InvalidResponse);
  };
  if body.is_empty() || body.len() as u64 > SHARING_CONTENT_MAX {
    return Err(AccountError::InvalidResponse);
  }
  let metadata = request
    .headers()
    .get(UPLOAD_HEADER)
    .and_then(|value| value.to_str().ok())
    .filter(|value| value.len() <= 8192)
    .ok_or(AccountError::InvalidResponse)?;
  let input: UploadInput = serde_json::from_str(metadata).map_err(|_| AccountError::InvalidResponse)?;
  let handle = sharing_ticket_handle(&input.ticket_url)
    .ok_or(AccountError::InvalidResponse)?
    .to_owned();
  let state = app.state::<Arc<PhotoSharingState>>().inner().clone();
  let ticket = state.ticket(&handle, &input.scope)?;
  if ticket.content_type() != input.content_type || ticket.size_bytes() != body.len() as u64 {
    return Err(AccountError::InvalidResponse);
  }
  let shared = app.state::<Arc<SharedAccount>>().inner().clone();
  let generation = shared.begin_photo_operation()?;
  let bytes = body.to_vec();
  let scope = input.scope.clone();
  let worker = Arc::clone(&shared);
  let result =
    tauri::async_runtime::spawn_blocking(move || worker.account.photo_sharing_upload(&scope, &ticket, &bytes))
      .await
      .map_err(|_| AccountError::Internal)?;
  let current = shared.ensure_photo_operation_current(generation);
  shared.observe(&app);
  current?;
  result?;
  state.release_ticket(&handle);
  Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentOpenInput {
  scope: PhotoScopeCapture,
  path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentOpenOutput {
  handle: String,
  content_type: String,
  sha256: String,
  total_bytes: u64,
}

/// 完成写真・thumbnail を読み、照合してから handle で渡す。
#[tauri::command]
pub async fn camera_sharing_content_open(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
  state: State<'_, Arc<PhotoSharingState>>,
  input: ContentOpenInput,
) -> Result<ContentOpenOutput, AccountError> {
  let generation = account.begin_photo_operation()?;
  let account = Arc::clone(account.inner());
  let state = Arc::clone(state.inner());
  let request = SharingRequest::parse("GET", &input.path, None, None)?;
  let scope = input.scope.clone();
  let worker = Arc::clone(&account);
  let result = tauri::async_runtime::spawn_blocking(move || {
    let mut bytes = Vec::new();
    worker
      .account
      .photo_sharing_content(&scope, &request, &mut bytes, &PhotoDownloadCancel::default())
      .map(|metadata| (metadata, bytes))
  })
  .await
  .map_err(|_| AccountError::Internal)?;
  let current = account.ensure_photo_operation_current(generation);
  account.observe(&app);
  current?;
  let (metadata, bytes): (SharingContentMetadata, Vec<u8>) = result?;
  let handle = state.hold_content(&input.scope, bytes)?;
  Ok(ContentOpenOutput {
    handle,
    content_type: metadata.content_type,
    sha256: metadata.sha256,
    total_bytes: metadata.total_bytes,
  })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentReadInput {
  scope: PhotoScopeCapture,
  handle: String,
  offset: u64,
}

/// 開いた content の続きを最大 1MiB（raw の bytes。空なら終わり）。
#[tauri::command]
pub fn camera_sharing_content_read(
  account: State<'_, Arc<SharedAccount>>,
  state: State<'_, Arc<PhotoSharingState>>,
  input: ContentReadInput,
) -> Result<tauri::ipc::Response, AccountError> {
  account.account.photo_scope_current(&input.scope)?;
  let offset = usize::try_from(input.offset).map_err(|_| AccountError::InvalidResponse)?;
  Ok(tauri::ipc::Response::new(state.read_content(
    &input.handle,
    &input.scope,
    offset,
  )?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCloseInput {
  handle: String,
}

#[tauri::command]
pub fn camera_sharing_content_close(state: State<'_, Arc<PhotoSharingState>>, input: ContentCloseInput) {
  state.release_content(&input.handle);
}

#[cfg(test)]
mod tests {
  use super::*;
  use niho_desktop_account::PhotoIdentityTransport;

  fn scope(user: &str) -> PhotoScopeCapture {
    PhotoScopeCapture {
      user_id: user.into(),
      session_id: "synthetic-session".into(),
      session_epoch: "1".into(),
      transport: PhotoIdentityTransport::MacBearer,
    }
  }

  #[test]
  fn content_is_read_in_chunks_only_by_the_same_scope() {
    let state = PhotoSharingState::default();
    let bytes = vec![3_u8; READ_CHUNK + 10];
    let handle = state.hold_content(&scope("a"), bytes).unwrap();
    assert_eq!(state.read_content(&handle, &scope("a"), 0).unwrap().len(), READ_CHUNK);
    assert_eq!(state.read_content(&handle, &scope("a"), READ_CHUNK).unwrap().len(), 10);
    assert!(state
      .read_content(&handle, &scope("a"), READ_CHUNK + 10)
      .unwrap()
      .is_empty());
    assert_eq!(state.read_content(&handle, &scope("b"), 0), Err(AccountError::Expired));
    state.release_content(&handle);
    assert_eq!(state.read_content(&handle, &scope("a"), 0), Err(AccountError::Expired));
  }

  #[test]
  fn held_content_is_bounded() {
    let state = PhotoSharingState::default();
    let handles: Vec<String> = (0..MAX_CONTENTS + 2)
      .map(|_| state.hold_content(&scope("a"), vec![1_u8; 8]).unwrap())
      .collect();
    let live = handles
      .iter()
      .filter(|handle| state.read_content(handle, &scope("a"), 0).is_ok())
      .count();
    assert_eq!(live, MAX_CONTENTS);
  }

  #[test]
  fn the_upload_header_name_is_lowercase_for_tauri() {
    assert_eq!(UPLOAD_HEADER, UPLOAD_HEADER.to_ascii_lowercase());
  }
}
