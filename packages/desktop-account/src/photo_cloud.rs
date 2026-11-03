use crate::connect::equal;
use crate::{AccountError, ClientId, Config, PhotoIdentityTransport, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc,
};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const API_PREFIX: &str = "/api/me/photo-cloud/v2";
const JSON_LIST_MAX: u64 = 4 * 1024 * 1024;
const JSON_SUCCESS_MAX: u64 = 2 * 1024 * 1024;
const RECIPE_BODY_MAX: usize = 2 * 1024 * 1024;
const SMALL_BODY_MAX: usize = 64 * 1024;
const ERROR_BODY_MAX: u64 = 64 * 1024;
const CONTENT_MAX: u64 = 200 * 1024 * 1024;
const MAX_DEPTH: usize = 38;
const MAX_OPAQUE_DEPTH: usize = 32;
const MAX_LEAF_BYTES: usize = 1024 * 1024;
const WORKING_META_MAX: usize = 64 * 1024;
const MAX_PAGE_ITEMS: usize = 60;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const ACTOR_HEADER: &str = "X-NIHO-Photo-Actor-Id";
const SESSION_HEADER: &str = "X-NIHO-Photo-Session-Id";
const EPOCH_HEADER: &str = "X-NIHO-Photo-Session-Epoch";
const IDEMPOTENCY_HEADER: &str = "Idempotency-Key";
const SHA_HEADER: &str = "X-NIHO-Photo-Sha256";
const TOTAL_HEADER: &str = "X-NIHO-Photo-Total-Bytes";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhotoScopeCapture {
  pub user_id: String,
  pub session_id: String,
  pub session_epoch: String,
  pub transport: PhotoIdentityTransport,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum PhotoOperation {
  #[serde(rename = "library.get")]
  LibraryGet,
  #[serde(rename = "photos.list")]
  PhotosList,
  #[serde(rename = "photos.get")]
  PhotosGet,
  #[serde(rename = "photos.info")]
  PhotosInfo,
  #[serde(rename = "photos.lookup")]
  PhotosLookup,
  #[serde(rename = "recipes.put")]
  RecipesPut,
  #[serde(rename = "recipe-conflicts.list")]
  RecipeConflictsList,
  #[serde(rename = "recipe-conflicts.get")]
  RecipeConflictsGet,
  #[serde(rename = "recipe-conflicts.resolve")]
  RecipeConflictsResolve,
  #[serde(rename = "photos.delete")]
  PhotosDelete,
}

impl PhotoOperation {
  fn mutation(self) -> bool {
    matches!(
      self,
      Self::RecipesPut | Self::RecipeConflictsResolve | Self::PhotosDelete
    )
  }
}

#[derive(Debug)]
pub struct PhotoRequest {
  operation: PhotoOperation,
  route: Route,
  body: Option<Vec<u8>>,
  idempotency_key: Option<String>,
}

#[derive(Debug)]
enum Route {
  Library,
  PhotosList(PhotosList),
  Photo {
    photo_id: String,
    info: bool,
  },
  Lookup,
  Recipe {
    photo_id: String,
  },
  Conflicts {
    photo_id: String,
    cursor: Option<String>,
    limit: Option<u8>,
  },
  Conflict {
    photo_id: String,
    conflict_id: String,
    resolve: bool,
  },
  Delete {
    photo_id: String,
  },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Empty {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotosList {
  cursor: Option<String>,
  limit: Option<u8>,
  sort: Option<String>,
  formats: Option<Vec<String>>,
  edited: Option<bool>,
  editable: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PhotoId {
  photo_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lookup {
  sha256s: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecipePut {
  photo_id: String,
  expected_revision: u64,
  settings: Value,
  base_version: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecipePutBody<'a> {
  expected_revision: u64,
  settings: &'a Value,
  base_version: &'a Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictList {
  photo_id: String,
  cursor: Option<String>,
  limit: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictGet {
  photo_id: String,
  conflict_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictResolve {
  photo_id: String,
  conflict_id: String,
  expected_revision: u64,
  decision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictResolveBody<'a> {
  expected_revision: u64,
  decision: &'a str,
}

impl PhotoRequest {
  pub(crate) fn operation(&self) -> PhotoOperation {
    self.operation
  }

  pub fn parse(
    operation: PhotoOperation,
    request: Value,
    idempotency_key: Option<String>,
  ) -> Result<Self, AccountError> {
    let key = match (operation.mutation(), idempotency_key) {
      (true, Some(key)) if valid_key(&key) => Some(key),
      (false, None) => None,
      _ => return Err(AccountError::InvalidResponse),
    };
    let (route, body) = match operation {
      PhotoOperation::LibraryGet => {
        parse::<Empty>(request)?;
        (Route::Library, None)
      }
      PhotoOperation::PhotosList => {
        let list = parse::<PhotosList>(request)?;
        validate_list(&list)?;
        (Route::PhotosList(list), None)
      }
      PhotoOperation::PhotosGet | PhotoOperation::PhotosInfo => {
        let value = parse::<PhotoId>(request)?;
        valid_id(&value.photo_id)?;
        (
          Route::Photo {
            photo_id: value.photo_id,
            info: operation == PhotoOperation::PhotosInfo,
          },
          None,
        )
      }
      PhotoOperation::PhotosLookup => {
        let value = parse::<Lookup>(request)?;
        if value.sha256s.is_empty()
          || value.sha256s.len() > 100
          || value.sha256s.iter().any(|value| !is_sha256(value))
          || value.sha256s.iter().collect::<std::collections::BTreeSet<_>>().len() != value.sha256s.len()
        {
          return Err(AccountError::InvalidResponse);
        }
        (Route::Lookup, Some(json_body(&value, SMALL_BODY_MAX)?))
      }
      PhotoOperation::RecipesPut => {
        let value = parse::<RecipePut>(request)?;
        valid_id(&value.photo_id)?;
        if value.expected_revision > MAX_SAFE_INTEGER
          || !value.base_version.is_null() && value.base_version.as_str().is_none_or(|value| valid_id(value).is_err())
          || validate_recipe_settings(&value.settings).is_err()
        {
          return Err(AccountError::InvalidResponse);
        }
        validate_opaque_json(&value.settings)?;
        let body = json_body(
          &RecipePutBody {
            expected_revision: value.expected_revision,
            settings: &value.settings,
            base_version: &value.base_version,
          },
          RECIPE_BODY_MAX,
        )?;
        (
          Route::Recipe {
            photo_id: value.photo_id,
          },
          Some(body),
        )
      }
      PhotoOperation::RecipeConflictsList => {
        let value = parse::<ConflictList>(request)?;
        valid_id(&value.photo_id)?;
        if value.cursor.as_deref().is_some_and(|value| valid_id(value).is_err())
          || value
            .limit
            .is_some_and(|value| value == 0 || value > MAX_PAGE_ITEMS as u8)
        {
          return Err(AccountError::InvalidResponse);
        }
        (
          Route::Conflicts {
            photo_id: value.photo_id,
            cursor: value.cursor,
            limit: value.limit,
          },
          None,
        )
      }
      PhotoOperation::RecipeConflictsGet => {
        let value = parse::<ConflictGet>(request)?;
        valid_id(&value.photo_id)?;
        valid_id(&value.conflict_id)?;
        (
          Route::Conflict {
            photo_id: value.photo_id,
            conflict_id: value.conflict_id,
            resolve: false,
          },
          None,
        )
      }
      PhotoOperation::RecipeConflictsResolve => {
        let value = parse::<ConflictResolve>(request)?;
        valid_id(&value.photo_id)?;
        valid_id(&value.conflict_id)?;
        if value.expected_revision > MAX_SAFE_INTEGER || value.decision != "adopt" && value.decision != "keep-current" {
          return Err(AccountError::InvalidResponse);
        }
        let body = json_body(
          &ConflictResolveBody {
            expected_revision: value.expected_revision,
            decision: &value.decision,
          },
          SMALL_BODY_MAX,
        )?;
        (
          Route::Conflict {
            photo_id: value.photo_id,
            conflict_id: value.conflict_id,
            resolve: true,
          },
          Some(body),
        )
      }
      PhotoOperation::PhotosDelete => {
        let value = parse::<PhotoId>(request)?;
        valid_id(&value.photo_id)?;
        (
          Route::Delete {
            photo_id: value.photo_id,
          },
          None,
        )
      }
    };
    Ok(Self {
      operation,
      route,
      body,
      idempotency_key: key,
    })
  }
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, AccountError> {
  serde_json::from_value(value).map_err(|_| AccountError::InvalidResponse)
}

fn json_body<T: Serialize>(value: &T, max: usize) -> Result<Vec<u8>, AccountError> {
  let body = serde_json::to_vec(value).map_err(|_| AccountError::Internal)?;
  if body.len() > max {
    return Err(AccountError::InvalidResponse);
  }
  Ok(body)
}

fn validate_list(value: &PhotosList) -> Result<(), AccountError> {
  if value.cursor.as_deref().is_some_and(|value| valid_id(value).is_err())
    || value
      .limit
      .is_some_and(|value| value == 0 || value > MAX_PAGE_ITEMS as u8)
    || value
      .sort
      .as_deref()
      .is_some_and(|value| value != "added-desc" && value != "captured-desc")
    || value.formats.as_ref().is_some_and(|formats| {
      formats.is_empty()
        || formats
          .iter()
          .any(|value| !matches!(value.as_str(), "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw"))
    })
  {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoJsonResponse {
  pub status: u16,
  pub body: Value,
}

#[derive(Clone, Debug)]
pub struct PhotoDownloadCancel(Arc<AtomicBool>);

impl Default for PhotoDownloadCancel {
  fn default() -> Self {
    Self(Arc::new(AtomicBool::new(false)))
  }
}

impl PhotoDownloadCancel {
  pub fn cancel(&self) {
    self.0.store(true, Ordering::SeqCst);
  }

  pub(crate) fn check(&self) -> Result<(), AccountError> {
    if self.0.load(Ordering::SeqCst) {
      Err(AccountError::Cancelled)
    } else {
      Ok(())
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PhotoContentMetadata {
  pub photo_id: String,
  pub asset_id: String,
  pub sha256: String,
  pub size_bytes: u64,
  pub content_type: String,
}

#[derive(Clone)]
pub(crate) struct CapturedPhotoAuthority {
  pub generation: u64,
  pub access: Secret,
  pub connection_id: String,
  pub user_id: String,
  pub scope: PhotoScopeCapture,
}

pub(crate) struct NativePhotoRequest {
  pub method: &'static str,
  pub url: url::Url,
  pub body: Option<Vec<u8>>,
  pub idempotency_key: Option<String>,
  pub capture: PhotoScopeCapture,
}

pub(crate) struct PhotoHttpResponse {
  pub status: u16,
  pub content_length: Option<u64>,
  pub content_type: Option<String>,
  pub sha256: Option<String>,
  pub total_bytes: Option<String>,
  pub body: Box<dyn Read + Send>,
}

struct DeadlineReader {
  inner: Box<dyn Read + Send>,
  deadline: Instant,
}

impl DeadlineReader {
  fn new(inner: Box<dyn Read + Send>, deadline: Instant) -> Self {
    Self { inner, deadline }
  }
}

impl Read for DeadlineReader {
  fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
    if Instant::now() >= self.deadline {
      return Err(io::Error::new(io::ErrorKind::TimedOut, "photo response deadline"));
    }
    let result = self.inner.read(buffer);
    if Instant::now() >= self.deadline {
      return Err(io::Error::new(io::ErrorKind::TimedOut, "photo response deadline"));
    }
    result
  }
}

pub(crate) trait PhotoHttpTransport: Send + Sync {
  fn send(
    &self,
    config: &Config,
    bearer: &Secret,
    request: &NativePhotoRequest,
    content: bool,
  ) -> Result<PhotoHttpResponse, AccountError>;
}

pub(crate) struct HttpPhotoCloud;

impl PhotoHttpTransport for HttpPhotoCloud {
  fn send(
    &self,
    config: &Config,
    bearer: &Secret,
    request: &NativePhotoRequest,
    content: bool,
  ) -> Result<PhotoHttpResponse, AccountError> {
    if config.client != ClientId::Camera || !valid_fixed_url(config, &request.url) {
      return Err(AccountError::InvalidConfig);
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let whole_timeout = Duration::from_secs(if content { 600 } else { 15 });
    let deadline = Instant::now() + whole_timeout;
    let mut builder = reqwest::blocking::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(5))
      .timeout(Duration::from_secs(15))
      .no_proxy();
    builder = builder.https_only(true);
    let client = builder.build().map_err(|_| AccountError::Network)?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| AccountError::Internal)?;
    let mut outgoing = client
      .request(method, request.url.clone())
      .header(
        "Accept",
        if content {
          "application/octet-stream"
        } else {
          "application/json"
        },
      )
      .header(ACTOR_HEADER, &request.capture.user_id)
      .header(SESSION_HEADER, &request.capture.session_id)
      .header(EPOCH_HEADER, &request.capture.session_epoch)
      .bearer_auth(bearer.expose());
    if let Some(key) = &request.idempotency_key {
      outgoing = outgoing.header(IDEMPOTENCY_HEADER, key);
    }
    if let Some(body) = &request.body {
      outgoing = outgoing.header("Content-Type", "application/json").body(body.clone());
    }
    let response = outgoing.send().map_err(|_| AccountError::Network)?;
    if Instant::now() >= deadline {
      return Err(AccountError::Network);
    }
    let status = response.status().as_u16();
    let content_length = response.content_length();
    let content_type = header(&response, "content-type");
    let sha256 = header(&response, SHA_HEADER);
    let total_bytes = header(&response, TOTAL_HEADER);
    Ok(PhotoHttpResponse {
      status,
      content_length,
      content_type,
      sha256,
      total_bytes,
      body: Box::new(DeadlineReader::new(Box::new(response), deadline)),
    })
  }
}

fn header(response: &reqwest::blocking::Response, name: &str) -> Option<String> {
  response.headers().get(name)?.to_str().ok().map(str::to_owned)
}

fn valid_fixed_url(config: &Config, url: &url::Url) -> bool {
  let origin = config.api_url("/");
  url.scheme() == "https"
    && url.origin() == origin.origin()
    && url.path().starts_with(&format!("{API_PREFIX}/"))
    && url.fragment().is_none()
    && url.username().is_empty()
    && url.password().is_none()
}

pub(crate) fn native_request(
  config: &Config,
  capture: &PhotoScopeCapture,
  request: &PhotoRequest,
) -> NativePhotoRequest {
  let mut url = config.api_url(API_PREFIX);
  {
    let mut segments = url.path_segments_mut().expect("fixed HTTPS base");
    match &request.route {
      Route::Library => {
        segments.push("library");
      }
      Route::PhotosList(_) => {
        segments.push("photos");
      }
      Route::Photo { photo_id, info } => {
        segments.push("photos").push(photo_id);
        if *info {
          segments.push("info");
        }
      }
      Route::Lookup => {
        segments.push("photos").push("lookup");
      }
      Route::Recipe { photo_id } => {
        segments.push("photos").push(photo_id).push("recipe");
      }
      Route::Conflicts { photo_id, .. } => {
        segments.push("photos").push(photo_id).push("recipe-conflicts");
      }
      Route::Conflict {
        photo_id,
        conflict_id,
        resolve,
      } => {
        segments
          .push("photos")
          .push(photo_id)
          .push("recipe-conflicts")
          .push(conflict_id);
        if *resolve {
          segments.push("resolve");
        }
      }
      Route::Delete { photo_id } => {
        segments.push("photos").push(photo_id);
      }
    }
  }
  match &request.route {
    Route::PhotosList(list) => {
      let mut query = url.query_pairs_mut();
      if let Some(value) = &list.cursor {
        query.append_pair("cursor", value);
      }
      if let Some(value) = list.limit {
        query.append_pair("limit", &value.to_string());
      }
      if let Some(value) = &list.sort {
        query.append_pair("sort", value);
      }
      if let Some(values) = &list.formats {
        for value in values {
          query.append_pair("formats", value);
        }
      }
      if let Some(value) = list.edited {
        query.append_pair("edited", if value { "true" } else { "false" });
      }
      if let Some(value) = list.editable {
        query.append_pair("editable", if value { "true" } else { "false" });
      }
    }
    Route::Conflicts { cursor, limit, .. } => {
      let mut query = url.query_pairs_mut();
      if let Some(value) = cursor {
        query.append_pair("cursor", value);
      }
      if let Some(value) = limit {
        query.append_pair("limit", &value.to_string());
      }
    }
    _ => {}
  }
  let method = match request.operation {
    PhotoOperation::LibraryGet
    | PhotoOperation::PhotosList
    | PhotoOperation::PhotosGet
    | PhotoOperation::PhotosInfo
    | PhotoOperation::RecipeConflictsList
    | PhotoOperation::RecipeConflictsGet => "GET",
    PhotoOperation::PhotosLookup | PhotoOperation::RecipeConflictsResolve => "POST",
    PhotoOperation::RecipesPut => "PUT",
    PhotoOperation::PhotosDelete => "DELETE",
  };
  NativePhotoRequest {
    method,
    url,
    body: request.body.clone(),
    idempotency_key: request.idempotency_key.clone(),
    capture: capture.clone(),
  }
}

pub(crate) fn content_request(
  config: &Config,
  capture: &PhotoScopeCapture,
  photo_id: &str,
  asset_id: &str,
) -> NativePhotoRequest {
  let mut url = config.api_url(API_PREFIX);
  url
    .path_segments_mut()
    .expect("fixed HTTPS base")
    .push("photos")
    .push(photo_id)
    .push("assets")
    .push(asset_id)
    .push("content");
  NativePhotoRequest {
    method: "GET",
    url,
    body: None,
    idempotency_key: None,
    capture: capture.clone(),
  }
}

pub(crate) fn read_json_response(
  response: PhotoHttpResponse,
  operation: PhotoOperation,
) -> Result<PhotoJsonResponse, AccountError> {
  let success = (200..300).contains(&response.status);
  let limit = if !success {
    ERROR_BODY_MAX
  } else if matches!(
    operation,
    PhotoOperation::PhotosList
      | PhotoOperation::RecipeConflictsList
      | PhotoOperation::RecipeConflictsGet
      | PhotoOperation::RecipeConflictsResolve
  ) {
    JSON_LIST_MAX
  } else {
    JSON_SUCCESS_MAX
  };
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
  let value: Value = serde_json::from_slice(&bytes).map_err(|_| AccountError::InvalidResponse)?;
  validate_json_shape(&value, 0, MAX_DEPTH)?;
  validate_no_transport_material(&value, false)?;
  if success {
    if response.status != 200 {
      return Err(AccountError::InvalidResponse);
    }
    validate_success(operation, &value)?;
  } else {
    validate_error(&value)?;
  }
  Ok(PhotoJsonResponse {
    status: response.status,
    body: value,
  })
}

pub(crate) fn stream_verified_content<W: Write>(
  mut response: PhotoHttpResponse,
  expected: &PhotoContentMetadata,
  writer: &mut W,
  cancel: &PhotoDownloadCancel,
  mut current: impl FnMut() -> Result<(), AccountError>,
) -> Result<(), AccountError> {
  if response.status != 200
    || response.content_length != Some(expected.size_bytes)
    || response.sha256.as_deref() != Some(expected.sha256.as_str())
    || response.total_bytes.as_deref().and_then(strict_u64) != Some(expected.size_bytes)
    || response.content_type.as_deref() != Some(expected.content_type.as_str())
    || expected.size_bytes == 0
    || expected.size_bytes > CONTENT_MAX
  {
    return Err(AccountError::InvalidResponse);
  }
  let mut hasher = Sha256::new();
  let mut total = 0_u64;
  let mut buffer = [0_u8; 64 * 1024];
  loop {
    cancel.check()?;
    current()?;
    let count = response.body.read(&mut buffer).map_err(|_| AccountError::Network)?;
    if count == 0 {
      break;
    }
    total = total.checked_add(count as u64).ok_or(AccountError::InvalidResponse)?;
    if total > expected.size_bytes || total > CONTENT_MAX {
      return Err(AccountError::InvalidResponse);
    }
    hasher.update(&buffer[..count]);
    writer.write_all(&buffer[..count]).map_err(|_| AccountError::Storage)?;
  }
  cancel.check()?;
  current()?;
  let digest = format!("{:x}", hasher.finalize());
  if total != expected.size_bytes || !equal(&digest, &expected.sha256) {
    return Err(AccountError::InvalidResponse);
  }
  writer.flush().map_err(|_| AccountError::Storage)
}

pub(crate) fn original_metadata(
  value: &Value,
  photo_id: &str,
  asset_id: &str,
) -> Result<PhotoContentMetadata, AccountError> {
  validate_photo(value)?;
  let photo = object(value)?;
  if string(photo, "id")? != photo_id {
    return Err(AccountError::InvalidResponse);
  }
  let original = object(photo.get("original").ok_or(AccountError::InvalidResponse)?)?;
  if string(original, "id")? != asset_id || string(original, "kind")? != "original" {
    return Err(AccountError::InvalidResponse);
  }
  let sha256 = string(original, "sha256")?.to_owned();
  let size_bytes = integer(original, "sizeBytes")?;
  let content_type = string(original, "contentType")?.to_owned();
  if !is_sha256(&sha256) || size_bytes == 0 || size_bytes > CONTENT_MAX || !valid_content_type(&content_type) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(PhotoContentMetadata {
    photo_id: photo_id.to_owned(),
    asset_id: asset_id.to_owned(),
    sha256,
    size_bytes,
    content_type,
  })
}

pub(crate) fn original_metadata_for_photo(
  value: &Value,
  photo_id: &str,
) -> Result<(PhotoContentMetadata, String), AccountError> {
  validate_photo(value)?;
  let photo = object(value)?;
  if string(photo, "id")? != photo_id {
    return Err(AccountError::InvalidResponse);
  }
  let file_name = string(photo, "fileName")?.to_owned();
  let original = object(photo.get("original").ok_or(AccountError::InvalidResponse)?)?;
  let asset_id = string(original, "id")?;
  Ok((original_metadata(value, photo_id, asset_id)?, file_name))
}

fn validate_success(operation: PhotoOperation, value: &Value) -> Result<(), AccountError> {
  match operation {
    PhotoOperation::LibraryGet => validate_library(value),
    PhotoOperation::PhotosList => {
      exact(value, &["items", "nextCursor", "libraryRevision", "usage"])?;
      array(value, "items", validate_photo)?;
      validate_usage(field(value, "usage")?)
    }
    PhotoOperation::PhotosGet => validate_photo(value),
    PhotoOperation::PhotosInfo => {
      exact_subset(
        value,
        &[
          "camera",
          "lens",
          "iso",
          "exposureTimeSeconds",
          "fNumber",
          "focalLengthMm",
          "capturedAt",
          "width",
          "height",
          "gps",
        ],
      )?;
      if let Some(camera) = object(value)?.get("camera").filter(|value| !value.is_null()) {
        exact(camera, &["make", "model"])?;
      }
      if let Some(gps) = object(value)?.get("gps").filter(|value| !value.is_null()) {
        exact(gps, &["latitude", "longitude"])?;
      }
      Ok(())
    }
    PhotoOperation::PhotosLookup => {
      exact(value, &["matches"])?;
      array_max(value, "matches", 100, |item| {
        exact(item, &["sha256", "photoId", "recipeRevision"])
      })
    }
    PhotoOperation::RecipesPut => validate_receipt(value, validate_photo),
    PhotoOperation::RecipeConflictsList => {
      exact(value, &["items", "nextCursor", "currentRevision"])?;
      array(value, "items", validate_conflict)
    }
    PhotoOperation::RecipeConflictsGet => validate_conflict(value),
    PhotoOperation::RecipeConflictsResolve => validate_receipt(value, |value| {
      exact(value, &["conflict", "recipe"])?;
      validate_conflict(field(value, "conflict")?)?;
      validate_recipe(field(value, "recipe")?)
    }),
    PhotoOperation::PhotosDelete => {
      exact(value, &["state"])?;
      if string(object(value)?, "state")? != "purged" {
        return Err(AccountError::InvalidResponse);
      }
      Ok(())
    }
  }
}

fn validate_library(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &[
      "contractVersion",
      "id",
      "owner",
      "state",
      "revision",
      "usage",
      "limits",
      "capabilities",
    ],
  )?;
  exact(field(value, "owner")?, &["type", "userId"])?;
  validate_usage(field(value, "usage")?)?;
  exact(
    field(value, "limits")?,
    &[
      "quotaBytes",
      "maxFileBytes",
      "maxPixels",
      "browserDirectMaxPixels",
      "workingCopyMaxEdge",
      "previewMaxEdge",
      "thumbnailMaxEdge",
      "maxMaskBytes",
      "maxMaskEdge",
      "maxRecipeBytes",
      "maxVersionsBytes",
      "maxRecipeBodyBytes",
      "maxVersionsBodyBytes",
      "maxOtherBodyBytes",
      "maxVersions",
      "maxJsonDepth",
      "maxFileNameBytes",
      "maxVersionNameBytes",
      "maxIdempotencyKeyBytes",
      "listMaxCount",
      "maxPageBytes",
      "maxWorkingCopyMetaBytes",
      "lookupMaxCount",
      "reservationLifetimeSeconds",
      "completionGraceSeconds",
      "downloadTicketMaxSeconds",
      "cursorLifetimeSeconds",
    ],
  )?;
  let capabilities = field(value, "capabilities")?;
  exact(
    capabilities,
    &[
      "formats",
      "renderer",
      "edits",
      "versions",
      "maskSurfaces",
      "albums",
      "publicSharing",
    ],
  )?;
  array(capabilities, "formats", |item| {
    exact(item, &["format", "extensions", "ingest", "workingCopy"])?;
    string_array(field(item, "extensions")?)
  })?;
  validate_renderer(field(capabilities, "renderer")?)
}

fn validate_usage(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &[
      "quotaBytes",
      "usedBytes",
      "originalBytes",
      "maskBytes",
      "pendingPurgeBytes",
      "reservedBytes",
      "availableBytes",
    ],
  )
}

fn validate_renderer(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &[
      "sdkVersion",
      "crateVersion",
      "manifestSha256",
      "settingsVersions",
      "engines",
      "features",
      "maskKinds",
      "maskSurfaces",
    ],
  )?;
  integer_array(field(value, "settingsVersions")?)?;
  string_array(field(value, "engines")?)?;
  string_array(field(value, "features")?)?;
  string_array(field(value, "maskKinds")?)
}

fn validate_asset(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &["id", "kind", "sha256", "sizeBytes", "contentType", "width", "height"],
  )?;
  if !matches!(
    string(object(value)?, "kind")?,
    "original" | "mask" | "thumbnail" | "preview" | "working-copy"
  ) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn validate_recipe(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &[
      "revision",
      "settings",
      "settingsSha256",
      "baseVersion",
      "maskSurfaceIds",
      "updatedAt",
    ],
  )?;
  validate_recipe_settings(field(value, "settings")?)?;
  validate_opaque_json(field(value, "settings")?)?;
  string_array(field(value, "maskSurfaceIds")?)
}

fn validate_photo(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &[
      "id",
      "libraryId",
      "storageState",
      "lifecycle",
      "fileName",
      "format",
      "hasEdits",
      "addedAt",
      "capturedAt",
      "width",
      "height",
      "original",
      "recipe",
      "media",
    ],
  )?;
  let photo = object(value)?;
  if string(photo, "storageState")? != "stored"
    || string(photo, "lifecycle")? != "active"
    || !matches!(
      string(photo, "format")?,
      "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw"
    )
  {
    return Err(AccountError::InvalidResponse);
  }
  let original = field(value, "original")?;
  validate_asset(original)?;
  if string(object(original)?, "kind")? != "original" {
    return Err(AccountError::InvalidResponse);
  }
  validate_recipe(field(value, "recipe")?)?;
  validate_media(field(value, "media")?)
}

fn validate_media(value: &Value) -> Result<(), AccountError> {
  let state = string(object(value)?, "state")?;
  match state {
    "pending" => exact(value, &["state"]),
    "queued" | "processing" => exact(value, &["state", "jobId"]),
    "failed" | "unsupported" => {
      exact(value, &["state", "code"])?;
      if !matches!(
        string(object(value)?, "code")?,
        "decoder_failed" | "renderer_unavailable" | "unsupported_settings"
      ) {
        return Err(AccountError::InvalidResponse);
      }
      Ok(())
    }
    "ready" => {
      exact(
        value,
        &[
          "state",
          "thumbnail",
          "preview",
          "workingCopy",
          "recipeRevision",
          "rendererManifestSha256",
        ],
      )?;
      let thumbnail = field(value, "thumbnail")?;
      let preview = field(value, "preview")?;
      validate_asset(thumbnail)?;
      validate_asset(preview)?;
      if string(object(thumbnail)?, "kind")? != "thumbnail" || string(object(preview)?, "kind")? != "preview" {
        return Err(AccountError::InvalidResponse);
      }
      let working = field(value, "workingCopy")?;
      if !working.is_null() {
        exact(working, &["asset", "baseVersion", "encoding", "meta"])?;
        let asset = field(working, "asset")?;
        validate_asset(asset)?;
        if string(object(asset)?, "kind")? != "working-copy"
          || !matches!(string(object(working)?, "encoding")?, "png16" | "jpeg8")
        {
          return Err(AccountError::InvalidResponse);
        }
        validate_opaque_json_limit(field(working, "meta")?, WORKING_META_MAX)?;
      }
      Ok(())
    }
    _ => Err(AccountError::InvalidResponse),
  }
}

fn validate_candidate(value: &Value) -> Result<(), AccountError> {
  exact(value, &["settings", "baseVersion", "settingsSha256", "maskSurfaceIds"])?;
  validate_recipe_settings(field(value, "settings")?)?;
  validate_opaque_json(field(value, "settings")?)?;
  string_array(field(value, "maskSurfaceIds")?)
}

fn validate_conflict(value: &Value) -> Result<(), AccountError> {
  exact(
    value,
    &[
      "id",
      "expectedRevision",
      "currentRevision",
      "conflictingRecipe",
      "currentRecipe",
      "createdAt",
      "resolution",
      "resolvedAt",
      "resultingRevision",
    ],
  )?;
  validate_candidate(field(value, "conflictingRecipe")?)?;
  validate_recipe(field(value, "currentRecipe")?)
}

fn validate_receipt(value: &Value, inner: impl FnOnce(&Value) -> Result<(), AccountError>) -> Result<(), AccountError> {
  exact(value, &["value", "replayed"])?;
  inner(field(value, "value")?)
}

fn validate_error(value: &Value) -> Result<(), AccountError> {
  exact(value, &["error"])?;
  let error = field(value, "error")?;
  exact_subset(
    error,
    &[
      "code",
      "requestId",
      "retryable",
      "currentRevision",
      "conflictId",
      "retryAfterSeconds",
    ],
  )?;
  let object = object(error)?;
  for required in ["code", "requestId", "retryable"] {
    if !object.contains_key(required) {
      return Err(AccountError::InvalidResponse);
    }
  }
  Ok(())
}

fn validate_opaque_json(value: &Value) -> Result<(), AccountError> {
  validate_opaque_json_limit(value, MAX_LEAF_BYTES)
}

fn validate_opaque_json_limit(value: &Value, maximum_bytes: usize) -> Result<(), AccountError> {
  validate_json_shape(value, 0, MAX_OPAQUE_DEPTH)?;
  let bytes = serde_json::to_vec(value).map_err(|_| AccountError::InvalidResponse)?;
  if bytes.len() > maximum_bytes {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn validate_json_shape(value: &Value, depth: usize, max_depth: usize) -> Result<(), AccountError> {
  if depth > max_depth {
    return Err(AccountError::InvalidResponse);
  }
  match value {
    Value::Null | Value::Bool(_) => Ok(()),
    Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => Ok(()),
    Value::String(_) => Ok(()),
    Value::Array(values) => {
      for value in values {
        validate_json_shape(value, depth + 1, max_depth)?;
      }
      Ok(())
    }
    Value::Object(values) => {
      for value in values.values() {
        validate_json_shape(value, depth + 1, max_depth)?;
      }
      Ok(())
    }
    _ => Err(AccountError::InvalidResponse),
  }
}

fn validate_recipe_settings(value: &Value) -> Result<(), AccountError> {
  let settings = object(value)?;
  settings
    .get("v")
    .and_then(Value::as_u64)
    .filter(|value| *value <= MAX_SAFE_INTEGER)
    .ok_or(AccountError::InvalidResponse)?;
  let engine = string(settings, "engine")?;
  if engine.len() > 128 || valid_id(engine).is_err() {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn validate_no_transport_material(value: &Value, opaque: bool) -> Result<(), AccountError> {
  if opaque {
    return Ok(());
  }
  match value {
    Value::Array(values) => {
      for value in values {
        validate_no_transport_material(value, false)?;
      }
    }
    Value::Object(values) => {
      for (key, value) in values {
        let lower = key.to_ascii_lowercase();
        if matches!(
          lower.as_str(),
          "token" | "ticket" | "url" | "uri" | "headers" | "authorization" | "credential" | "credentials"
        ) {
          return Err(AccountError::InvalidResponse);
        }
        validate_no_transport_material(value, key == "settings" || key == "meta")?;
      }
    }
    _ => {}
  }
  Ok(())
}

fn string_array(value: &Value) -> Result<(), AccountError> {
  let values = value.as_array().ok_or(AccountError::InvalidResponse)?;
  if values.iter().any(|value| value.as_str().is_none()) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn integer_array(value: &Value) -> Result<(), AccountError> {
  let values = value.as_array().ok_or(AccountError::InvalidResponse)?;
  if values.iter().any(|value| value.as_u64().is_none()) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn exact(value: &Value, keys: &[&str]) -> Result<(), AccountError> {
  let object = object(value)?;
  if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn exact_subset(value: &Value, keys: &[&str]) -> Result<(), AccountError> {
  let object = object(value)?;
  if object.keys().any(|key| !keys.contains(&key.as_str())) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn array(value: &Value, key: &str, check: impl Fn(&Value) -> Result<(), AccountError>) -> Result<(), AccountError> {
  array_max(value, key, MAX_PAGE_ITEMS, check)
}

fn array_max(
  value: &Value,
  key: &str,
  maximum: usize,
  check: impl Fn(&Value) -> Result<(), AccountError>,
) -> Result<(), AccountError> {
  let values = field(value, key)?.as_array().ok_or(AccountError::InvalidResponse)?;
  if values.len() > maximum {
    return Err(AccountError::InvalidResponse);
  }
  for value in values {
    check(value)?;
  }
  Ok(())
}

fn object(value: &Value) -> Result<&Map<String, Value>, AccountError> {
  value.as_object().ok_or(AccountError::InvalidResponse)
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, AccountError> {
  object(value)?.get(key).ok_or(AccountError::InvalidResponse)
}

fn string<'a>(value: &'a Map<String, Value>, key: &str) -> Result<&'a str, AccountError> {
  value
    .get(key)
    .and_then(Value::as_str)
    .ok_or(AccountError::InvalidResponse)
}

fn integer(value: &Map<String, Value>, key: &str) -> Result<u64, AccountError> {
  value
    .get(key)
    .and_then(Value::as_u64)
    .ok_or(AccountError::InvalidResponse)
}

fn valid_id(value: &str) -> Result<(), AccountError> {
  if value.is_empty() || value.len() > 512 || value != value.trim() || value.chars().any(forbidden_character) {
    return Err(AccountError::InvalidResponse);
  }
  Ok(())
}

fn valid_key(value: &str) -> bool {
  !value.contains(',') && value.len() <= 128 && valid_id(value).is_ok()
}

fn forbidden_character(value: char) -> bool {
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
        | 0x13430..=0x1343f
        | 0x1bca0..=0x1bca3
        | 0x1d173..=0x1d17a
        | 0xe0020..=0xe007f
    )
}

fn is_sha256(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

fn strict_u64(value: &str) -> Option<u64> {
  if value.is_empty() || value.starts_with('+') || value.len() > 1 && value.starts_with('0') {
    return None;
  }
  value.parse().ok()
}

fn valid_content_type(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 256
    && value.contains('/')
    && !value.contains(',')
    && !value.chars().any(forbidden_character)
}

pub fn photo_ephemeral_id() -> Result<String, AccountError> {
  let mut bytes = [0_u8; 24];
  getrandom::fill(&mut bytes).map_err(|_| AccountError::Internal)?;
  Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Cursor;

  fn capture() -> PhotoScopeCapture {
    PhotoScopeCapture {
      user_id: "synthetic-user".into(),
      session_id: "synthetic-session".into(),
      session_epoch: "synthetic-epoch".into(),
      transport: PhotoIdentityTransport::MacBearer,
    }
  }

  fn config() -> Config {
    Config::production(ClientId::Camera, "synthetic-public-key").unwrap()
  }

  fn response(status: u16, content_type: &str, value: Value) -> PhotoHttpResponse {
    let bytes = serde_json::to_vec(&value).unwrap();
    PhotoHttpResponse {
      status,
      content_length: Some(bytes.len() as u64),
      content_type: Some(content_type.into()),
      sha256: None,
      total_bytes: None,
      body: Box::new(Cursor::new(bytes)),
    }
  }

  #[test]
  fn fixed_routes_match_the_canonical_wire_mapping() {
    let cases = [
      (
        PhotoOperation::LibraryGet,
        serde_json::json!({}),
        None,
        "GET",
        "/api/me/photo-cloud/v2/library",
        None,
      ),
      (
        PhotoOperation::PhotosList,
        serde_json::json!({"limit":60,"sort":"added-desc","formats":["jpeg","raw"],"edited":false}),
        None,
        "GET",
        "/api/me/photo-cloud/v2/photos",
        Some("limit=60&sort=added-desc&formats=jpeg&formats=raw&edited=false"),
      ),
      (
        PhotoOperation::PhotosGet,
        serde_json::json!({"photoId":"photo"}),
        None,
        "GET",
        "/api/me/photo-cloud/v2/photos/photo",
        None,
      ),
      (
        PhotoOperation::PhotosInfo,
        serde_json::json!({"photoId":"photo/with space"}),
        None,
        "GET",
        "/api/me/photo-cloud/v2/photos/photo%2Fwith%20space/info",
        None,
      ),
      (
        PhotoOperation::PhotosLookup,
        serde_json::json!({"sha256s":["a".repeat(64)]}),
        None,
        "POST",
        "/api/me/photo-cloud/v2/photos/lookup",
        None,
      ),
      (
        PhotoOperation::RecipesPut,
        serde_json::json!({"photoId":"photo","expectedRevision":1,"settings":{"v":1,"engine":"niho-14","token":"opaque-user-json"},"baseVersion":null}),
        Some("recipe-key".into()),
        "PUT",
        "/api/me/photo-cloud/v2/photos/photo/recipe",
        None,
      ),
      (
        PhotoOperation::RecipeConflictsList,
        serde_json::json!({"photoId":"photo","cursor":"cursor","limit":60}),
        None,
        "GET",
        "/api/me/photo-cloud/v2/photos/photo/recipe-conflicts",
        Some("cursor=cursor&limit=60"),
      ),
      (
        PhotoOperation::RecipeConflictsGet,
        serde_json::json!({"photoId":"photo","conflictId":"conflict"}),
        None,
        "GET",
        "/api/me/photo-cloud/v2/photos/photo/recipe-conflicts/conflict",
        None,
      ),
      (
        PhotoOperation::RecipeConflictsResolve,
        serde_json::json!({"photoId":"photo","conflictId":"conflict","expectedRevision":2,"decision":"keep-current"}),
        Some("resolve-key".into()),
        "POST",
        "/api/me/photo-cloud/v2/photos/photo/recipe-conflicts/conflict/resolve",
        None,
      ),
      (
        PhotoOperation::PhotosDelete,
        serde_json::json!({"photoId":"photo"}),
        Some("delete-key".into()),
        "DELETE",
        "/api/me/photo-cloud/v2/photos/photo",
        None,
      ),
    ];
    for (operation, value, key, method, path, query) in cases {
      let parsed = PhotoRequest::parse(operation, value, key).unwrap();
      let native = native_request(&config(), &capture(), &parsed);
      assert_eq!(native.method, method);
      assert_eq!(native.url.path(), path);
      assert_eq!(native.url.query(), query);
      assert!(native.url.as_str().starts_with("https://niho.life/"));
    }
  }

  #[test]
  fn request_parser_rejects_url_header_body_and_key_smuggling() {
    for value in [
      serde_json::json!({"photoId":"photo","url":"https://evil.test"}),
      serde_json::json!({"photoId":"photo","headers":{"authorization":"secret"}}),
      serde_json::json!({"photoId":"photo","body":[1,2,3]}),
      serde_json::json!({"photoId":"bad\nheader"}),
    ] {
      assert!(PhotoRequest::parse(PhotoOperation::PhotosGet, value, None).is_err());
    }
    assert!(PhotoRequest::parse(
      PhotoOperation::PhotosDelete,
      serde_json::json!({"photoId":"photo"}),
      None
    )
    .is_err());
    assert!(PhotoRequest::parse(
      PhotoOperation::PhotosGet,
      serde_json::json!({"photoId":"photo"}),
      Some("unexpected-key".into())
    )
    .is_err());
    assert!(PhotoRequest::parse(
      PhotoOperation::PhotosDelete,
      serde_json::json!({"photoId":"photo"}),
      Some("bad,key".into())
    )
    .is_err());
  }

  #[test]
  fn request_parser_matches_canonical_recipe_boundaries() {
    for settings in [
      serde_json::json!([]),
      serde_json::json!({"v":1}),
      serde_json::json!({"v":MAX_SAFE_INTEGER + 1,"engine":"niho-14"}),
      serde_json::json!({"v":1,"engine":"x".repeat(129)}),
    ] {
      assert!(PhotoRequest::parse(
        PhotoOperation::RecipesPut,
        serde_json::json!({
          "photoId":"photo",
          "expectedRevision":1,
          "settings":settings,
          "baseVersion":null
        }),
        Some("recipe-key".into()),
      )
      .is_err());
    }
    assert!(PhotoRequest::parse(
      PhotoOperation::RecipesPut,
      serde_json::json!({
        "photoId":"photo",
        "expectedRevision":MAX_SAFE_INTEGER + 1,
        "settings":{"v":1,"engine":"niho-14"},
        "baseVersion":null
      }),
      Some("recipe-key".into()),
    )
    .is_err());
    assert!(PhotoRequest::parse(
      PhotoOperation::RecipeConflictsResolve,
      serde_json::json!({
        "photoId":"photo",
        "conflictId":"conflict",
        "expectedRevision":MAX_SAFE_INTEGER + 1,
        "decision":"adopt"
      }),
      Some("resolve-key".into()),
    )
    .is_err());
  }

  #[test]
  fn opaque_recipe_json_preserves_many_long_and_control_named_future_fields() {
    let mut settings = Map::new();
    settings.insert("v".into(), serde_json::json!(1));
    settings.insert("engine".into(), serde_json::json!("niho-14"));
    settings.insert(format!("long-{}", "k".repeat(600)), serde_json::json!("kept"));
    settings.insert(
      "future\ncontrol".into(),
      serde_json::json!({"token":"ordinary-user-json"}),
    );
    for index in 0..257 {
      settings.insert(format!("future-{index}"), serde_json::json!(index));
    }
    let value = Value::Object(settings.clone());
    let parsed = PhotoRequest::parse(
      PhotoOperation::RecipesPut,
      serde_json::json!({
        "photoId":"photo",
        "expectedRevision":1,
        "settings":value,
        "baseVersion":null
      }),
      Some("recipe-key".into()),
    )
    .unwrap();
    let body: Value = serde_json::from_slice(parsed.body.as_ref().unwrap()).unwrap();
    assert_eq!(body["settings"], Value::Object(settings));

    let oversized = serde_json::json!({
      "photoId":"photo",
      "expectedRevision":1,
      "settings":{"v":1,"engine":"niho-14","future":"x".repeat(MAX_LEAF_BYTES + 1)},
      "baseVersion":null
    });
    assert!(PhotoRequest::parse(PhotoOperation::RecipesPut, oversized, Some("recipe-key".into())).is_err());

    let mut deep = serde_json::json!({"v":1,"engine":"niho-14"});
    for _ in 0..=MAX_OPAQUE_DEPTH {
      deep = serde_json::json!({"future":deep});
    }
    assert!(PhotoRequest::parse(
      PhotoOperation::RecipesPut,
      serde_json::json!({
        "photoId":"photo","expectedRevision":1,"settings":deep,"baseVersion":null
      }),
      Some("recipe-key".into()),
    )
    .is_err());

    let mut meta = Map::new();
    meta.insert(format!("long-{}", "m".repeat(600)), serde_json::json!(true));
    meta.insert("future\ncontrol".into(), serde_json::json!("kept"));
    for index in 0..257 {
      meta.insert(format!("future-meta-{index}"), serde_json::json!(index));
    }
    assert!(validate_opaque_json_limit(&Value::Object(meta), WORKING_META_MAX).is_ok());
  }

  #[test]
  fn response_projection_rejects_unknown_secret_and_ticket_fields() {
    for value in [
      serde_json::json!({"state":"purged","token":"secret"}),
      serde_json::json!({"state":"purged","ticket":{"url":"https://evil.test"}}),
      serde_json::json!({"state":"purged","headers":{"authorization":"secret"}}),
    ] {
      assert!(read_json_response(response(200, "application/json", value), PhotoOperation::PhotosDelete).is_err());
    }
    assert!(read_json_response(
      response(
        401,
        "application/json",
        serde_json::json!({"error":{"code":"unauthenticated","requestId":"synthetic","retryable":false,"token":"secret"}}),
      ),
      PhotoOperation::PhotosGet,
    )
    .is_err());
  }

  #[test]
  fn opaque_recipe_json_preserves_unknown_token_named_user_data() {
    let photo = serde_json::json!({
      "id":"photo","libraryId":"library","storageState":"stored","lifecycle":"active",
      "fileName":"synthetic.jpg","format":"jpeg","hasEdits":true,"addedAt":"2026-11-01T00:00:00.000Z",
      "capturedAt":null,"width":10,"height":10,
      "original":{"id":"upa_opaque","kind":"original","sha256":"a".repeat(64),"sizeBytes":4,"contentType":"image/jpeg","width":10,"height":10},
      "recipe":{"revision":1,"settings":{"v":1,"engine":"niho-14","token":"ordinary-user-setting","future":{"keep":true}},
        "settingsSha256":"b".repeat(64),"baseVersion":null,"maskSurfaceIds":[],"updatedAt":"2026-11-01T00:00:00.000Z"},
      "media":{"state":"pending"}
    });
    let checked = read_json_response(response(200, "application/json", photo), PhotoOperation::PhotosGet).unwrap();
    assert_eq!(checked.body["recipe"]["settings"]["token"], "ordinary-user-setting");
  }

  #[test]
  fn photo_response_requires_active_stored_original_enums() {
    let photo = serde_json::json!({
      "id":"photo","libraryId":"library","storageState":"stored","lifecycle":"active",
      "fileName":"synthetic.jpg","format":"jpeg","hasEdits":false,"addedAt":"2026-11-01T00:00:00.000Z",
      "capturedAt":null,"width":10,"height":10,
      "original":{"id":"upa_opaque","kind":"original","sha256":"a".repeat(64),"sizeBytes":4,"contentType":"image/jpeg","width":10,"height":10},
      "recipe":{"revision":0,"settings":{"v":1,"engine":"niho-14"},"settingsSha256":"b".repeat(64),"baseVersion":null,"maskSurfaceIds":[],"updatedAt":"2026-11-01T00:00:00.000Z"},
      "media":{"state":"pending"}
    });
    for (field, value) in [
      ("storageState", serde_json::json!("pending")),
      ("lifecycle", serde_json::json!("deleted")),
      ("format", serde_json::json!("future-format")),
    ] {
      let mut rejected = photo.clone();
      rejected[field] = value;
      assert!(read_json_response(response(200, "application/json", rejected), PhotoOperation::PhotosGet).is_err());
    }
    let mut rejected = photo;
    rejected["original"]["kind"] = serde_json::json!("preview");
    assert!(read_json_response(response(200, "application/json", rejected), PhotoOperation::PhotosGet).is_err());
  }

  #[test]
  fn native_original_metadata_is_bound_to_the_requested_photo_and_safe_name() {
    let photo = serde_json::json!({
      "id":"photo","libraryId":"library","storageState":"stored","lifecycle":"active",
      "fileName":"synthetic.JPG","format":"jpeg","hasEdits":false,"addedAt":"2026-11-01T00:00:00.000Z",
      "capturedAt":null,"width":10,"height":10,
      "original":{"id":"asset","kind":"original","sha256":"a".repeat(64),"sizeBytes":4,"contentType":"image/jpeg","width":10,"height":10},
      "recipe":{"revision":0,"settings":{"v":1,"engine":"niho-14"},"settingsSha256":"b".repeat(64),"baseVersion":null,"maskSurfaceIds":[],"updatedAt":"2026-11-01T00:00:00.000Z"},
      "media":{"state":"pending"}
    });
    let (metadata, name) = original_metadata_for_photo(&photo, "photo").unwrap();
    assert_eq!(metadata.asset_id, "asset");
    assert_eq!(metadata.size_bytes, 4);
    assert_eq!(name, "synthetic.JPG");
    assert!(original_metadata_for_photo(&photo, "another-photo").is_err());
  }

  #[test]
  fn response_bounds_content_type_and_depth_are_closed() {
    let mut deep = serde_json::json!({});
    for _ in 0..40 {
      deep = serde_json::json!({"next":deep});
    }
    assert!(read_json_response(response(200, "application/json", deep), PhotoOperation::PhotosInfo).is_err());
    assert!(read_json_response(
      response(200, "text/plain", serde_json::json!({"state":"purged"})),
      PhotoOperation::PhotosDelete,
    )
    .is_err());
    let too_large = PhotoHttpResponse {
      status: 500,
      content_length: Some(ERROR_BODY_MAX + 1),
      content_type: Some("application/json".into()),
      sha256: None,
      total_bytes: None,
      body: Box::new(Cursor::new(Vec::<u8>::new())),
    };
    assert!(read_json_response(too_large, PhotoOperation::PhotosGet).is_err());
  }

  #[test]
  fn absolute_deadline_reader_rejects_before_and_after_inner_read() {
    let mut already_expired = DeadlineReader::new(
      Box::new(Cursor::new(vec![1_u8])),
      Instant::now() - Duration::from_millis(1),
    );
    assert_eq!(
      already_expired.read(&mut [0_u8; 1]).unwrap_err().kind(),
      io::ErrorKind::TimedOut
    );

    struct CrossDeadline;
    impl Read for CrossDeadline {
      fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        std::thread::sleep(Duration::from_millis(2));
        buffer[0] = 7;
        Ok(1)
      }
    }
    let mut crossing = DeadlineReader::new(Box::new(CrossDeadline), Instant::now() + Duration::from_millis(1));
    let mut output = [0_u8; 1];
    assert_eq!(crossing.read(&mut output).unwrap_err().kind(), io::ErrorKind::TimedOut);
  }

  fn content_response(bytes: Vec<u8>, sha256: &str, declared: u64) -> PhotoHttpResponse {
    PhotoHttpResponse {
      status: 200,
      content_length: Some(declared),
      content_type: Some("image/jpeg".into()),
      sha256: Some(sha256.into()),
      total_bytes: Some(declared.to_string()),
      body: Box::new(Cursor::new(bytes)),
    }
  }

  fn metadata(bytes: &[u8]) -> PhotoContentMetadata {
    PhotoContentMetadata {
      photo_id: "photo".into(),
      asset_id: "asset".into(),
      sha256: format!("{:x}", Sha256::digest(bytes)),
      size_bytes: bytes.len() as u64,
      content_type: "image/jpeg".into(),
    }
  }

  #[test]
  fn verified_content_requires_full_sha_size_and_eof() {
    let bytes = b"synthetic-original".to_vec();
    let expected = metadata(&bytes);
    let mut output = Vec::new();
    stream_verified_content(
      content_response(bytes.clone(), &expected.sha256, bytes.len() as u64),
      &expected,
      &mut output,
      &PhotoDownloadCancel::default(),
      || Ok(()),
    )
    .unwrap();
    assert_eq!(output, bytes);

    for response in [
      content_response(b"short".to_vec(), &expected.sha256, expected.size_bytes),
      content_response(bytes.clone(), &"0".repeat(64), expected.size_bytes),
      content_response(bytes.clone(), &expected.sha256, expected.size_bytes + 1),
    ] {
      assert!(stream_verified_content(
        response,
        &expected,
        &mut Vec::new(),
        &PhotoDownloadCancel::default(),
        || Ok(()),
      )
      .is_err());
    }
  }

  #[test]
  fn verified_content_checks_cancel_and_scope_per_chunk() {
    let bytes = b"synthetic-original".to_vec();
    let expected = metadata(&bytes);
    let cancel = PhotoDownloadCancel::default();
    cancel.cancel();
    assert_eq!(
      stream_verified_content(
        content_response(bytes.clone(), &expected.sha256, bytes.len() as u64),
        &expected,
        &mut Vec::new(),
        &cancel,
        || Ok(()),
      ),
      Err(AccountError::Cancelled),
    );
    assert_eq!(
      stream_verified_content(
        content_response(bytes.clone(), &expected.sha256, bytes.len() as u64),
        &expected,
        &mut Vec::new(),
        &PhotoDownloadCancel::default(),
        || Err(AccountError::Cancelled),
      ),
      Err(AccountError::Cancelled),
    );
  }

  #[test]
  fn production_origin_and_content_paths_are_fixed() {
    let request = content_request(&config(), &capture(), "photo/one", "upa_opaque");
    assert_eq!(request.method, "GET");
    assert_eq!(
      request.url.as_str(),
      "https://niho.life/api/me/photo-cloud/v2/photos/photo%2Fone/assets/upa_opaque/content"
    );
    assert!(valid_fixed_url(&config(), &request.url));
    let mut rejected = request.url.clone();
    rejected.set_host(Some("example.test")).unwrap();
    assert!(!valid_fixed_url(&config(), &rejected));
    let mut rejected = request.url.clone();
    rejected.set_scheme("http").unwrap();
    assert!(!valid_fixed_url(&config(), &rejected));
  }
}
