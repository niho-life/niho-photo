//! Explicit Mac-local photo copy. Credentials, paths, upload tickets and original bytes stay native-only.

use crate::account::SharedAccount;
use crate::cloud_copy_source::{CloudCopySource, CopySourceError, SourceIdentity};
use crate::library::library;
use crate::photos::{photos, PhotosState};
use niho_desktop_account::{
  AccountError, NativeCopyTarget, NativeStartUpload, NativeUpload, NativeUploadState, NativeUploadTicket,
  PhotoOperation, PhotoRequest, PhotoScopeCapture,
};
use niho_desktop_photo::mask_surfaces::mask_surface_ids;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
  atomic::{AtomicBool, AtomicU64, Ordering},
  Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const JOURNAL_DIR: &str = "photo-copy-journal-v1";
const JOURNAL_VERSION: u32 = 1;
const MAX_INTENTS: usize = 32;
const MAX_JOURNAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_INTENT_BYTES: u64 = 2 * 1024 * 1024;
const CHUNK_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyScope {
  user_id: String,
  library_id: String,
  session_id: String,
  session_epoch: String,
  transport: niho_desktop_account::PhotoIdentityTransport,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableScope {
  user_id: String,
  library_id: String,
  session_id: String,
  session_epoch: String,
}

impl DurableScope {
  fn from_scope(scope: &CopyScope) -> Self {
    Self {
      user_id: scope.user_id.clone(),
      library_id: scope.library_id.clone(),
      session_id: scope.session_id.clone(),
      session_epoch: scope.session_epoch.clone(),
    }
  }
  fn capture(&self) -> PhotoScopeCapture {
    PhotoScopeCapture {
      user_id: self.user_id.clone(),
      session_id: self.session_id.clone(),
      session_epoch: self.session_epoch.clone(),
      transport: niho_desktop_account::PhotoIdentityTransport::MacBearer,
    }
  }
  fn same_owner(&self, other: &CopyScope) -> bool {
    self.user_id == other.user_id
      && self.library_id == other.library_id
      && other.transport == niho_desktop_account::PhotoIdentityTransport::MacBearer
  }
  fn matches(&self, other: &CopyScope) -> bool {
    self.same_owner(other) && self.session_id == other.session_id && self.session_epoch == other.session_epoch
  }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CopyPhase {
  Pending,
  Copying,
  Verifying,
  Stored,
  CancelPending,
  Cancelled,
  Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadFact {
  upload_id: String,
  uploaded_bytes: u64,
  stored: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableKeys {
  original_start: String,
  original_complete: String,
  original_cancel: String,
  recipe: String,
  body_digests: BTreeMap<String, String>,
}

// Persisted before issuing start: a cancel or lost ACK can replay the exact
// reservation without retaining a ticket or assuming that no upload exists.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyStart {
  target: NativeCopyTarget,
  size: u64,
  sha: String,
  content_type: String,
  key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipeBaseline {
  revision: u64,
  settings: Value,
  settings_sha256: String,
  base_version: Option<String>,
  mask_surface_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CopyIntent {
  version: u32,
  revision: u64,
  created_at_ms: u64,
  scope: DurableScope,
  request_id: String,
  photo_id: String,
  source_identity: SourceIdentity,
  source_sha256: String,
  source_size_bytes: u64,
  file_name: String,
  format: String,
  content_type: String,
  candidate_supported: bool,
  settings: Value,
  base_version: Option<String>,
  mask_ids: Vec<String>,
  phase: CopyPhase,
  original: Option<UploadFact>,
  masks: BTreeMap<String, UploadFact>,
  cloud_photo_id: Option<String>,
  recipe_expected_revision: Option<u64>,
  #[serde(default)]
  recipe_baseline: Option<RecipeBaseline>,
  settings_sha256: String,
  #[serde(default)]
  starts: BTreeMap<String, CopyStart>,
  keys: DurableKeys,
  confirmed_original: bool,
  confirmed_masks: bool,
  confirmed_recipe: bool,
}

struct RuntimeSource {
  opened_photo_id: String,
  source: CloudCopySource,
  settings: Option<Value>,
}

pub(crate) struct CloudCopyState {
  journal: CopyJournal,
  active: Mutex<HashMap<String, Arc<AtomicBool>>>,
  sources: Mutex<HashMap<String, Arc<Mutex<RuntimeSource>>>>,
}

#[derive(Clone)]
struct CopyJournal {
  root: PathBuf,
  gate: Arc<Mutex<()>>,
}

impl CopyJournal {
  fn new(root: PathBuf) -> Self {
    Self {
      root,
      gate: Arc::new(Mutex::new(())),
    }
  }

  fn path(&self, request_id: &str) -> PathBuf {
    self.root.join(format!("{}.json", digest(request_id.as_bytes())))
  }

  fn list(&self) -> Result<Vec<CopyIntent>, AccountError> {
    let _guard = self.gate.lock().map_err(|_| AccountError::Internal)?;
    self.list_unlocked()
  }

  fn list_unlocked(&self) -> Result<Vec<CopyIntent>, AccountError> {
    let mut intents = Vec::new();
    let entries = match std::fs::read_dir(&self.root) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(intents),
      Err(_) => return Err(AccountError::Storage),
    };
    let mut total = 0u64;
    for entry in entries {
      let entry = entry.map_err(|_| AccountError::Storage)?;
      let path = entry.path();
      if path.extension().and_then(|value| value.to_str()) != Some("json") {
        continue;
      }
      if intents.len() >= MAX_INTENTS {
        return Err(AccountError::Storage);
      }
      let metadata = std::fs::symlink_metadata(&path).map_err(|_| AccountError::Storage)?;
      if !metadata.is_file() || metadata.len() > MAX_INTENT_BYTES || metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(AccountError::Storage);
      }
      total = total.checked_add(metadata.len()).ok_or(AccountError::Storage)?;
      if total > MAX_JOURNAL_BYTES {
        return Err(AccountError::Storage);
      }
      let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| AccountError::Storage)?;
      let mut bytes = Vec::with_capacity(metadata.len() as usize);
      file
        .take(MAX_INTENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AccountError::Storage)?;
      let intent: CopyIntent = serde_json::from_slice(&bytes).map_err(|_| AccountError::Storage)?;
      if intent.version != JOURNAL_VERSION || self.path(&intent.request_id) != path || !valid_intent(&intent) {
        return Err(AccountError::Storage);
      }
      intents.push(intent);
    }
    Ok(intents)
  }

  fn get(&self, request_id: &str) -> Result<Option<CopyIntent>, AccountError> {
    let _guard = self.gate.lock().map_err(|_| AccountError::Internal)?;
    self.get_unlocked(request_id)
  }

  fn get_unlocked(&self, request_id: &str) -> Result<Option<CopyIntent>, AccountError> {
    if !opaque(request_id) {
      return Err(AccountError::Rejected);
    }
    Ok(
      self
        .list_unlocked()?
        .into_iter()
        .find(|intent| intent.request_id == request_id),
    )
  }

  fn create(&self, intent: &CopyIntent) -> Result<(), AccountError> {
    let _guard = self.gate.lock().map_err(|_| AccountError::Internal)?;
    let mut intents = self.list_unlocked()?;
    if intents.iter().any(|value| value.request_id == intent.request_id) {
      return Err(AccountError::Busy);
    }
    if intents.iter().any(terminal_intent) {
      self.remove_terminal_unlocked(&intents)?;
      intents = self.list_unlocked()?;
    }
    if intents.len() >= MAX_INTENTS {
      return Err(AccountError::Storage);
    }
    self.write_unlocked(intent, false)
  }

  fn remove_terminal_unlocked(&self, intents: &[CopyIntent]) -> Result<(), AccountError> {
    let mut removed = false;
    for intent in intents.iter().filter(|intent| terminal_intent(intent)) {
      std::fs::remove_file(self.path(&intent.request_id)).map_err(|_| AccountError::Storage)?;
      removed = true;
    }
    if removed {
      OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&self.root)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| AccountError::Storage)?;
    }
    Ok(())
  }

  fn replace(&self, previous_revision: u64, intent: &CopyIntent) -> Result<(), AccountError> {
    let _guard = self.gate.lock().map_err(|_| AccountError::Internal)?;
    let current = self.get_unlocked(&intent.request_id)?.ok_or(AccountError::Storage)?;
    if current.revision != previous_revision {
      return Err(AccountError::Cancelled);
    }
    self.write_unlocked(intent, true)
  }

  fn write_unlocked(&self, intent: &CopyIntent, replace: bool) -> Result<(), AccountError> {
    if !valid_intent(intent) {
      return Err(AccountError::Storage);
    }
    let bytes = serde_json::to_vec(intent).map_err(|_| AccountError::Internal)?;
    if bytes.len() as u64 > MAX_INTENT_BYTES {
      return Err(AccountError::Storage);
    }
    private_dir(&self.root)?;
    static TEMP: AtomicU64 = AtomicU64::new(0);
    let destination = self.path(&intent.request_id);
    let mut retained_bytes = 0u64;
    for entry in std::fs::read_dir(&self.root).map_err(|_| AccountError::Storage)? {
      let entry = entry.map_err(|_| AccountError::Storage)?;
      let path = entry.path();
      if path == destination || path.extension().and_then(|value| value.to_str()) != Some("json") {
        continue;
      }
      let metadata = std::fs::symlink_metadata(path).map_err(|_| AccountError::Storage)?;
      if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(AccountError::Storage);
      }
      retained_bytes = retained_bytes
        .checked_add(metadata.len())
        .ok_or(AccountError::Storage)?;
    }
    if retained_bytes
      .checked_add(bytes.len() as u64)
      .is_none_or(|total| total > MAX_JOURNAL_BYTES)
    {
      return Err(AccountError::Storage);
    }
    if !replace {
      match std::fs::symlink_metadata(&destination) {
        Ok(_) => return Err(AccountError::Busy),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(AccountError::Storage),
      }
    }
    let temporary = self.root.join(format!(
      ".intent-{}-{}.tmp",
      std::process::id(),
      TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
      let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|_| AccountError::Storage)?;
      file.write_all(&bytes).map_err(|_| AccountError::Storage)?;
      file.sync_all().map_err(|_| AccountError::Storage)?;
      std::fs::rename(&temporary, &destination).map_err(|_| AccountError::Storage)?;
      OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&self.root)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| AccountError::Storage)
    })();
    if result.is_err() {
      let _ = std::fs::remove_file(&temporary);
    }
    result
  }
}

pub fn install(app: &AppHandle) {
  let root = app.path().app_data_dir().ok().map(|path| path.join(JOURNAL_DIR));
  if let Some(root) = root {
    app.manage(Arc::new(CloudCopyState {
      journal: CopyJournal::new(root),
      active: Mutex::new(HashMap::new()),
      sources: Mutex::new(HashMap::new()),
    }));
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverInput {
  scope: CopyScope,
  photo_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartInput {
  scope: CopyScope,
  request_id: String,
  photo_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusInput {
  scope: CopyScope,
  request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recovery {
  request_id: String,
  photo_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Completed {
  original: bool,
  masks: bool,
  recipe: bool,
  cloud_photo_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyStatus {
  request_id: String,
  photo_id: String,
  phase: &'static str,
  fraction: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  completed: Option<Completed>,
}

#[tauri::command]
pub async fn camera_photo_copy_recover(app: AppHandle, input: RecoverInput) -> Result<Option<Recovery>, AccountError> {
  validate_scope(&input.scope)?;
  authorize_scope(&app, &input.scope)?;
  if !opaque(&input.photo_id) {
    return Err(AccountError::Rejected);
  }
  let state = copy_state(&app)?;
  let mut candidates: Vec<_> = state
    .journal
    .list()?
    .into_iter()
    .filter(|intent| {
      intent.scope.same_owner(&input.scope) && intent.photo_id == input.photo_id && intent.phase != CopyPhase::Cancelled
    })
    .collect();
  candidates.sort_by_key(|intent| std::cmp::Reverse(intent.created_at_ms));
  let Some(mut intent) = candidates.into_iter().next() else {
    return Ok(None);
  };
  let runtime = if matches!(intent.phase, CopyPhase::Stored | CopyPhase::CancelPending) {
    None
  } else {
    let runtime = capture_runtime(&app, &input.photo_id)?;
    if !runtime_matches(&intent, &runtime) {
      return Err(AccountError::Rejected);
    }
    Some(runtime)
  };
  if !intent.scope.matches(&input.scope) {
    let previous = intent.revision;
    intent.revision += 1;
    intent.scope = DurableScope::from_scope(&input.scope);
    state.journal.replace(previous, &intent)?;
  }
  if intent.candidate_supported {
    if let Some(runtime) = runtime {
      state
        .sources
        .lock()
        .map_err(|_| AccountError::Internal)?
        .insert(intent.request_id.clone(), Arc::new(Mutex::new(runtime)));
    }
  }
  Ok(Some(Recovery {
    request_id: intent.request_id,
    photo_id: intent.photo_id,
  }))
}

#[tauri::command]
pub async fn camera_photo_copy_start(app: AppHandle, input: StartInput) -> Result<(), AccountError> {
  validate_scope(&input.scope)?;
  authorize_scope(&app, &input.scope)?;
  if !opaque(&input.request_id) || !opaque(&input.photo_id) {
    return Err(AccountError::Rejected);
  }
  let state = copy_state(&app)?;
  if let Some(mut intent) = state.journal.get(&input.request_id)? {
    if !intent.scope.matches(&input.scope) || intent.photo_id != input.photo_id {
      return Err(AccountError::Rejected);
    }
    if matches!(intent.phase, CopyPhase::Stored | CopyPhase::Cancelled) {
      return Err(AccountError::Rejected);
    }
    let needs_source = intent.candidate_supported
      && (intent.phase == CopyPhase::Failed
        || !state
          .sources
          .lock()
          .map_err(|_| AccountError::Internal)?
          .contains_key(&input.request_id));
    if needs_source {
      let runtime = capture_runtime(&app, &input.photo_id)?;
      if !runtime_matches(&intent, &runtime) {
        return Err(AccountError::Rejected);
      }
      state
        .sources
        .lock()
        .map_err(|_| AccountError::Internal)?
        .insert(input.request_id.clone(), Arc::new(Mutex::new(runtime)));
    }
    if intent.candidate_supported && intent.phase == CopyPhase::Failed {
      transition(&state.journal, &mut intent, CopyPhase::Pending)?;
    }
  } else {
    let runtime = capture_runtime(&app, &input.photo_id)?;
    let intent = new_intent(input.scope, input.request_id.clone(), input.photo_id, &runtime)?;
    let candidate_supported = intent.candidate_supported;
    state.journal.create(&intent)?;
    if candidate_supported {
      state
        .sources
        .lock()
        .map_err(|_| AccountError::Internal)?
        .insert(input.request_id.clone(), Arc::new(Mutex::new(runtime)));
    }
  }
  if state
    .journal
    .get(&input.request_id)?
    .is_some_and(|intent| intent.candidate_supported)
  {
    schedule(&app, &input.request_id)?;
  }
  Ok(())
}

#[tauri::command]
pub async fn camera_photo_copy_status(app: AppHandle, input: StatusInput) -> Result<Option<CopyStatus>, AccountError> {
  validate_scope(&input.scope)?;
  authorize_scope(&app, &input.scope)?;
  let state = copy_state(&app)?;
  let Some(intent) = state.journal.get(&input.request_id)? else {
    return Ok(None);
  };
  if !intent.scope.matches(&input.scope) {
    return Ok(None);
  }
  if matches!(
    intent.phase,
    CopyPhase::Pending | CopyPhase::Copying | CopyPhase::Verifying | CopyPhase::CancelPending
  ) {
    schedule(&app, &input.request_id)?;
  }
  Ok(Some(status(&intent)))
}

#[tauri::command]
pub async fn camera_photo_copy_cancel(app: AppHandle, input: StatusInput) -> Result<(), AccountError> {
  validate_scope(&input.scope)?;
  authorize_scope(&app, &input.scope)?;
  let state = copy_state(&app)?;
  let Some(mut intent) = state.journal.get(&input.request_id)? else {
    return Ok(());
  };
  if !intent.scope.matches(&input.scope) {
    return Ok(());
  }
  if intent.phase == CopyPhase::Stored || intent.phase == CopyPhase::Cancelled {
    return Ok(());
  }
  let previous = intent.revision;
  intent.revision += 1;
  intent.phase = CopyPhase::CancelPending;
  state.journal.replace(previous, &intent)?;
  if let Some(cancel) = state
    .active
    .lock()
    .map_err(|_| AccountError::Internal)?
    .get(&input.request_id)
  {
    cancel.store(true, Ordering::SeqCst);
  }
  schedule(&app, &input.request_id)?;
  Ok(())
}

fn new_intent(
  scope: CopyScope,
  request_id: String,
  photo_id: String,
  runtime: &RuntimeSource,
) -> Result<CopyIntent, AccountError> {
  let extension = runtime
    .source
    .file_name()
    .rsplit('.')
    .next()
    .unwrap_or("")
    .to_ascii_lowercase();
  let (format, content_type, source_supported) = match extension.as_str() {
    "jpg" | "jpeg" => ("jpeg", "image/jpeg", true),
    "png" => ("png", "image/png", true),
    "heic" => ("heic", "image/heic", false),
    "heif" => ("heif", "image/heif", false),
    "tif" | "tiff" => ("tiff", "image/tiff", false),
    _ => ("raw", "application/octet-stream", false),
  };
  let settings = runtime.settings.clone().unwrap_or(Value::Null);
  if !journal_safe_value(&settings, 0) || !valid_file_name(runtime.source.file_name()) {
    return Err(AccountError::Rejected);
  }
  let base_version = match settings.get("base") {
    Some(Value::String(value)) => Some(value.clone()),
    Some(Value::Null) => None,
    _ => None,
  };
  let recipe_supported = runtime.settings.is_some()
    // Named cloud bases are deliberately outside this copy contract. A local
    // base candidate is retained but never uploaded until a canonical provider exists.
    && settings.get("base").is_some_and(Value::is_null)
    && settings
      .get("v")
      .and_then(Value::as_u64)
      .is_some_and(|value| value <= 9_007_199_254_740_991)
    && settings
      .get("engine")
      .and_then(Value::as_str)
      .is_some_and(|value| opaque(value) && value.len() <= 128)
    && local_masks_supported(&settings);
  let candidate_supported = source_supported && recipe_supported;
  let mut mask_ids = mask_surface_ids(&settings, false);
  mask_ids.sort();
  let original_body = json!({"target":{"kind":"original","fileName":runtime.source.file_name(),"format":format},"sizeBytes":runtime.source.size_bytes(),"sha256":runtime.source.sha256(),"contentType":content_type});
  let mut body_digests = BTreeMap::new();
  body_digests.insert("original.start".into(), value_digest(&original_body)?);
  body_digests.insert("original.complete".into(), digest(b"{}"));
  body_digests.insert("original.cancel".into(), digest(b"{}"));
  let prefix = digest(format!("{request_id}:{photo_id}:{}", runtime.source.sha256()).as_bytes());
  let settings_sha256 = value_digest(&settings)?;
  Ok(CopyIntent {
    version: JOURNAL_VERSION,
    revision: 0,
    created_at_ms: now_ms()?,
    scope: DurableScope::from_scope(&scope),
    request_id,
    photo_id,
    source_identity: runtime.source.identity().clone(),
    source_sha256: runtime.source.sha256().to_owned(),
    source_size_bytes: runtime.source.size_bytes(),
    file_name: runtime.source.file_name().to_owned(),
    format: format.into(),
    content_type: content_type.into(),
    candidate_supported,
    settings,
    base_version,
    mask_ids,
    phase: if candidate_supported {
      CopyPhase::Pending
    } else {
      CopyPhase::Failed
    },
    original: None,
    masks: BTreeMap::new(),
    cloud_photo_id: None,
    recipe_expected_revision: None,
    recipe_baseline: None,
    settings_sha256,
    starts: BTreeMap::new(),
    keys: DurableKeys {
      original_start: format!("copy-{prefix}-original-start"),
      original_complete: format!("copy-{prefix}-original-complete"),
      original_cancel: format!("copy-{prefix}-original-cancel"),
      recipe: format!("copy-{prefix}-recipe"),
      body_digests,
    },
    confirmed_original: false,
    confirmed_masks: false,
    confirmed_recipe: false,
  })
}

fn capture_runtime(app: &AppHandle, entry_id: &str) -> Result<RuntimeSource, AccountError> {
  let photos = photos(app).map_err(|_| AccountError::Storage)?;
  let library = library(app).map_err(|_| AccountError::Storage)?;
  let (opened_photo_id, source) =
    CloudCopySource::capture_registered(&photos, &library, entry_id).map_err(source_error)?;
  // The leave/flush guard must have committed the exact local recipe before copy starts.
  // Absence/unknown data stays closed; native never invents a neutral recipe.
  let settings = photos.saved(source.sha256()).map(|record| record.settings);
  Ok(RuntimeSource {
    opened_photo_id,
    source,
    settings,
  })
}

fn runtime_matches(intent: &CopyIntent, runtime: &RuntimeSource) -> bool {
  runtime.source.identity() == &intent.source_identity
    && runtime.source.sha256() == intent.source_sha256
    && runtime.source.size_bytes() == intent.source_size_bytes
    && match &runtime.settings {
      Some(settings) => value_digest(settings).ok().as_deref() == Some(intent.settings_sha256.as_str()),
      None => intent.settings.is_null(),
    }
}

fn schedule(app: &AppHandle, request_id: &str) -> Result<(), AccountError> {
  let state = copy_state(app)?;
  let mut active = state.active.lock().map_err(|_| AccountError::Internal)?;
  if active.contains_key(request_id) {
    return Ok(());
  }
  let cancel = Arc::new(AtomicBool::new(false));
  active.insert(request_id.to_owned(), cancel.clone());
  let app = app.clone();
  let request_id = request_id.to_owned();
  tauri::async_runtime::spawn_blocking(move || {
    let first = run_copy(&app, &request_id, &cancel);
    // A cancel command can win the journal CAS while this worker is between
    // chunks. Complete that explicit cancellation once before releasing the
    // one-active slot; do not turn other transient failures into background retry.
    if matches!(first, Err(AccountError::Cancelled))
      && copy_state(&app)
        .and_then(|state| state.journal.get(&request_id))
        .ok()
        .flatten()
        .is_some_and(|intent| intent.phase == CopyPhase::CancelPending)
    {
      let _ = run_copy(&app, &request_id, &cancel);
    }
    if let Ok(state) = copy_state(&app) {
      if state
        .journal
        .get(&request_id)
        .ok()
        .flatten()
        .is_some_and(|intent| matches!(intent.phase, CopyPhase::Stored | CopyPhase::Cancelled))
      {
        if let Ok(mut sources) = state.sources.lock() {
          sources.remove(&request_id);
        }
      }
      if let Ok(mut active) = state.active.lock() {
        active.remove(&request_id);
      }
    }
  });
  Ok(())
}

fn run_copy(app: &AppHandle, request_id: &str, cancel: &AtomicBool) -> Result<(), AccountError> {
  let state = copy_state(app)?;
  let mut intent = state.journal.get(request_id)?.ok_or(AccountError::Storage)?;
  if !intent.candidate_supported {
    return Err(AccountError::Rejected);
  }
  let shared = app.state::<Arc<SharedAccount>>();
  if intent.phase == CopyPhase::CancelPending || cancel.load(Ordering::SeqCst) {
    return cancel_intent(&state, &shared, intent);
  }
  let runtime = state
    .sources
    .lock()
    .map_err(|_| AccountError::Internal)?
    .get(request_id)
    .cloned()
    .ok_or(AccountError::Rejected)?;
  transition(&state.journal, &mut intent, CopyPhase::Copying)?;
  let max_mask_bytes = match check_capability(&shared, &intent) {
    Ok(value) => value,
    Err(error) => {
      fail(&state.journal, &mut intent)?;
      return Err(error);
    }
  };
  for mask_id in intent.mask_ids.clone() {
    let loaded: Result<Vec<u8>, AccountError> = (|| {
      let runtime = runtime.lock().map_err(|_| AccountError::Internal)?;
      app
        .state::<PhotosState>()
        .0
        .load_mask_surface(&runtime.opened_photo_id, &mask_id, SystemTime::now())
        .map_err(|_| AccountError::Rejected)
    })();
    let bytes = match loaded {
      Ok(bytes) => bytes,
      Err(error) => {
        fail(&state.journal, &mut intent)?;
        return Err(error);
      }
    };
    if bytes.is_empty() || bytes.len() as u64 > max_mask_bytes || digest(&bytes) != mask_id {
      fail(&state.journal, &mut intent)?;
      return Err(AccountError::Rejected);
    }
  }
  let target = NativeCopyTarget::Original {
    file_name: intent.file_name.clone(),
    format: intent.format.clone(),
  };
  let content_type = intent.content_type.clone();
  let source_size = intent.source_size_bytes;
  let source_sha = intent.source_sha256.clone();
  let start_key = intent.keys.original_start.clone();
  let complete_key = intent.keys.original_complete.clone();
  let original = match upload(
    &state.journal,
    &shared,
    &mut intent,
    target,
    content_type,
    source_size,
    source_sha,
    start_key,
    complete_key,
    |offset| {
      runtime
        .lock()
        .map_err(|_| AccountError::Internal)?
        .source
        .read_chunk(offset, CHUNK_BYTES)
        .map_err(source_error)
    },
    || {
      runtime
        .lock()
        .map_err(|_| AccountError::Internal)?
        .source
        .verify(|| cancel.load(Ordering::SeqCst))
        .map_err(source_error)
    },
    cancel,
  ) {
    Ok(value) => value,
    Err(error) => {
      if matches!(error, AccountError::InvalidResponse | AccountError::Rejected) {
        fail(&state.journal, &mut intent)?;
      }
      return Err(error);
    }
  };
  let Some(photo) = original else {
    return if intent.phase == CopyPhase::CancelPending {
      cancel_intent(&state, &shared, intent)
    } else {
      Ok(())
    };
  };
  if let Err(error) = verify_original_photo(&photo, &intent) {
    fail(&state.journal, &mut intent)?;
    return Err(error);
  }
  intent.cloud_photo_id = photo.get("id").and_then(Value::as_str).map(str::to_owned);
  if intent.cloud_photo_id.is_none() {
    fail(&state.journal, &mut intent)?;
    return Err(AccountError::InvalidResponse);
  }
  intent.confirmed_original = true;
  capture_recipe_baseline(&mut intent, &photo)?;
  persist(&state.journal, &mut intent)?;
  let cloud_photo_id = intent.cloud_photo_id.clone().ok_or(AccountError::InvalidResponse)?;

  for mask_id in intent.mask_ids.clone() {
    if cancel.load(Ordering::SeqCst) {
      transition(&state.journal, &mut intent, CopyPhase::CancelPending)?;
      return cancel_intent(&state, &shared, intent);
    }
    let loaded: Result<Vec<u8>, AccountError> = (|| {
      let runtime = runtime.lock().map_err(|_| AccountError::Internal)?;
      let photos = app.state::<PhotosState>();
      photos
        .0
        .load_mask_surface(&runtime.opened_photo_id, &mask_id, SystemTime::now())
        .map_err(|_| AccountError::Rejected)
    })();
    let bytes = match loaded {
      Ok(bytes) => bytes,
      Err(error) => {
        fail(&state.journal, &mut intent)?;
        return Err(error);
      }
    };
    if bytes.is_empty() || bytes.len() as u64 > max_mask_bytes || digest(&bytes) != mask_id {
      fail(&state.journal, &mut intent)?;
      return Err(AccountError::InvalidResponse);
    }
    let prefix = digest(
      format!(
        "{}:{}:{}:{mask_id}",
        intent.request_id, intent.source_sha256, cloud_photo_id
      )
      .as_bytes(),
    );
    let target = NativeCopyTarget::Mask {
      photo_id: cloud_photo_id.clone(),
    };
    let stored = match upload(
      &state.journal,
      &shared,
      &mut intent,
      target,
      "image/png".into(),
      bytes.len() as u64,
      mask_id.clone(),
      format!("copy-{prefix}-start"),
      format!("copy-{prefix}-complete"),
      |offset| Ok(bytes[offset as usize..(offset as usize + CHUNK_BYTES).min(bytes.len())].to_vec()),
      || Ok(()),
      cancel,
    ) {
      Ok(value) => value,
      Err(error) => {
        if matches!(error, AccountError::InvalidResponse | AccountError::Rejected) {
          fail(&state.journal, &mut intent)?;
        }
        return Err(error);
      }
    };
    if stored.is_none() {
      return if intent.phase == CopyPhase::CancelPending {
        cancel_intent(&state, &shared, intent)
      } else {
        Ok(())
      };
    }
  }
  intent.confirmed_masks = true;
  transition(&state.journal, &mut intent, CopyPhase::Verifying)?;
  if let Err(error) = reconcile_recipe(&state.journal, &shared, &mut intent) {
    fail(&state.journal, &mut intent)?;
    return Err(error);
  }
  let source_verification = {
    let mut runtime = runtime.lock().map_err(|_| AccountError::Internal)?;
    runtime
      .source
      .verify(|| cancel.load(Ordering::SeqCst))
      .map_err(source_error)
  };
  if let Err(error) = source_verification {
    fail(&state.journal, &mut intent)?;
    return Err(error);
  }
  if let Err(error) = final_verify(&shared, &intent) {
    fail(&state.journal, &mut intent)?;
    return Err(error);
  }
  let generation = shared.begin_photo_operation()?;
  let previous = intent.revision;
  intent.revision += 1;
  intent.phase = CopyPhase::Stored;
  intent.confirmed_recipe = true;
  let scope = intent.scope.capture();
  shared.commit_photo_operation(generation, &scope, || {
    state.journal.replace(previous, &intent).map_err(std::io::Error::other)
  })?;
  Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upload(
  journal: &CopyJournal,
  shared: &SharedAccount,
  intent: &mut CopyIntent,
  target: NativeCopyTarget,
  content_type: String,
  size: u64,
  sha: String,
  start_key: String,
  complete_key: String,
  mut read: impl FnMut(u64) -> Result<Vec<u8>, AccountError>,
  mut verify: impl FnMut() -> Result<(), AccountError>,
  cancel: &AtomicBool,
) -> Result<Option<Value>, AccountError> {
  let (start_digest_name, complete_digest_name) = match &target {
    NativeCopyTarget::Original { .. } => ("original.start".to_owned(), "original.complete".to_owned()),
    NativeCopyTarget::Mask { .. } => (format!("mask.{sha}.start"), format!("mask.{sha}.complete")),
  };
  let target_body = match &target {
    NativeCopyTarget::Original { file_name, format } => {
      json!({"kind":"original","fileName":file_name,"format":format})
    }
    NativeCopyTarget::Mask { photo_id } => json!({"kind":"mask","photoId":photo_id}),
  };
  let start_body = json!({
    "target": target_body,
    "sizeBytes": size,
    "sha256": sha.clone(),
    "contentType": content_type.clone(),
  });
  let changed = bind_body_digest(intent, &start_digest_name, &start_body)?
    | bind_body_digest(intent, &complete_digest_name, &json!({}))?;
  let new_start = !intent.starts.contains_key(&start_digest_name);
  if new_start {
    intent.starts.insert(
      start_digest_name.clone(),
      CopyStart {
        target: target.clone(),
        size,
        sha: sha.clone(),
        content_type: content_type.clone(),
        key: start_key.clone(),
      },
    );
  }
  if changed || new_start {
    persist(journal, intent)?;
  }
  let fact = match &target {
    NativeCopyTarget::Original { .. } => intent.original.clone(),
    NativeCopyTarget::Mask { .. } => intent.masks.get(&sha).cloned(),
  };
  let expected_upload_id = fact.as_ref().map(|fact| fact.upload_id.clone());
  let mut ticket: Option<NativeUploadTicket> = None;
  let mut upload = if let Some(fact) = fact {
    guarded(shared, || {
      shared
        .account
        .photo_copy_get(&intent.scope.capture(), &intent.scope.library_id, &fact.upload_id)
    })?
  } else {
    match guarded(shared, || {
      shared.account.photo_copy_start(
        &intent.scope.capture(),
        &intent.scope.library_id,
        &target,
        size,
        &sha,
        &content_type,
        &start_key,
      )
    })? {
      NativeStartUpload::Existing { photo } => {
        if !matches!(&target, NativeCopyTarget::Original { .. }) {
          return Err(AccountError::InvalidResponse);
        }
        return Ok(Some(photo));
      }
      NativeStartUpload::Upload { upload, ticket: first } => {
        ticket = first;
        upload
      }
    }
  };
  if expected_upload_id
    .as_deref()
    .is_some_and(|expected| upload.id != expected)
  {
    return Err(AccountError::InvalidResponse);
  }
  let upload_id = upload.id.clone();
  assert_upload(&upload, &target, size, &sha)?;
  let mut attempts_without_progress = 0u8;
  for _step in 0..64 {
    if cancel.load(Ordering::SeqCst) {
      transition(journal, intent, CopyPhase::CancelPending)?;
      return Ok(None);
    }
    match upload.state.clone() {
      NativeUploadState::StoredOriginal { photo } => {
        set_fact(intent, &target, &sha, &upload, true);
        persist(journal, intent)?;
        return Ok(Some(photo));
      }
      NativeUploadState::StoredMask { photo_id, asset } => {
        if !matches!(&target, NativeCopyTarget::Mask { photo_id: expected } if expected == &photo_id)
          || asset.get("sha256").and_then(Value::as_str) != Some(&sha)
        {
          return Err(AccountError::InvalidResponse);
        }
        set_fact(intent, &target, &sha, &upload, true);
        persist(journal, intent)?;
        return Ok(Some(asset));
      }
      NativeUploadState::Verifying => {
        set_fact(intent, &target, &sha, &upload, false);
        transition(journal, intent, CopyPhase::Verifying)?;
        return Ok(None);
      }
      NativeUploadState::Cancelled | NativeUploadState::Expired | NativeUploadState::Rejected => {
        fail(journal, intent)?;
        return Err(AccountError::Rejected);
      }
      NativeUploadState::Reserved { uploaded_bytes } => {
        set_fact(intent, &target, &sha, &upload, false);
        persist(journal, intent)?;
        if uploaded_bytes == size {
          verify()?;
          upload = match guarded(shared, || {
            shared.account.photo_copy_complete(
              &intent.scope.capture(),
              &intent.scope.library_id,
              &upload.id,
              &complete_key,
            )
          }) {
            Ok(value) => value,
            Err(_) => {
              let current = guarded(shared, || {
                shared
                  .account
                  .photo_copy_get(&intent.scope.capture(), &intent.scope.library_id, &upload.id)
              })?;
              if matches!(&current.state, NativeUploadState::Reserved { uploaded_bytes } if *uploaded_bytes == size) {
                guarded(shared, || {
                  shared.account.photo_copy_complete(
                    &intent.scope.capture(),
                    &intent.scope.library_id,
                    &upload.id,
                    &complete_key,
                  )
                })?
              } else {
                current
              }
            }
          };
          if upload.id != upload_id {
            return Err(AccountError::InvalidResponse);
          }
          ticket = None;
          continue;
        }
        if ticket
          .as_ref()
          .is_none_or(|value| value.resume_offset_bytes() != uploaded_bytes)
        {
          let (current, renewed) = guarded(shared, || {
            shared.account.photo_copy_renew(
              &intent.scope.capture(),
              &intent.scope.library_id,
              &upload.id,
              &content_type,
            )
          })?;
          assert_upload(&current, &target, size, &sha)?;
          if current.id != upload_id
            || !matches!(&current.state, NativeUploadState::Reserved { uploaded_bytes: next } if *next == uploaded_bytes)
            || renewed.resume_offset_bytes() != uploaded_bytes
          {
            return Err(AccountError::InvalidResponse);
          }
          upload = current;
          ticket = Some(renewed);
          continue;
        }
        let bytes = read(uploaded_bytes)?;
        if bytes.is_empty() || uploaded_bytes + bytes.len() as u64 > size {
          return Err(AccountError::InvalidResponse);
        }
        let active_ticket = ticket.take().ok_or(AccountError::Internal)?;
        let _provider = guarded(shared, || {
          shared
            .account
            .photo_copy_put(&intent.scope.capture(), &active_ticket, uploaded_bytes, size, &bytes)
        })
        .or_else(|_| {
          guarded(shared, || {
            shared
              .account
              .photo_copy_probe(&intent.scope.capture(), &active_ticket, size)
          })
        });
        upload = guarded(shared, || {
          shared
            .account
            .photo_copy_get(&intent.scope.capture(), &intent.scope.library_id, &upload.id)
        })?;
        if upload.id != upload_id {
          return Err(AccountError::InvalidResponse);
        }
        assert_upload(&upload, &target, size, &sha)?;
        if let NativeUploadState::Reserved { uploaded_bytes: next } = &upload.state {
          if *next < uploaded_bytes {
            return Err(AccountError::InvalidResponse);
          }
          attempts_without_progress = if *next == uploaded_bytes {
            attempts_without_progress.saturating_add(1)
          } else {
            0
          };
          if attempts_without_progress >= 3 {
            return Err(AccountError::Network);
          }
        }
      }
    }
  }
  Err(AccountError::Network)
}

fn cancel_intent(state: &CloudCopyState, shared: &SharedAccount, mut intent: CopyIntent) -> Result<(), AccountError> {
  let unknown_retained = reconcile_cancel_starts(&state.journal, &mut intent, |start, intent| {
    guarded(shared, || {
      shared.account.photo_copy_start(
        &intent.scope.capture(),
        &intent.scope.library_id,
        &start.target,
        start.size,
        &start.sha,
        &start.content_type,
        &start.key,
      )
    })
  })?;
  let mut facts = Vec::new();
  if let Some(fact) = intent.original.clone() {
    facts.push(("original.cancel".to_owned(), intent.keys.original_cancel.clone(), fact));
  }
  for (sha, fact) in intent.masks.clone() {
    let prefix = digest(
      format!(
        "{}:{}:{}:{sha}",
        intent.request_id,
        intent.source_sha256,
        intent.cloud_photo_id.as_deref().unwrap_or("")
      )
      .as_bytes(),
    );
    facts.push((format!("mask.{sha}.cancel"), format!("copy-{prefix}-cancel"), fact));
  }
  let mut digest_changed = false;
  for (name, _, _) in &facts {
    digest_changed |= bind_body_digest(&mut intent, name, &json!({}))?;
  }
  if digest_changed {
    persist(&state.journal, &mut intent)?;
  }
  let mut retained = unknown_retained;
  for (_, key, fact) in facts {
    let current = guarded(shared, || {
      shared
        .account
        .photo_copy_get(&intent.scope.capture(), &intent.scope.library_id, &fact.upload_id)
    })?;
    if current.id != fact.upload_id {
      fail(&state.journal, &mut intent)?;
      return Err(AccountError::InvalidResponse);
    }
    if matches!(
      &current.state,
      NativeUploadState::StoredOriginal { .. }
        | NativeUploadState::StoredMask { .. }
        | NativeUploadState::Verifying
        | NativeUploadState::Expired
        | NativeUploadState::Rejected
    ) {
      retained = true;
      continue;
    }
    if matches!(&current.state, NativeUploadState::Reserved { .. }) {
      let cancelled = guarded(shared, || {
        shared
          .account
          .photo_copy_cancel(&intent.scope.capture(), &intent.scope.library_id, &fact.upload_id, &key)
      })?;
      if cancelled.id != fact.upload_id || !matches!(&cancelled.state, NativeUploadState::Cancelled) {
        fail(&state.journal, &mut intent)?;
        return Err(AccountError::Rejected);
      }
    }
  }
  if retained {
    fail(&state.journal, &mut intent)?;
    Err(AccountError::Rejected)
  } else {
    transition(&state.journal, &mut intent, CopyPhase::Cancelled)
  }
}

fn reconcile_cancel_starts(
  journal: &CopyJournal,
  intent: &mut CopyIntent,
  mut replay: impl FnMut(&CopyStart, &CopyIntent) -> Result<NativeStartUpload, AccountError>,
) -> Result<bool, AccountError> {
  let mut retained = false;
  for start in intent.starts.values().cloned().collect::<Vec<_>>() {
    let has_fact = match &start.target {
      NativeCopyTarget::Original { .. } => intent.original.is_some(),
      NativeCopyTarget::Mask { .. } => intent.masks.contains_key(&start.sha),
    };
    if has_fact {
      continue;
    }
    match replay(&start, intent)? {
      NativeStartUpload::Existing { photo } => {
        if !matches!(&start.target, NativeCopyTarget::Original { .. }) {
          return Err(AccountError::InvalidResponse);
        }
        verify_original_photo(&photo, intent)?;
        intent.cloud_photo_id = photo.get("id").and_then(Value::as_str).map(str::to_owned);
        retained = true;
      }
      NativeStartUpload::Upload { upload, .. } => {
        assert_upload(&upload, &start.target, start.size, &start.sha)?;
        set_fact(intent, &start.target, &start.sha, &upload, false);
      }
    }
    persist(journal, intent)?;
  }
  Ok(retained)
}

fn check_capability(shared: &SharedAccount, intent: &CopyIntent) -> Result<u64, AccountError> {
  let request = PhotoRequest::parse(PhotoOperation::LibraryGet, json!({}), None)?;
  let response = guarded(shared, || {
    shared.account.photo_request(&intent.scope.capture(), &request)
  })?;
  let capabilities = response.body.get("capabilities").ok_or(AccountError::InvalidResponse)?;
  let limits = response.body.get("limits").ok_or(AccountError::InvalidResponse)?;
  let recipe_bytes = serde_json::to_vec(&intent.settings)
    .map_err(|_| AccountError::InvalidResponse)?
    .len() as u64;
  let recipe_body_bytes = serde_json::to_vec(&json!({
    "expectedRevision": 0,
    "settings": intent.settings.clone(),
    "baseVersion": intent.base_version.clone(),
  }))
  .map_err(|_| AccountError::InvalidResponse)?
  .len() as u64;
  let max_mask_bytes = limits
    .get("maxMaskBytes")
    .and_then(Value::as_u64)
    .filter(|value| *value > 0)
    .map(|value| value.min(8 * 1024 * 1024))
    .ok_or(AccountError::InvalidResponse)?;
  let within_limits = limits
    .get("maxFileBytes")
    .and_then(Value::as_u64)
    .is_some_and(|value| intent.source_size_bytes <= value && intent.source_size_bytes <= 200 * 1024 * 1024)
    && limits
      .get("maxRecipeBytes")
      .and_then(Value::as_u64)
      .is_some_and(|value| recipe_bytes <= value && recipe_bytes <= MAX_INTENT_BYTES)
    && limits
      .get("maxRecipeBodyBytes")
      .and_then(Value::as_u64)
      .is_some_and(|value| recipe_body_bytes <= value && recipe_body_bytes <= MAX_INTENT_BYTES);
  let ingest = capabilities
    .get("formats")
    .and_then(Value::as_array)
    .is_some_and(|items| {
      items.iter().any(|item| {
        item.get("format").and_then(Value::as_str) == Some(&intent.format)
          && item.get("ingest").and_then(Value::as_bool) == Some(true)
      })
    });
  let renderer = capabilities.get("renderer").ok_or(AccountError::InvalidResponse)?;
  let version = intent.settings.get("v").and_then(Value::as_u64);
  let engine = intent.settings.get("engine").and_then(Value::as_str);
  let recipe_supported = capabilities.get("edits").and_then(Value::as_bool) == Some(true)
    && version.is_some_and(|version| {
      renderer
        .get("settingsVersions")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_u64() == Some(version)))
    })
    && engine.is_some_and(|engine| {
      renderer
        .get("engines")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(engine)))
    });
  let masks_array = intent.settings.get("masks").and_then(Value::as_array);
  let mask_kinds: Vec<&str> = masks_array
    .into_iter()
    .flatten()
    .filter_map(|mask| mask.get("kind").and_then(Value::as_str))
    .collect();
  let masks_well_formed = masks_array.is_none_or(|items| items.len() == mask_kinds.len());
  let masks = masks_well_formed
    && (mask_kinds.is_empty()
      || renderer
        .get("features")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("masks")))
        && renderer
          .get("maskKinds")
          .and_then(Value::as_array)
          .is_some_and(|items| {
            mask_kinds
              .iter()
              .all(|kind| items.iter().any(|item| item.as_str() == Some(*kind)))
          })
        && (intent.mask_ids.is_empty()
          || capabilities.get("maskSurfaces").and_then(Value::as_bool) == Some(true)
            && renderer.get("maskSurfaces").and_then(Value::as_bool) == Some(true)));
  if ingest && recipe_supported && masks && within_limits {
    Ok(max_mask_bytes)
  } else {
    Err(AccountError::Rejected)
  }
}

fn reconcile_recipe(
  journal: &CopyJournal,
  shared: &SharedAccount,
  intent: &mut CopyIntent,
) -> Result<(), AccountError> {
  let photo_id = intent.cloud_photo_id.clone().ok_or(AccountError::InvalidResponse)?;
  let fresh = get_photo(shared, intent, &photo_id)?;
  verify_original_photo(&fresh, intent)?;
  if recipe_matches(&fresh, intent) {
    return Ok(());
  }
  let body = recipe_write_body(intent, &fresh)?;
  let revision = intent.recipe_expected_revision.ok_or(AccountError::Rejected)?;
  if bind_body_digest(intent, "recipe", &body)? {
    persist(journal, intent)?;
  }
  let request = PhotoRequest::parse(
    PhotoOperation::RecipesPut,
    json!({
      "photoId": photo_id, "expectedRevision": revision, "settings": intent.settings.clone(), "baseVersion": intent.base_version.clone(),
    }),
    Some(intent.keys.recipe.clone()),
  )?;
  let response = guarded(shared, || {
    shared.account.photo_request(&intent.scope.capture(), &request)
  })?;
  let photo = response.body.get("value").ok_or(AccountError::InvalidResponse)?;
  if !recipe_matches(photo, intent) {
    return Err(AccountError::Rejected);
  }
  Ok(())
}

fn read_recipe_baseline(photo: &Value) -> Result<RecipeBaseline, AccountError> {
  let baseline: RecipeBaseline = serde_json::from_value(json!({
    "revision": photo.pointer("/recipe/revision").ok_or(AccountError::InvalidResponse)?,
    "settings": photo.pointer("/recipe/settings").ok_or(AccountError::InvalidResponse)?,
    "settingsSha256": photo.pointer("/recipe/settingsSha256").ok_or(AccountError::InvalidResponse)?,
    "baseVersion": photo.pointer("/recipe/baseVersion").ok_or(AccountError::InvalidResponse)?,
    "maskSurfaceIds": photo.pointer("/recipe/maskSurfaceIds").ok_or(AccountError::InvalidResponse)?,
  }))
  .map_err(|_| AccountError::InvalidResponse)?;
  if !safe_baseline(&baseline) {
    return Err(AccountError::Rejected);
  }
  Ok(baseline)
}

fn capture_recipe_baseline(intent: &mut CopyIntent, photo: &Value) -> Result<(), AccountError> {
  if intent.recipe_baseline.is_none() {
    let baseline = read_recipe_baseline(photo)?;
    intent.recipe_expected_revision = Some(baseline.revision);
    intent.recipe_baseline = Some(baseline);
  }
  Ok(())
}

fn recipe_write_body(intent: &CopyIntent, fresh: &Value) -> Result<Value, AccountError> {
  let baseline = intent.recipe_baseline.as_ref().ok_or(AccountError::Rejected)?;
  let current = read_recipe_baseline(fresh)?;
  // Explicit copy can adopt an unedited original. A differing existing recipe
  // remains remote; neither retry nor a later fresh GET grants overwrite consent.
  if baseline.revision != 0
    || intent.recipe_expected_revision != Some(0)
    || serde_jcs::to_vec(baseline).ok() != serde_jcs::to_vec(&current).ok()
  {
    return Err(AccountError::Rejected);
  }
  Ok(json!({"expectedRevision":0,"settings":intent.settings,"baseVersion":intent.base_version}))
}

fn safe_baseline(baseline: &RecipeBaseline) -> bool {
  baseline.revision <= 9_007_199_254_740_991
    && journal_safe_value(&baseline.settings, 0)
    && value_digest(&baseline.settings).ok().as_deref() == Some(baseline.settings_sha256.as_str())
    && baseline.base_version.is_none()
    && baseline.mask_surface_ids.iter().all(|id| is_sha256(id))
}

fn final_verify(shared: &SharedAccount, intent: &CopyIntent) -> Result<(), AccountError> {
  let photo_id = intent.cloud_photo_id.as_deref().ok_or(AccountError::InvalidResponse)?;
  let photo = get_photo(shared, intent, photo_id)?;
  verify_original_photo(&photo, intent)?;
  if !recipe_matches(&photo, intent) {
    return Err(AccountError::Rejected);
  }
  for mask_id in &intent.mask_ids {
    let asset = guarded(shared, || {
      shared
        .account
        .photo_copy_mask_get(&intent.scope.capture(), &intent.scope.library_id, photo_id, mask_id)
    })?;
    if asset.get("sha256").and_then(Value::as_str) != Some(mask_id)
      || asset.get("kind").and_then(Value::as_str) != Some("mask")
    {
      return Err(AccountError::InvalidResponse);
    }
  }
  Ok(())
}

fn get_photo(shared: &SharedAccount, intent: &CopyIntent, photo_id: &str) -> Result<Value, AccountError> {
  let request = PhotoRequest::parse(PhotoOperation::PhotosGet, json!({"photoId": photo_id}), None)?;
  let response = guarded(shared, || {
    shared.account.photo_request(&intent.scope.capture(), &request)
  })?;
  if response.status == 200 {
    Ok(response.body)
  } else {
    Err(AccountError::Rejected)
  }
}

fn guarded<T>(shared: &SharedAccount, operation: impl FnOnce() -> Result<T, AccountError>) -> Result<T, AccountError> {
  let generation = shared.begin_photo_operation()?;
  let result = operation()?;
  shared.ensure_photo_operation_current(generation)?;
  Ok(result)
}

fn verify_original_photo(photo: &Value, intent: &CopyIntent) -> Result<(), AccountError> {
  let original = photo.get("original").ok_or(AccountError::InvalidResponse)?;
  if photo.get("libraryId").and_then(Value::as_str) != Some(&intent.scope.library_id)
    || photo
      .get("id")
      .and_then(Value::as_str)
      .is_none_or(|value| !opaque(value))
    || photo.get("storageState").and_then(Value::as_str) != Some("stored")
    || photo.get("format").and_then(Value::as_str) != Some(&intent.format)
    || photo
      .get("fileName")
      .and_then(Value::as_str)
      .is_none_or(|name| !valid_file_name(name))
    || original
      .get("id")
      .and_then(Value::as_str)
      .is_none_or(|value| !opaque(value))
    || original.get("kind").and_then(Value::as_str) != Some("original")
    || original.get("sha256").and_then(Value::as_str) != Some(&intent.source_sha256)
    || original.get("sizeBytes").and_then(Value::as_u64) != Some(intent.source_size_bytes)
    || original.get("contentType").and_then(Value::as_str) != Some(&intent.content_type)
  {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn recipe_matches(photo: &Value, intent: &CopyIntent) -> bool {
  let expected_base = intent.base_version.clone().map(Value::String).unwrap_or(Value::Null);
  photo.pointer("/recipe/settingsSha256").and_then(Value::as_str) == Some(&intent.settings_sha256)
    && photo
      .pointer("/recipe/settings")
      .and_then(|settings| value_digest(settings).ok())
      .as_deref()
      == Some(intent.settings_sha256.as_str())
    && photo.pointer("/recipe/baseVersion") == Some(&expected_base)
    && photo
      .pointer("/recipe/maskSurfaceIds")
      .and_then(Value::as_array)
      .is_some_and(|ids| {
        ids
          .iter()
          .map(Value::as_str)
          .collect::<Option<Vec<_>>>()
          .is_some_and(|actual| actual == intent.mask_ids.iter().map(String::as_str).collect::<Vec<_>>())
      })
}

fn assert_upload(upload: &NativeUpload, target: &NativeCopyTarget, size: u64, sha: &str) -> Result<(), AccountError> {
  if &upload.target != target || upload.size_bytes != size || upload.sha256 != sha {
    Err(AccountError::InvalidResponse)
  } else {
    Ok(())
  }
}

fn set_fact(intent: &mut CopyIntent, target: &NativeCopyTarget, sha: &str, upload: &NativeUpload, stored: bool) {
  let uploaded_bytes = match &upload.state {
    NativeUploadState::Reserved { uploaded_bytes } => *uploaded_bytes,
    NativeUploadState::StoredOriginal { .. } | NativeUploadState::StoredMask { .. } | NativeUploadState::Verifying => {
      upload.size_bytes
    }
    _ => 0,
  };
  let fact = UploadFact {
    upload_id: upload.id.clone(),
    uploaded_bytes,
    stored,
  };
  match target {
    NativeCopyTarget::Original { .. } => intent.original = Some(fact),
    NativeCopyTarget::Mask { .. } => {
      intent.masks.insert(sha.to_owned(), fact);
    }
  }
}

fn transition(journal: &CopyJournal, intent: &mut CopyIntent, phase: CopyPhase) -> Result<(), AccountError> {
  intent.phase = phase;
  persist(journal, intent)
}
fn fail(journal: &CopyJournal, intent: &mut CopyIntent) -> Result<(), AccountError> {
  transition(journal, intent, CopyPhase::Failed)
}
fn persist(journal: &CopyJournal, intent: &mut CopyIntent) -> Result<(), AccountError> {
  let previous = intent.revision;
  intent.revision += 1;
  journal.replace(previous, intent)
}

fn status(intent: &CopyIntent) -> CopyStatus {
  let completed = (intent.phase == CopyPhase::Stored
    && intent.confirmed_original
    && intent.confirmed_masks
    && intent.confirmed_recipe)
    .then(|| Completed {
      original: true,
      masks: true,
      recipe: true,
      cloud_photo_id: intent.cloud_photo_id.clone().unwrap_or_default(),
    });
  CopyStatus {
    request_id: intent.request_id.clone(),
    photo_id: intent.photo_id.clone(),
    phase: match intent.phase {
      CopyPhase::Pending => "pending",
      CopyPhase::Copying => "copying",
      CopyPhase::Verifying => "verifying",
      CopyPhase::Stored => "stored",
      CopyPhase::CancelPending => "copying",
      CopyPhase::Cancelled => "cancelled",
      CopyPhase::Failed => "failed",
    },
    fraction: if intent.phase == CopyPhase::Stored {
      Some(1.0)
    } else if !intent.confirmed_original && intent.source_size_bytes > 0 {
      Some(
        intent
          .original
          .as_ref()
          .map_or(0, |value| value.uploaded_bytes)
          .min(intent.source_size_bytes) as f64
          / intent.source_size_bytes as f64,
      )
    } else {
      None
    },
    completed,
  }
}

fn copy_state(app: &AppHandle) -> Result<Arc<CloudCopyState>, AccountError> {
  app
    .try_state::<Arc<CloudCopyState>>()
    .map(|value| value.inner().clone())
    .ok_or(AccountError::NotConfigured)
}
fn authorize_scope(app: &AppHandle, scope: &CopyScope) -> Result<(), AccountError> {
  let shared = app.state::<Arc<SharedAccount>>();
  let generation = shared.begin_photo_operation()?;
  shared.commit_photo_operation(generation, &DurableScope::from_scope(scope).capture(), || Ok(()))
}
fn durable_id(value: &str) -> bool {
  opaque(value)
    && value
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':'))
}
fn validate_scope(scope: &CopyScope) -> Result<(), AccountError> {
  if durable_id(&scope.user_id)
    && durable_id(&scope.library_id)
    && durable_id(&scope.session_id)
    && durable_id(&scope.session_epoch)
    && scope.transport == niho_desktop_account::PhotoIdentityTransport::MacBearer
  {
    Ok(())
  } else {
    Err(AccountError::Rejected)
  }
}
fn opaque(value: &str) -> bool {
  !value.is_empty() && value.len() <= 512 && value == value.trim() && !value.chars().any(forbidden_opaque_character)
}
fn forbidden_opaque_character(value: char) -> bool {
  value.is_control()
    || matches!(
      value as u32,
      0x00ad | 0x061c | 0x06dd | 0x070f | 0x08e2 | 0x180e | 0xfeff | 0x110bd | 0x110cd | 0xe0001
    )
    || matches!(
      value as u32,
      0x0600..=0x0605
        | 0x0890..=0x0891
        | 0x17b4..=0x17b5
        | 0x200b..=0x200f
        | 0x202a..=0x202e
        | 0x2060..=0x2064
        | 0x2066..=0x206f
        | 0xfff9..=0xfffb
    )
}
fn is_sha256(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_file_name(value: &str) -> bool {
  !value.is_empty()
    && value.as_bytes().len() <= 255
    && !value.contains('/')
    && !value.contains('\\')
    && !value.chars().any(forbidden_opaque_character)
}
fn valid_intent(intent: &CopyIntent) -> bool {
  opaque(&intent.request_id)
    && opaque(&intent.photo_id)
    && durable_id(&intent.scope.user_id)
    && durable_id(&intent.scope.library_id)
    && durable_id(&intent.scope.session_id)
    && durable_id(&intent.scope.session_epoch)
    && valid_file_name(&intent.file_name)
    && is_sha256(&intent.source_sha256)
    && intent.source_size_bytes > 0
    && intent.source_size_bytes <= 200 * 1024 * 1024
    && intent.source_identity.size == intent.source_size_bytes
    && matches!(
      (intent.format.as_str(), intent.content_type.as_str()),
      ("jpeg", "image/jpeg")
        | ("png", "image/png")
        | ("heic", "image/heic")
        | ("heif", "image/heif")
        | ("tiff", "image/tiff")
        | ("raw", "application/octet-stream")
    )
    && intent.base_version.as_deref().is_none_or(opaque)
    && journal_safe_value(&intent.settings, 0)
    && value_digest(&intent.settings).ok().as_deref() == Some(intent.settings_sha256.as_str())
    && intent.recipe_baseline.as_ref().is_none_or(safe_baseline)
    && intent
      .starts
      .iter()
      .all(|(name, start)| valid_start(intent, name, start))
    && intent.mask_ids.iter().all(|value| is_sha256(value))
    && intent.mask_ids.iter().collect::<std::collections::HashSet<_>>().len() == intent.mask_ids.len()
    && intent.keys.body_digests.values().all(|value| is_sha256(value))
    && [
      &intent.keys.original_start,
      &intent.keys.original_complete,
      &intent.keys.original_cancel,
      &intent.keys.recipe,
    ]
    .into_iter()
    .all(|value| opaque(value))
    && intent.original.as_ref().is_none_or(valid_upload_fact)
    && intent
      .masks
      .iter()
      .all(|(sha, fact)| is_sha256(sha) && valid_upload_fact(fact))
    && intent.cloud_photo_id.as_deref().is_none_or(opaque)
    && (intent.phase != CopyPhase::Stored || terminal_intent(intent))
}
fn valid_upload_fact(fact: &UploadFact) -> bool {
  opaque(&fact.upload_id) && fact.uploaded_bytes <= 200 * 1024 * 1024
}
fn local_masks_supported(settings: &Value) -> bool {
  let Some(value) = settings.get("masks") else {
    return true;
  };
  let Some(masks) = value.as_array().filter(|masks| masks.len() <= 64) else {
    return false;
  };
  masks.iter().all(|mask| {
    let Some(kind) = mask.get("kind").and_then(Value::as_str) else {
      return false;
    };
    match kind {
      "linear" | "radial" => true,
      "brush" | "subject" | "sky" => {
        let Some(surface) = mask.get("surface") else {
          return false;
        };
        surface.get("id").and_then(Value::as_str).is_some_and(is_sha256)
          && surface
            .get("width")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0 && value <= 16_384)
          && surface
            .get("height")
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0 && value <= 16_384)
      }
      _ => false,
    }
  })
}
fn digest(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
fn value_digest(value: &Value) -> Result<String, AccountError> {
  serde_jcs::to_vec(value)
    .map(|bytes| digest(&bytes))
    .map_err(|_| AccountError::Internal)
}
fn bind_body_digest(intent: &mut CopyIntent, name: &str, value: &Value) -> Result<bool, AccountError> {
  let actual = value_digest(value)?;
  match intent.keys.body_digests.get(name) {
    Some(expected) if expected == &actual => Ok(false),
    Some(_) => Err(AccountError::Rejected),
    None => {
      intent.keys.body_digests.insert(name.to_owned(), actual);
      Ok(true)
    }
  }
}
fn terminal_intent(intent: &CopyIntent) -> bool {
  intent.phase == CopyPhase::Cancelled
    || intent.phase == CopyPhase::Stored
      && intent.confirmed_original
      && intent.confirmed_masks
      && intent.confirmed_recipe
      && intent.cloud_photo_id.as_deref().is_some_and(opaque)
}
// Data minimization, independent of rendering validation. No free text or future
// fields are journaled: keep unsupported settings in the existing local library.
fn journal_safe_value(value: &Value, _depth: usize) -> bool {
  journal_safe_recipe_field(value, &[])
}
fn journal_safe_recipe_field(value: &Value, path: &[&str]) -> bool {
  if path.len() > 32 {
    return false;
  }
  const ROOT: &[&str] = &[
    "v",
    "engine",
    "look",
    "base",
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "texture",
    "clarity",
    "dehaze",
    "vibrance",
    "saturation",
    "colorNoiseReduction",
    "colorNoiseReductionDetail",
    "colorNoiseReductionSmoothness",
    "whiteBalance",
    "relativeTemperature",
    "relativeTint",
    "toneCurves",
    "hsl",
    "colorPoints",
    "masks",
    "calibration",
    "colorGrading",
    "parametricShadows",
    "parametricDarks",
    "parametricLights",
    "parametricHighlights",
    "parametricShadowSplit",
    "parametricMidtoneSplit",
    "parametricHighlightSplit",
    "curveRefineSaturation",
    "grayscale",
    "grayMixer",
    "vignette",
    "grain",
    "detail",
    "legacySettings",
    "geometry",
    "heal",
    "lens",
  ];
  const NESTED: &[&str] = &[
    "mode",
    "temperature",
    "tint",
    "channel",
    "points",
    "x",
    "y",
    "hue",
    "saturation",
    "luminance",
    "red",
    "orange",
    "yellow",
    "green",
    "aqua",
    "blue",
    "purple",
    "magenta",
    "id",
    "kind",
    "enabled",
    "invert",
    "adjust",
    "zero",
    "full",
    "center",
    "radius",
    "angle",
    "feather",
    "surface",
    "width",
    "height",
    "shadowTint",
    "redHue",
    "redSaturation",
    "greenHue",
    "greenSaturation",
    "blueHue",
    "blueSaturation",
    "shadow",
    "midtone",
    "highlight",
    "global",
    "blending",
    "balance",
    "amount",
    "midpoint",
    "roundness",
    "style",
    "size",
    "roughness",
    "seed",
    "sharpening",
    "masking",
    "luminanceNoiseReduction",
    "rotate",
    "flipH",
    "flipV",
    "crop",
    "aspect",
    "perspective",
    "constrain",
    "upright",
    "left",
    "top",
    "right",
    "bottom",
    "vertical",
    "horizontal",
    "scale",
    "source",
    "delta",
    "chroma",
    "lightness",
    "chromaScale",
    "distortion",
    "vignetting",
    "vignettingMidpoint",
    "removeChromaticAberration",
    "defringe",
    "hueLo",
    "hueHi",
    "range",
    "falloff",
  ];
  match value {
    Value::Null | Value::Bool(_) | Value::Number(_) => true,
    Value::String(value) => match path {
      ["engine"] => value
        .strip_prefix("niho-")
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=14).contains(&n)),
      ["look"] => [
        "niho-interim-1",
        "niho-standard-1",
        "niho-standard-2",
        "niho-standard-3",
        "niho-standard-5",
      ]
      .contains(&value.as_str()),
      ["whiteBalance", "mode"] => ["asShot", "absolute", "relative"].contains(&value.as_str()),
      ["toneCurves", "[]", "channel"] => ["rgb", "red", "green", "blue"].contains(&value.as_str()),
      ["hsl", "[]"] => {
        ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"].contains(&value.as_str())
      }
      ["vignette", "style"] => ["highlightPriority", "colorPriority", "paintOverlay"].contains(&value.as_str()),
      ["masks", "[]", "kind"] => ["linear", "radial", "brush", "subject", "sky"].contains(&value.as_str()),
      ["heal", "[]", "mode"] => ["remove", "clone"].contains(&value.as_str()),
      ["masks", "[]", "surface", "id"] => is_sha256(value),
      ["masks" | "heal" | "colorPoints", "[]", "id"] => {
        !value.is_empty()
          && value.len() <= 64
          && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
      }
      ["geometry", "aspect"] => {
        ["free", "original", "originalSwapped"].contains(&value.as_str())
          || value.split_once(':').is_some_and(|(w, h)| {
            [w, h]
              .into_iter()
              .all(|n| n.len() <= 4 && n.bytes().all(|b| b.is_ascii_digit()) && n.parse::<u16>().is_ok_and(|n| n > 0))
          })
      }
      _ => false,
    },
    Value::Array(values) => {
      let mut next = path.to_vec();
      next.push("[]");
      values.iter().all(|value| journal_safe_recipe_field(value, &next))
    }
    Value::Object(values) => {
      if path == ["legacySettings"] && !values.is_empty() {
        return false;
      }
      values.iter().all(|(key, value)| {
        if !(if path.is_empty() {
          ROOT.contains(&key.as_str())
        } else {
          NESTED.contains(&key.as_str()) || ROOT.contains(&key.as_str())
        }) {
          return false;
        }
        let mut next = path.to_vec();
        next.push(key);
        journal_safe_recipe_field(value, &next)
      })
    }
  }
}
fn valid_start(intent: &CopyIntent, name: &str, start: &CopyStart) -> bool {
  let body = json!({"target":start.target,"sizeBytes":start.size,"sha256":start.sha,"contentType":start.content_type});
  opaque(&start.key)
    && is_sha256(&start.sha)
    && start.size > 0
    && start.size <= 200 * 1024 * 1024
    && intent
      .keys
      .body_digests
      .get(name)
      .is_some_and(|expected| value_digest(&body).ok().as_ref() == Some(expected))
    && match &start.target {
      NativeCopyTarget::Original { file_name, format } => {
        name == "original.start"
          && file_name == &intent.file_name
          && format == &intent.format
          && start.size == intent.source_size_bytes
          && start.sha == intent.source_sha256
          && start.content_type == intent.content_type
          && start.key == intent.keys.original_start
      }
      NativeCopyTarget::Mask { photo_id } => {
        name == format!("mask.{}.start", start.sha)
          && intent.cloud_photo_id.as_ref() == Some(photo_id)
          && intent.mask_ids.contains(&start.sha)
          && start.content_type == "image/png"
          && start.size <= 8 * 1024 * 1024
      }
    }
}
fn now_ms() -> Result<u64, AccountError> {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .ok()
    .and_then(|value| value.as_millis().try_into().ok())
    .ok_or(AccountError::Internal)
}
fn source_error(error: CopySourceError) -> AccountError {
  match error {
    CopySourceError::TooLarge | CopySourceError::Changed | CopySourceError::Missing => AccountError::Rejected,
    CopySourceError::Cancelled => AccountError::Cancelled,
    CopySourceError::Transfer => AccountError::Storage,
  }
}
fn private_dir(path: &Path) -> Result<(), AccountError> {
  match std::fs::symlink_metadata(path) {
    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
    Ok(_) => return Err(AccountError::Storage),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      std::fs::create_dir_all(path).map_err(|_| AccountError::Storage)?;
      let metadata = std::fs::symlink_metadata(path).map_err(|_| AccountError::Storage)?;
      if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AccountError::Storage);
      }
    }
    Err(_) => return Err(AccountError::Storage),
  }
  std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o700)).map_err(|_| AccountError::Storage)
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Fixture(PathBuf);
  impl Fixture {
    fn new(name: &str) -> Self {
      static NEXT: AtomicU64 = AtomicU64::new(0);
      Self(std::env::temp_dir().join(format!(
        "niho-copy-journal-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
      )))
    }
    fn journal(&self) -> CopyJournal {
      CopyJournal::new(self.0.clone())
    }
  }
  impl Drop for Fixture {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  fn intent(request_id: &str, user_id: &str) -> CopyIntent {
    CopyIntent {
      version: JOURNAL_VERSION,
      revision: 0,
      created_at_ms: 1,
      scope: DurableScope {
        user_id: user_id.into(),
        library_id: "synthetic-library".into(),
        session_id: "synthetic-session".into(),
        session_epoch: "synthetic-epoch".into(),
      },
      request_id: request_id.into(),
      photo_id: "synthetic-photo".into(),
      source_identity: SourceIdentity {
        device: 1,
        inode: 2,
        size: 3,
        modified: (4, 5),
        changed: (6, 7),
      },
      source_sha256: "a".repeat(64),
      source_size_bytes: 3,
      file_name: "synthetic.jpg".into(),
      format: "jpeg".into(),
      content_type: "image/jpeg".into(),
      candidate_supported: true,
      settings: json!({"v":9,"engine":"niho-14","base":null}),
      base_version: None,
      mask_ids: Vec::new(),
      phase: CopyPhase::Pending,
      original: None,
      masks: BTreeMap::new(),
      cloud_photo_id: None,
      recipe_expected_revision: None,
      recipe_baseline: None,
      settings_sha256: value_digest(&json!({"v":9,"engine":"niho-14","base":null})).unwrap(),
      starts: BTreeMap::new(),
      keys: DurableKeys {
        original_start: "fixed-start".into(),
        original_complete: "fixed-complete".into(),
        original_cancel: "fixed-cancel".into(),
        recipe: "fixed-recipe".into(),
        body_digests: BTreeMap::new(),
      },
      confirmed_original: false,
      confirmed_masks: false,
      confirmed_recipe: false,
    }
  }

  #[test]
  fn journal_is_private_atomic_bounded_and_contains_no_transport_or_path_fields() {
    let fixture = Fixture::new("private");
    let journal = fixture.journal();
    let value = intent("request-a", "owner-a");
    journal.create(&value).unwrap();
    let metadata = std::fs::metadata(journal.path("request-a")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    let bytes = std::fs::read(journal.path("request-a")).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    for forbidden in [
      "/synthetic/",
      "https://",
      "bearer",
      "authorization",
      "ticket",
      "sessionUri",
    ] {
      assert!(!text.to_ascii_lowercase().contains(&forbidden.to_ascii_lowercase()));
    }
    let mut oversized = intent("request-large", "owner-a");
    oversized.settings = json!({"v":9,"engine":"niho-14","base":null,"future":"x".repeat(MAX_INTENT_BYTES as usize)});
    assert_eq!(journal.create(&oversized), Err(AccountError::Storage));
  }

  #[test]
  fn compare_and_swap_prevents_an_old_ack_from_replacing_a_newer_intent_revision() {
    let fixture = Fixture::new("cas");
    let journal = fixture.journal();
    let original = intent("request-a", "owner-a");
    journal.create(&original).unwrap();
    let mut newer = original.clone();
    newer.revision = 1;
    newer.phase = CopyPhase::Copying;
    journal.replace(0, &newer).unwrap();
    let mut old_ack = original;
    old_ack.revision = 1;
    old_ack.phase = CopyPhase::Stored;
    assert_eq!(journal.replace(0, &old_ack), Err(AccountError::Cancelled));
    assert_eq!(journal.get("request-a").unwrap().unwrap().phase, CopyPhase::Copying);
  }

  #[test]
  fn durable_body_digest_rejects_rebinding_the_same_operation_key() {
    let mut value = intent("request-a", "owner-a");
    assert!(bind_body_digest(&mut value, "original.start", &json!({"sizeBytes":3})).unwrap());
    assert!(!bind_body_digest(&mut value, "original.start", &json!({"sizeBytes":3})).unwrap());
    assert_eq!(
      bind_body_digest(&mut value, "original.start", &json!({"sizeBytes":4})),
      Err(AccountError::Rejected)
    );
  }

  #[test]
  fn journal_refuses_a_thirty_third_unconfirmed_intent() {
    let fixture = Fixture::new("count-budget");
    let journal = fixture.journal();
    for index in 0..MAX_INTENTS {
      journal.create(&intent(&format!("request-{index}"), "owner-a")).unwrap();
    }
    assert_eq!(journal.list().unwrap().len(), MAX_INTENTS);
    assert_eq!(
      journal.create(&intent("request-over-budget", "owner-a")),
      Err(AccountError::Storage)
    );
  }

  #[test]
  fn recipe_transport_material_is_never_eligible_for_the_journal() {
    assert!(!journal_safe_value(
      &json!({"v":9,"engine":"niho-14","token":"not-persisted"}),
      0
    ));
    assert!(!journal_safe_value(
      &json!({"v":9,"engine":"niho-14","note":"https://invalid.test"}),
      0
    ));
    assert!(journal_safe_value(&json!({"v":9,"engine":"niho-14","base":null}), 0));
    for value in [
      "file:private",
      "data:private",
      "relative/path",
      "secret-token",
      "../original.jpg",
    ] {
      assert!(!journal_safe_value(
        &json!({"v":9,"engine":"niho-14","exposure":value}),
        0
      ));
    }
    assert!(!journal_safe_value(
      &json!({"v":9,"engine":"niho-14","unknown":{"secret":"value"}}),
      0
    ));
    assert!(!journal_safe_value(
      &json!({"v":9,"engine":"niho-14","hsl":{"secret-token":0}}),
      0
    ));
  }

  fn recipe_photo(revision: u64, settings: Value) -> Value {
    json!({"recipe":{"revision":revision,"settingsSha256":value_digest(&settings).unwrap(),
      "settings":settings,"baseVersion":null,"maskSurfaceIds":[]}})
  }

  #[test]
  fn recipe_copy_never_rebases_over_remote_edits_even_after_recovery() {
    let fixture = Fixture::new("recipe-baseline");
    let journal = fixture.journal();
    let mut value = intent("request-a", "owner-a");
    value.settings["exposure"] = json!(1.5);
    value.settings_sha256 = value_digest(&value.settings).unwrap();
    let initial = recipe_photo(0, json!({"v":9,"engine":"niho-14","base":null,"exposure":0}));
    capture_recipe_baseline(&mut value, &initial).unwrap();
    journal.create(&value).unwrap();
    let body = recipe_write_body(&value, &initial).unwrap();
    assert_eq!(body["expectedRevision"], 0);
    let remote_settings = json!({"v":9,"engine":"niho-14","base":null,"exposure":-2});
    for revision in [5, 99] {
      let remote = recipe_photo(revision, remote_settings.clone());
      let mut recovered = journal.get("request-a").unwrap().unwrap();
      capture_recipe_baseline(&mut recovered, &remote).unwrap();
      assert_eq!(recipe_write_body(&recovered, &remote), Err(AccountError::Rejected));
      assert_eq!(recovered.recipe_expected_revision, Some(0));
      assert_eq!(
        recovered.recipe_baseline.as_ref().unwrap().settings,
        initial["recipe"]["settings"]
      );
      assert_eq!(recovered.settings["exposure"], 1.5);
      assert_eq!(remote["recipe"]["settings"], remote_settings);
    }
    // An original found with an already-edited recipe also grants no overwrite.
    let mut existing = intent("request-existing", "owner-a");
    let remote = recipe_photo(5, remote_settings);
    capture_recipe_baseline(&mut existing, &remote).unwrap();
    assert_eq!(recipe_write_body(&existing, &remote), Err(AccountError::Rejected));
  }

  #[test]
  fn canonical_hash_matches_javascript_numbers_and_does_not_trust_response_hash_alone() {
    let numbers: Value =
      serde_json::from_str(r#"{"whites":1e21,"shadows":1e-7,"exposure":1e-6,"contrast":1.0}"#).unwrap();
    assert_eq!(
      value_digest(&numbers).unwrap(),
      "5b668757bdaf8d02d4f5623df387c489c4386c3ed331d56c51fe14429d564e19"
    );
    let mut value = intent("request", "owner");
    value.settings["exposure"] = json!(1.0);
    value.settings_sha256 = value_digest(&value.settings).unwrap();
    let mut photo = recipe_photo(1, value.settings.clone());
    photo["recipe"]["settings"]["exposure"] = json!(1);
    assert!(recipe_matches(&photo, &value));
    photo["recipe"]["settings"]["exposure"] = json!(2);
    assert!(!recipe_matches(&photo, &value));
    photo["recipe"]["settings"] = value.settings.clone();
    photo["recipe"]["settingsSha256"] = json!("0".repeat(64));
    assert!(!recipe_matches(&photo, &value));
  }

  #[test]
  fn cancel_replays_a_start_whose_ack_lost_to_the_cancel_cas() {
    let fixture = Fixture::new("cancel-lost-start");
    let journal = fixture.journal();
    let mut value = intent("request", "owner");
    let start = CopyStart {
      target: NativeCopyTarget::Original {
        file_name: value.file_name.clone(),
        format: value.format.clone(),
      },
      size: 3,
      sha: value.source_sha256.clone(),
      content_type: value.content_type.clone(),
      key: value.keys.original_start.clone(),
    };
    bind_body_digest(
      &mut value,
      "original.start",
      &json!({"target":start.target,"sizeBytes":start.size,"sha256":start.sha,"contentType":start.content_type}),
    )
    .unwrap();
    value.starts.insert("original.start".into(), start.clone());
    journal.create(&value).unwrap();
    let mut cancelled = value.clone();
    transition(&journal, &mut cancelled, CopyPhase::CancelPending).unwrap();
    value.original = Some(UploadFact {
      upload_id: "reserved-upload".into(),
      uploaded_bytes: 0,
      stored: false,
    });
    assert_eq!(persist(&journal, &mut value), Err(AccountError::Cancelled));
    let mut recovered = journal.get("request").unwrap().unwrap();
    let mut calls = 0;
    let retained = reconcile_cancel_starts(&journal, &mut recovered, |replayed, _| {
      calls += 1;
      assert_eq!(replayed.key, start.key);
      assert_eq!(replayed.sha, start.sha);
      Ok(NativeStartUpload::Upload {
        upload: NativeUpload {
          id: "reserved-upload".into(),
          target: start.target.clone(),
          size_bytes: 3,
          sha256: start.sha.clone(),
          expires_at: "2099-01-01T00:00:00Z".into(),
          state: NativeUploadState::Reserved { uploaded_bytes: 0 },
        },
        ticket: None,
      })
    })
    .unwrap();
    assert!(!retained);
    assert_eq!(calls, 1);
    assert_eq!(recovered.phase, CopyPhase::CancelPending);
    assert_eq!(recovered.original.as_ref().unwrap().upload_id, "reserved-upload");
    // The reservation is now known and still needs a confirmed cancel ACK.
    assert!(!terminal_intent(&journal.get("request").unwrap().unwrap()));
  }

  #[test]
  fn cancel_retains_an_existing_original_found_by_replaying_a_lost_start_ack() {
    let fixture = Fixture::new("cancel-existing");
    let journal = fixture.journal();
    let mut value = intent("request", "owner");
    let start = CopyStart {
      target: NativeCopyTarget::Original {
        file_name: value.file_name.clone(),
        format: value.format.clone(),
      },
      size: 3,
      sha: value.source_sha256.clone(),
      content_type: value.content_type.clone(),
      key: value.keys.original_start.clone(),
    };
    bind_body_digest(
      &mut value,
      "original.start",
      &json!({"target":start.target,"sizeBytes":start.size,"sha256":start.sha,"contentType":start.content_type}),
    )
    .unwrap();
    value.starts.insert("original.start".into(), start);
    value.phase = CopyPhase::CancelPending;
    journal.create(&value).unwrap();
    let photo = json!({"id":"existing-photo","libraryId":value.scope.library_id,"storageState":"stored",
      "format":"jpeg","fileName":"renamed-original.jpg","original":{"id":"original-asset","kind":"original",
      "sha256":value.source_sha256,"sizeBytes":3,"contentType":"image/jpeg"}});
    assert!(
      reconcile_cancel_starts(&journal, &mut value, |_, _| Ok(NativeStartUpload::Existing {
        photo: photo.clone()
      }))
      .unwrap()
    );
    let recovered = journal.get("request").unwrap().unwrap();
    assert_eq!(recovered.cloud_photo_id.as_deref(), Some("existing-photo"));
    assert_eq!(recovered.phase, CopyPhase::CancelPending);
    assert!(!terminal_intent(&recovered));
    assert_eq!(recovered.settings, intent("unused", "owner").settings);
  }

  #[test]
  fn recovery_filter_neither_returns_nor_counts_another_owner() {
    let fixture = Fixture::new("owners");
    let journal = fixture.journal();
    journal.create(&intent("request-a", "owner-a")).unwrap();
    journal.create(&intent("request-b", "owner-b")).unwrap();
    let requested = CopyScope {
      user_id: "owner-a".into(),
      library_id: "synthetic-library".into(),
      session_id: "fresh-session".into(),
      session_epoch: "fresh-epoch".into(),
      transport: niho_desktop_account::PhotoIdentityTransport::MacBearer,
    };
    let visible: Vec<_> = journal
      .list()
      .unwrap()
      .into_iter()
      .filter(|item| item.scope.same_owner(&requested))
      .collect();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].request_id, "request-a");
  }

  #[test]
  fn symlink_or_unusable_journal_root_fails_closed_without_removing_it() {
    let fixture = Fixture::new("nofollow");
    let target = fixture.0.with_extension("target");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &fixture.0).unwrap();
    assert_eq!(
      fixture.journal().create(&intent("request", "owner")),
      Err(AccountError::Storage)
    );
    assert!(std::fs::symlink_metadata(&fixture.0).unwrap().file_type().is_symlink());
    let _ = std::fs::remove_file(&fixture.0);
    let _ = std::fs::remove_dir(&target);
  }

  #[test]
  fn stored_status_requires_all_three_fresh_confirmations() {
    let mut value = intent("request", "owner");
    value.phase = CopyPhase::Stored;
    value.cloud_photo_id = Some("cloud-photo".into());
    assert!(status(&value).completed.is_none());
    value.confirmed_original = true;
    value.confirmed_masks = true;
    value.confirmed_recipe = true;
    let completed = status(&value).completed.unwrap();
    assert!(completed.original && completed.masks && completed.recipe);
    assert_eq!(completed.cloud_photo_id, "cloud-photo");
  }

  #[test]
  fn full_recipe_match_requires_exact_settings_base_and_all_mask_ids() {
    let mut value = intent("request", "owner");
    value.settings = json!({"v":9,"engine":"niho-14","base":null,"masks":[{"kind":"brush","surface":{"id":"a"}}]});
    value.mask_ids = vec!["a".into()];
    value.settings_sha256 = value_digest(&value.settings).unwrap();
    let photo = json!({"recipe":{"settings":value.settings.clone(),"settingsSha256":value.settings_sha256,"baseVersion":null,"maskSurfaceIds":["a"]}});
    assert!(recipe_matches(&photo, &value));
    assert!(!recipe_matches(
      &json!({"recipe":{"settings":value.settings.clone(),"baseVersion":null,"maskSurfaceIds":[]}}),
      &value
    ));
  }
}
