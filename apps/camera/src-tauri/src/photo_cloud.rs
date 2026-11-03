use crate::account::SharedAccount;
use niho_desktop_account::{
  photo_ephemeral_id, AccountError, PhotoContentMetadata, PhotoDownloadCancel, PhotoJsonResponse, PhotoOperation,
  PhotoRequest, PhotoScopeCapture,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const CACHE_DIR: &str = "photo-cloud-content";
const CACHE_BUDGET: u64 = 512 * 1024 * 1024;
const MAX_HANDLES: usize = 4;
const MAX_CHUNK: usize = 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const HANDLE_TTL: Duration = Duration::from_secs(5 * 60);
const WAITER_DEADLINE: Duration = Duration::from_secs(15);
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(15);
const MAX_EARLY_CANCELS: usize = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CameraPhotoRequest {
  scope: PhotoScopeCapture,
  operation: PhotoOperation,
  request: Value,
  idempotency_key: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentRange {
  start: u64,
  end_inclusive: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentOpenRequest {
  scope: PhotoScopeCapture,
  request_id: String,
  photo_id: String,
  asset_id: String,
  range: Option<ContentRange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentOpenResponse {
  handle: String,
  content_type: String,
  sha256: String,
  total_bytes: u64,
  range: ContentRange,
  size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentReadRequest {
  scope: PhotoScopeCapture,
  handle: String,
  offset: u64,
  max_bytes: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCloseRequest {
  scope: PhotoScopeCapture,
  handle: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCancelRequest {
  scope: PhotoScopeCapture,
  request_id: String,
}

struct CacheEntry {
  path: PathBuf,
  file: File,
  metadata: PhotoContentMetadata,
  scope: PhotoScopeCapture,
  range: ContentRange,
  offset: u64,
  created: Instant,
}

struct Download {
  operation_id: u64,
  scope: PhotoScopeCapture,
  photo_id: String,
  cancel: DownloadCancel,
  reserved_bytes: u64,
  active: bool,
}

#[derive(Clone)]
struct DownloadCancel {
  native: PhotoDownloadCancel,
  cancelled: Arc<AtomicBool>,
}

impl Default for DownloadCancel {
  fn default() -> Self {
    Self {
      native: PhotoDownloadCancel::default(),
      cancelled: Arc::new(AtomicBool::new(false)),
    }
  }
}

impl DownloadCancel {
  fn cancel(&self) {
    self.cancelled.store(true, Ordering::SeqCst);
    self.native.cancel();
  }

  fn check(&self) -> Result<(), AccountError> {
    if self.cancelled.load(Ordering::SeqCst) {
      Err(AccountError::Cancelled)
    } else {
      Ok(())
    }
  }

  fn native(&self) -> PhotoDownloadCancel {
    self.native.clone()
  }
}

struct EarlyCancel {
  scope: PhotoScopeCapture,
  created: Instant,
}

#[derive(Default)]
struct CacheInner {
  handles: HashMap<String, CacheEntry>,
  downloads: HashMap<String, Download>,
  early_cancels: HashMap<String, EarlyCancel>,
  reserved_bytes: u64,
  active_download: bool,
  next_operation_id: u64,
}

pub(crate) struct PhotoCloudState {
  root: Option<PathBuf>,
  inner: Mutex<CacheInner>,
  gate: Condvar,
}

impl PhotoCloudState {
  fn new(root: PathBuf) -> Result<Self, AccountError> {
    prepare_root(&root)?;
    Ok(Self {
      root: Some(root),
      inner: Mutex::new(CacheInner::default()),
      gate: Condvar::new(),
    })
  }

  fn disabled() -> Self {
    Self {
      root: None,
      inner: Mutex::new(CacheInner::default()),
      gate: Condvar::new(),
    }
  }

  pub(crate) fn abort_all(&self) {
    let entries = {
      let Ok(mut inner) = self.inner.lock() else { return };
      for download in inner.downloads.values() {
        download.cancel.cancel();
      }
      inner.early_cancels.clear();
      self.gate.notify_all();
      inner.reserved_bytes = inner.reserved_bytes.saturating_sub(
        inner
          .handles
          .values()
          .map(|entry| entry.metadata.size_bytes)
          .sum::<u64>(),
      );
      inner.handles.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
    };
    unlink_entries(entries);
  }

  fn invalidate_photo(&self, scope: &PhotoScopeCapture, photo_id: &str) {
    let entries = {
      let Ok(mut inner) = self.inner.lock() else { return };
      for download in inner
        .downloads
        .values()
        .filter(|download| download.scope == *scope && download.photo_id == photo_id)
      {
        download.cancel.cancel();
      }
      self.gate.notify_all();
      let handles = inner
        .handles
        .iter()
        .filter(|(_, entry)| entry.scope == *scope && entry.metadata.photo_id == photo_id)
        .map(|(handle, _)| handle.clone())
        .collect::<Vec<_>>();
      handles
        .into_iter()
        .filter_map(|handle| remove_entry(&mut inner, &handle))
        .collect::<Vec<_>>()
    };
    unlink_entries(entries);
  }

  pub(crate) fn purge_expired(&self) {
    let entries = {
      let Ok(mut inner) = self.inner.lock() else { return };
      let handles = inner
        .handles
        .iter()
        .filter(|(_, entry)| entry.created.elapsed() >= HANDLE_TTL)
        .map(|(handle, _)| handle.clone())
        .collect::<Vec<_>>();
      handles
        .into_iter()
        .filter_map(|handle| remove_entry(&mut inner, &handle))
        .collect::<Vec<_>>()
    };
    unlink_entries(entries);
  }

  fn register_download(
    self: &Arc<Self>,
    scope: PhotoScopeCapture,
    request_id: String,
    photo_id: String,
  ) -> Result<DownloadOperation, AccountError> {
    if self.root.is_none() {
      return Err(AccountError::Storage);
    }
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    purge_early_cancels(&mut inner);
    if inner.handles.len() >= MAX_HANDLES || inner.downloads.len() >= 3 || inner.downloads.contains_key(&request_id) {
      return Err(AccountError::Busy);
    }
    if inner
      .early_cancels
      .get(&request_id)
      .is_some_and(|early| early.scope != scope)
    {
      return Err(AccountError::Rejected);
    }
    inner.next_operation_id = inner.next_operation_id.checked_add(1).ok_or(AccountError::Internal)?;
    let operation_id = inner.next_operation_id;
    let cancel = DownloadCancel::default();
    if inner.early_cancels.remove(&request_id).is_some() {
      cancel.cancel();
    }
    inner.downloads.insert(
      request_id.clone(),
      Download {
        operation_id,
        scope,
        photo_id,
        cancel,
        reserved_bytes: 0,
        active: false,
      },
    );
    Ok(DownloadOperation {
      state: Arc::clone(self),
      request_id,
      operation_id,
    })
  }

  fn cancel_download(&self, scope: &PhotoScopeCapture, request_id: &str) -> Result<(), AccountError> {
    if self.root.is_none() {
      return Err(AccountError::Storage);
    }
    let mut inner = self.inner.lock().map_err(|_| AccountError::Internal)?;
    purge_early_cancels(&mut inner);
    if let Some(download) = inner.downloads.get(request_id) {
      if download.scope != *scope {
        return Err(AccountError::Rejected);
      }
      download.cancel.cancel();
      self.gate.notify_all();
      return Ok(());
    }
    if inner
      .early_cancels
      .get(request_id)
      .is_some_and(|early| early.scope != *scope)
    {
      return Err(AccountError::Rejected);
    }
    if inner.early_cancels.len() >= MAX_EARLY_CANCELS {
      let oldest = inner
        .early_cancels
        .iter()
        .min_by_key(|(_, cancel)| cancel.created)
        .map(|(request_id, _)| request_id.clone());
      if let Some(oldest) = oldest {
        inner.early_cancels.remove(&oldest);
      }
    }
    inner.early_cancels.insert(
      request_id.to_owned(),
      EarlyCancel {
        scope: scope.clone(),
        created: Instant::now(),
      },
    );
    Ok(())
  }
}

impl Drop for PhotoCloudState {
  fn drop(&mut self) {
    self.abort_all();
  }
}

struct DownloadOperation {
  state: Arc<PhotoCloudState>,
  request_id: String,
  operation_id: u64,
}

impl DownloadOperation {
  fn check(&self) -> Result<(), AccountError> {
    let inner = self.state.inner.lock().map_err(|_| AccountError::Internal)?;
    let download = self.current(&inner)?;
    download.cancel.check()
  }

  fn current_cancel(&self) -> Result<PhotoDownloadCancel, AccountError> {
    let inner = self.state.inner.lock().map_err(|_| AccountError::Internal)?;
    let download = self.current(&inner)?;
    download.cancel.check()?;
    Ok(download.cancel.native())
  }

  fn acquire(&self) -> Result<(), AccountError> {
    let deadline = Instant::now() + WAITER_DEADLINE;
    let mut inner = self.state.inner.lock().map_err(|_| AccountError::Internal)?;
    loop {
      self.current(&inner)?.cancel.check()?;
      if !inner.active_download {
        inner.active_download = true;
        self.current_mut(&mut inner)?.active = true;
        return Ok(());
      }
      let now = Instant::now();
      if now >= deadline {
        return Err(AccountError::Busy);
      }
      let (next, timeout) = self
        .state
        .gate
        .wait_timeout(inner, deadline - now)
        .map_err(|_| AccountError::Internal)?;
      inner = next;
      if timeout.timed_out() && inner.active_download {
        return Err(AccountError::Busy);
      }
    }
  }

  fn reserve(&self, bytes: u64) -> Result<(), AccountError> {
    let mut inner = self.state.inner.lock().map_err(|_| AccountError::Internal)?;
    self.current(&inner)?.cancel.check()?;
    if self.current(&inner)?.reserved_bytes != 0
      || inner.handles.len() >= MAX_HANDLES
      || inner
        .reserved_bytes
        .checked_add(bytes)
        .is_none_or(|value| value > CACHE_BUDGET)
    {
      return Err(AccountError::Busy);
    }
    inner.reserved_bytes += bytes;
    self.current_mut(&mut inner)?.reserved_bytes = bytes;
    Ok(())
  }

  fn install_handle(&self, handle: String, entry: CacheEntry) -> Result<(), AccountError> {
    let mut owned = Some(entry);
    let result = (|| {
      let mut inner = self.state.inner.lock().map_err(|_| AccountError::Internal)?;
      self.current(&inner)?.cancel.check()?;
      if inner.handles.len() >= MAX_HANDLES || inner.handles.contains_key(&handle) {
        return Err(AccountError::Busy);
      }
      let entry = owned.as_ref().ok_or(AccountError::Internal)?;
      let reserved = self.current(&inner)?.reserved_bytes;
      if reserved == 0 || reserved != entry.metadata.size_bytes {
        return Err(AccountError::Internal);
      }
      self.current_mut(&mut inner)?.reserved_bytes = 0;
      inner
        .handles
        .insert(handle, owned.take().ok_or(AccountError::Internal)?);
      Ok(())
    })();
    if let Some(entry) = owned {
      unlink_entries(vec![entry]);
    }
    result
  }

  fn current<'a>(&self, inner: &'a CacheInner) -> Result<&'a Download, AccountError> {
    inner
      .downloads
      .get(&self.request_id)
      .filter(|download| download.operation_id == self.operation_id)
      .ok_or(AccountError::Cancelled)
  }

  fn current_mut<'a>(&self, inner: &'a mut CacheInner) -> Result<&'a mut Download, AccountError> {
    inner
      .downloads
      .get_mut(&self.request_id)
      .filter(|download| download.operation_id == self.operation_id)
      .ok_or(AccountError::Cancelled)
  }
}

impl Drop for DownloadOperation {
  fn drop(&mut self) {
    if let Ok(mut inner) = self.state.inner.lock() {
      let is_current = inner
        .downloads
        .get(&self.request_id)
        .is_some_and(|download| download.operation_id == self.operation_id);
      if is_current {
        if let Some(download) = inner.downloads.remove(&self.request_id) {
          inner.reserved_bytes = inner.reserved_bytes.saturating_sub(download.reserved_bytes);
          if download.active {
            inner.active_download = false;
          }
        }
        self.state.gate.notify_all();
      }
    }
  }
}

fn purge_early_cancels(inner: &mut CacheInner) {
  inner
    .early_cancels
    .retain(|_, cancel| cancel.created.elapsed() < EARLY_CANCEL_TTL);
}

pub fn install(app: &AppHandle) {
  let state = app
    .path()
    .app_cache_dir()
    .map_err(|_| AccountError::Storage)
    .and_then(|root| PhotoCloudState::new(root.join(CACHE_DIR)))
    .unwrap_or_else(|_| PhotoCloudState::disabled());
  app.manage(Arc::new(state));
}

#[tauri::command]
pub async fn camera_photo_request(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
  cache: State<'_, Arc<PhotoCloudState>>,
  input: CameraPhotoRequest,
) -> Result<PhotoJsonResponse, AccountError> {
  let account = Arc::clone(account.inner());
  let cache = Arc::clone(cache.inner());
  let operation = input.operation;
  let delete_scope = input.scope.clone();
  let delete_photo_id = if operation == PhotoOperation::PhotosDelete {
    input.request.get("photoId").and_then(Value::as_str).map(str::to_owned)
  } else {
    None
  };
  let scope = input.scope.clone();
  let request = PhotoRequest::parse(input.operation, input.request, input.idempotency_key)?;
  let worker = Arc::clone(&account);
  let response = tauri::async_runtime::spawn_blocking(move || worker.account.photo_request(&scope, &request))
    .await
    .map_err(|_| AccountError::Internal)??;
  if response.status == 200 {
    if let Some(photo_id) = delete_photo_id {
      cache.invalidate_photo(&delete_scope, &photo_id);
    }
  }
  account.observe(&app);
  Ok(response)
}

#[tauri::command]
pub async fn camera_photo_content_open(
  app: AppHandle,
  account: State<'_, Arc<SharedAccount>>,
  cache: State<'_, Arc<PhotoCloudState>>,
  input: ContentOpenRequest,
) -> Result<ContentOpenResponse, AccountError> {
  validate_id(&input.request_id)?;
  validate_id(&input.photo_id)?;
  validate_id(&input.asset_id)?;
  validate_range(input.range.as_ref())?;
  cache.purge_expired();
  let account = Arc::clone(account.inner());
  let cache = Arc::clone(cache.inner());
  account.account.photo_scope_current(&input.scope)?;
  let operation = cache.register_download(input.scope.clone(), input.request_id.clone(), input.photo_id.clone())?;
  operation.check()?;
  let response = tauri::async_runtime::spawn_blocking(move || open_content(&account, &cache, input, operation))
    .await
    .map_err(|_| AccountError::Internal)?;
  account.observe(&app);
  response
}

fn open_content(
  account: &SharedAccount,
  cache: &PhotoCloudState,
  input: ContentOpenRequest,
  operation: DownloadOperation,
) -> Result<ContentOpenResponse, AccountError> {
  operation.acquire()?;
  operation.check()?;
  let metadata = account
    .account
    .photo_content_metadata(&input.scope, &input.photo_id, &input.asset_id)?;
  operation.check()?;
  let range = resolved_range(input.range.clone(), metadata.size_bytes)?;
  operation.reserve(metadata.size_bytes)?;
  operation.check()?;
  let cancel = operation.current_cancel()?;
  let root = cache.root.as_deref().ok_or(AccountError::Storage)?;
  let (path, mut file) = create_cache_file(root)?;
  let downloaded = account
    .account
    .photo_content_download(&input.scope, &metadata, &mut file, &cancel);
  if let Err(error) = downloaded {
    drop(file);
    let _ = fs::remove_file(&path);
    return Err(error);
  }
  if file.seek(SeekFrom::Start(range.start)).is_err() {
    drop(file);
    let _ = fs::remove_file(&path);
    return Err(AccountError::Storage);
  }
  let handle = match photo_ephemeral_id() {
    Ok(handle) => handle,
    Err(error) => {
      drop(file);
      let _ = fs::remove_file(&path);
      return Err(error);
    }
  };
  let size_bytes = range.end_inclusive.unwrap_or(metadata.size_bytes - 1) - range.start + 1;
  let response = ContentOpenResponse {
    handle: handle.clone(),
    content_type: metadata.content_type.clone(),
    sha256: metadata.sha256.clone(),
    total_bytes: metadata.size_bytes,
    range: range.clone(),
    size_bytes,
  };
  if operation.check().is_err() {
    drop(file);
    let _ = fs::remove_file(&path);
    return Err(AccountError::Cancelled);
  }
  operation.install_handle(
    handle,
    CacheEntry {
      path,
      file,
      metadata,
      scope: input.scope.clone(),
      range,
      offset: 0,
      created: Instant::now(),
    },
  )?;
  Ok(response)
}

#[tauri::command]
pub fn camera_photo_content_read(
  account: State<'_, Arc<SharedAccount>>,
  cache: State<'_, Arc<PhotoCloudState>>,
  input: ContentReadRequest,
) -> Result<tauri::ipc::Response, AccountError> {
  if input.max_bytes == 0 || input.max_bytes as usize > MAX_CHUNK {
    return Err(AccountError::InvalidResponse);
  }
  cache.purge_expired();
  let mut inner = cache.inner.lock().map_err(|_| AccountError::Internal)?;
  let entry = inner.handles.get_mut(&input.handle).ok_or(AccountError::Expired)?;
  if entry.scope != input.scope || entry.offset != input.offset || entry.created.elapsed() >= HANDLE_TTL {
    return Err(AccountError::Cancelled);
  }
  let size = entry.range.end_inclusive.unwrap_or(entry.metadata.size_bytes - 1) - entry.range.start + 1;
  let remaining = size.saturating_sub(entry.offset);
  let count = remaining.min(u64::from(input.max_bytes)) as usize;
  let read = account.account.photo_content_read_guarded(&input.scope, || {
    let mut bytes = vec![0_u8; count];
    if count > 0 {
      entry.file.read_exact(&mut bytes).map_err(|_| AccountError::Storage)?;
      entry.offset += count as u64;
    }
    Ok(bytes)
  });
  match read {
    Ok(bytes) => Ok(tauri::ipc::Response::new(bytes)),
    Err(error) => {
      let entry = remove_entry(&mut inner, &input.handle);
      drop(inner);
      if let Some(entry) = entry {
        unlink_entries(vec![entry]);
      }
      Err(error)
    }
  }
}

#[tauri::command]
pub fn camera_photo_content_close(
  cache: State<'_, Arc<PhotoCloudState>>,
  input: ContentCloseRequest,
) -> Result<(), AccountError> {
  let entry = {
    let mut inner = cache.inner.lock().map_err(|_| AccountError::Internal)?;
    let entry = inner.handles.get(&input.handle).ok_or(AccountError::Expired)?;
    if entry.scope != input.scope {
      return Err(AccountError::Rejected);
    }
    remove_entry(&mut inner, &input.handle).ok_or(AccountError::Expired)?
  };
  drop(entry.file);
  fs::remove_file(entry.path).map_err(|_| AccountError::Storage)
}

#[tauri::command]
pub fn camera_photo_content_cancel(
  account: State<'_, Arc<SharedAccount>>,
  cache: State<'_, Arc<PhotoCloudState>>,
  input: ContentCancelRequest,
) -> Result<(), AccountError> {
  validate_id(&input.request_id)?;
  account.account.photo_scope_current(&input.scope)?;
  cache.cancel_download(&input.scope, &input.request_id)
}

fn resolved_range(range: Option<ContentRange>, size: u64) -> Result<ContentRange, AccountError> {
  let range = range.unwrap_or(ContentRange {
    start: 0,
    end_inclusive: Some(size.checked_sub(1).ok_or(AccountError::InvalidResponse)?),
  });
  let end = range.end_inclusive.unwrap_or(size - 1);
  if range.start >= size || end < range.start || end >= size {
    return Err(AccountError::InvalidResponse);
  }
  Ok(ContentRange {
    start: range.start,
    end_inclusive: Some(end),
  })
}

fn validate_range(range: Option<&ContentRange>) -> Result<(), AccountError> {
  if range.is_some_and(|range| {
    range.start > MAX_SAFE_INTEGER
      || range
        .end_inclusive
        .is_some_and(|end| end > MAX_SAFE_INTEGER || end < range.start)
  }) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn validate_id(value: &str) -> Result<(), AccountError> {
  if value.is_empty() || value.len() > 512 || value != value.trim() || value.chars().any(char::is_control) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn prepare_root(root: &Path) -> Result<(), AccountError> {
  fs::create_dir_all(root).map_err(|_| AccountError::Storage)?;
  let metadata = fs::symlink_metadata(root).map_err(|_| AccountError::Storage)?;
  if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() }
  {
    return Err(AccountError::Storage);
  }
  fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|_| AccountError::Storage)?;
  for item in fs::read_dir(root).map_err(|_| AccountError::Storage)? {
    let item = item.map_err(|_| AccountError::Storage)?;
    let name = item.file_name();
    let name = name.to_string_lossy();
    if name.len() == 52
      && name.ends_with(".tmp")
      && name[..48].bytes().all(|value| value.is_ascii_hexdigit())
      && item.file_type().map_err(|_| AccountError::Storage)?.is_file()
    {
      fs::remove_file(item.path()).map_err(|_| AccountError::Storage)?;
    }
  }
  Ok(())
}

fn create_cache_file(root: &Path) -> Result<(PathBuf, File), AccountError> {
  for _ in 0..16 {
    let path = root.join(format!("{}.tmp", photo_ephemeral_id()?));
    match OpenOptions::new()
      .read(true)
      .write(true)
      .create_new(true)
      .mode(0o600)
      .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
      .open(&path)
    {
      Ok(file) => return Ok((path, file)),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(_) => return Err(AccountError::Storage),
    }
  }
  Err(AccountError::Storage)
}

fn remove_entry(inner: &mut CacheInner, handle: &str) -> Option<CacheEntry> {
  let entry = inner.handles.remove(handle)?;
  inner.reserved_bytes = inner.reserved_bytes.saturating_sub(entry.metadata.size_bytes);
  Some(entry)
}

fn unlink_entries(entries: Vec<CacheEntry>) {
  for entry in entries {
    drop(entry.file);
    let _ = fs::remove_file(entry.path);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scope(epoch: &str) -> PhotoScopeCapture {
    PhotoScopeCapture {
      user_id: "synthetic-user".into(),
      session_id: "synthetic-session".into(),
      session_epoch: epoch.into(),
      transport: niho_desktop_account::PhotoIdentityTransport::MacBearer,
    }
  }

  fn fixture() -> (PathBuf, Arc<PhotoCloudState>) {
    let root = std::env::temp_dir().join(format!("niho-photo-cloud-test-{}", photo_ephemeral_id().unwrap()));
    let state = Arc::new(PhotoCloudState::new(root.clone()).unwrap());
    (root, state)
  }

  fn entry(root: &Path, created: Instant) -> CacheEntry {
    let (path, file) = create_cache_file(root).unwrap();
    CacheEntry {
      path,
      file,
      metadata: PhotoContentMetadata {
        photo_id: "photo".into(),
        asset_id: "upa_opaque".into(),
        sha256: "a".repeat(64),
        size_bytes: 1024,
        content_type: "image/jpeg".into(),
      },
      scope: scope("epoch"),
      range: ContentRange {
        start: 0,
        end_inclusive: Some(1023),
      },
      offset: 0,
      created,
    }
  }

  #[test]
  fn cache_root_and_files_are_private_nofollow_handles() {
    let (root, state) = fixture();
    let root_metadata = fs::symlink_metadata(&root).unwrap();
    assert!(root_metadata.file_type().is_dir());
    assert_eq!(root_metadata.permissions().mode() & 0o777, 0o700);
    let cached = entry(&root, Instant::now());
    let metadata = cached.file.metadata().unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o600);
    assert_eq!(metadata.ino(), fs::metadata(&cached.path).unwrap().ino());
    drop(cached.file);
    fs::remove_file(cached.path).unwrap();
    drop(state);
    fs::remove_dir(root).unwrap();
  }

  #[test]
  fn ttl_and_abort_unlink_only_owned_cache_entries_and_release_budget() {
    let (root, state) = fixture();
    let old = entry(&root, Instant::now() - HANDLE_TTL - Duration::from_secs(1));
    let old_path = old.path.clone();
    {
      let mut inner = state.inner.lock().unwrap();
      inner.reserved_bytes = old.metadata.size_bytes;
      inner.handles.insert("old".into(), old);
    }
    state.purge_expired();
    assert!(!old_path.exists());
    assert_eq!(state.inner.lock().unwrap().reserved_bytes, 0);

    let live = entry(&root, Instant::now());
    let live_path = live.path.clone();
    let cancel = DownloadCancel::default();
    {
      let mut inner = state.inner.lock().unwrap();
      inner.reserved_bytes = live.metadata.size_bytes + 2048;
      inner.handles.insert("live".into(), live);
      inner.downloads.insert(
        "request".into(),
        Download {
          operation_id: 1,
          scope: scope("epoch"),
          photo_id: "photo".into(),
          cancel: cancel.clone(),
          reserved_bytes: 2048,
          active: false,
        },
      );
    }
    state.abort_all();
    assert!(!live_path.exists());
    assert!(cancel.check().is_err());
    assert_eq!(state.inner.lock().unwrap().reserved_bytes, 2048);
    drop(state);
    fs::remove_dir(root).unwrap();
  }

  #[test]
  fn ranges_chunk_and_hard_limits_are_closed() {
    assert_eq!(MAX_HANDLES, 4);
    assert_eq!(CACHE_BUDGET, 512 * 1024 * 1024);
    assert_eq!(MAX_CHUNK, 1024 * 1024);
    assert!(resolved_range(
      Some(ContentRange {
        start: 2,
        end_inclusive: Some(1)
      }),
      10
    )
    .is_err());
    assert!(resolved_range(
      Some(ContentRange {
        start: 10,
        end_inclusive: None
      }),
      10
    )
    .is_err());
    assert_eq!(
      resolved_range(
        Some(ContentRange {
          start: 2,
          end_inclusive: None
        }),
        10
      )
      .unwrap()
      .end_inclusive,
      Some(9),
    );
  }

  #[test]
  fn download_gate_has_one_active_and_only_two_waiters() {
    let (root, state) = fixture();
    let active = state
      .register_download(scope("epoch"), "active".into(), "photo".into())
      .unwrap();
    active.acquire().unwrap();
    let waiter_one = state
      .register_download(scope("epoch"), "waiter-one".into(), "photo".into())
      .unwrap();
    let waiter_two = state
      .register_download(scope("epoch"), "waiter-two".into(), "photo".into())
      .unwrap();
    assert!(matches!(
      state.register_download(scope("epoch"), "overflow".into(), "photo".into()),
      Err(AccountError::Busy)
    ));
    state.cancel_download(&scope("epoch"), "waiter-one").unwrap();
    assert_eq!(waiter_one.check(), Err(AccountError::Cancelled));
    drop(active);
    assert!(!state.inner.lock().unwrap().active_download);
    drop(waiter_one);
    drop(waiter_two);
    drop(state);
    fs::remove_dir(root).unwrap();
  }

  #[test]
  fn cancelled_waiter_wakes_without_waiting_for_the_gate_deadline() {
    let (root, state) = fixture();
    let active = state
      .register_download(scope("epoch"), "active".into(), "photo".into())
      .unwrap();
    active.acquire().unwrap();
    let waiter = state
      .register_download(scope("epoch"), "waiter".into(), "photo".into())
      .unwrap();
    let pending = std::thread::spawn(move || waiter.acquire());
    state.cancel_download(&scope("epoch"), "waiter").unwrap();
    assert_eq!(pending.join().unwrap(), Err(AccountError::Cancelled));
    drop(active);
    drop(state);
    fs::remove_dir(root).unwrap();
  }

  #[test]
  fn operation_drop_releases_only_its_exact_reservation() {
    let (root, state) = fixture();
    let operation = state
      .register_download(scope("epoch"), "request".into(), "photo".into())
      .unwrap();
    operation.acquire().unwrap();
    operation.reserve(2048).unwrap();
    assert_eq!(state.inner.lock().unwrap().reserved_bytes, 2048);
    drop(operation);
    let inner = state.inner.lock().unwrap();
    assert_eq!(inner.reserved_bytes, 0);
    assert!(!inner.active_download);
    drop(inner);
    drop(state);
    fs::remove_dir(root).unwrap();
  }

  #[test]
  fn early_cancel_is_bounded_scope_bound_and_consumed_before_network() {
    let (root, state) = fixture();
    state.cancel_download(&scope("epoch"), "early").unwrap();
    let operation = state
      .register_download(scope("epoch"), "early".into(), "photo".into())
      .unwrap();
    assert_eq!(operation.check(), Err(AccountError::Cancelled));
    drop(operation);
    for index in 0..10 {
      state
        .cancel_download(&scope("epoch"), &format!("early-{index}"))
        .unwrap();
    }
    assert!(state.inner.lock().unwrap().early_cancels.len() <= MAX_EARLY_CANCELS);
    drop(state);
    fs::remove_dir(root).unwrap();
  }

  #[test]
  fn disabled_cache_has_no_fallback_directory_and_rejects_content() {
    let state = Arc::new(PhotoCloudState::disabled());
    assert!(state.root.is_none());
    assert!(matches!(
      state.register_download(scope("epoch"), "request".into(), "photo".into()),
      Err(AccountError::Storage)
    ));
  }

  #[test]
  fn scope_and_request_ids_reject_header_injection() {
    assert!(validate_id("request").is_ok());
    assert!(validate_id("request\nheader").is_err());
    assert!(validate_id("").is_err());
  }
}
