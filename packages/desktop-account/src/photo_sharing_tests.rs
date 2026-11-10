//! 共有アルバムの native 通信の部品の試験（合成の応答だけ）。

use super::*;
use crate::{ClientId, PhotoIdentityTransport};
use std::io::Cursor;

fn capture() -> PhotoScopeCapture {
  PhotoScopeCapture {
    user_id: "synthetic-user".into(),
    session_id: "synthetic-session".into(),
    session_epoch: "1".into(),
    transport: PhotoIdentityTransport::MacBearer,
  }
}

fn json_response(status: u16, value: &Value) -> PhotoHttpResponse {
  let bytes = serde_json::to_vec(value).unwrap();
  PhotoHttpResponse {
    status,
    content_length: Some(bytes.len() as u64),
    content_type: Some("application/json".into()),
    sha256: None,
    total_bytes: None,
    body: Box::new(Cursor::new(bytes)),
  }
}

fn ticket(url: &str) -> Value {
  serde_json::json!({
    "url": url,
    "method": "PUT",
    "headers": { "Content-Type": "image/jpeg" },
    "expiresAt": "2099-01-01T00:00:00.000Z",
    "resumeOffsetBytes": 0,
  })
}

fn added(ticket_value: Value) -> Value {
  serde_json::json!({
    "value": {
      "item": { "id": "synthetic-item", "state": "preparing" },
      "upload": {
        "upload": { "id": "synthetic-upload", "sizeBytes": 1024, "state": "reserved" },
        "ticket": ticket_value,
      },
    },
    "replayed": false,
  })
}

#[test]
fn requests_are_routes_of_the_table_under_the_fixed_prefix() {
  let get = SharingRequest::parse("GET", "/cloud/sharing/v1/albums?cursor=c%2B1&limit=10", None, None).unwrap();
  assert!(get.is_get());
  let config = Config::mock("http://127.0.0.1:12345");
  let native = get.native(&config, &capture()).unwrap();
  assert_eq!(native.url.path(), "/api/synthetic-sharing/v1/albums");
  assert_eq!(native.url.query(), Some("cursor=c%2B1&limit=10"));
  assert_eq!(native.method, "GET");
  assert!(native.body.is_none());

  let post = SharingRequest::parse(
    "POST",
    "/cloud/sharing/v1/albums/synthetic%20album/file-items",
    Some(serde_json::json!({ "rendition": { "sizeBytes": 1 } })),
    Some("synthetic-key".into()),
  )
  .unwrap();
  assert_eq!(post.operation(), "albumItems.addFile");
  let native = post.native(&config, &capture()).unwrap();
  assert_eq!(
    native.url.path(),
    "/api/synthetic-sharing/v1/albums/synthetic%20album/file-items"
  );
  assert_eq!(native.idempotency_key.as_deref(), Some("synthetic-key"));

  let render = SharingRequest::parse(
    "POST",
    "/cloud/sharing/v1/render-jobs/claim",
    Some(serde_json::json!({ "maxJobs": 1, "purposes": ["albumItem"] })),
    Some("synthetic-claim-key".into()),
  )
  .unwrap();
  assert_eq!(render.operation(), "renderJobs.claim");
  let native = render.native(&config, &capture()).unwrap();
  assert_eq!(native.url.path(), "/api/synthetic-sharing/v1/render-jobs/claim");
  assert_eq!(native.idempotency_key.as_deref(), Some("synthetic-claim-key"));

  // build の設定が無い（公開の build）なら送らない
  let production = Config::production(ClientId::Camera, "synthetic-public-key").unwrap();
  assert_eq!(
    get.native(&production, &capture()).err(),
    Some(AccountError::NotConfigured)
  );
}

#[test]
fn malformed_or_bff_only_requests_are_refused() {
  let object = || Some(serde_json::json!({}));
  for (method, path, body, key) in [
    ("PATCH", "/cloud/sharing/v1/albums", None, None),
    ("GET", "/cloud/v2/library", None, None),
    ("GET", "/cloud/sharing/v1", None, None),
    ("GET", "/cloud/sharing/v1/albums/../library", None, None),
    ("GET", "/cloud/sharing/v1/albums/%2E%2E", None, None),
    ("GET", "/cloud/sharing/v1/albums/a%2Fb", None, None),
    ("GET", "/cloud/sharing/v1/albums//items", None, None),
    ("GET", "/cloud/sharing/v1/albums/a b", None, None),
    ("GET", "/cloud/sharing/v1/albums?limit=1;drop", None, None),
    ("GET", "/cloud/sharing/v1/albums", object(), None),
    (
      "GET",
      "/cloud/sharing/v1/albums",
      None,
      Some("synthetic-key".to_string()),
    ),
    (
      "POST",
      "/cloud/sharing/v1/albums",
      None,
      Some("synthetic-key".to_string()),
    ),
    (
      "POST",
      "/cloud/sharing/v1/albums",
      Some(serde_json::json!([1])),
      Some("synthetic-key".to_string()),
    ),
    (
      "POST",
      "/cloud/sharing/v1/albums",
      object(),
      Some("bad,key".to_string()),
    ),
    ("POST", "/cloud/sharing/v1/invites/pending", object(), None),
    ("POST", "/cloud/sharing/v1/invites/pending/join", object(), None),
    // 表にない経路（BFF だけ・常設 Mac・percent-encoding で literal を装う）
    ("POST", "/cloud/sharing/v1/invites/%70ending/join", object(), None),
    ("GET", "/cloud/sharing/v1/libraries/l/photos", None, None),
    ("GET", "/cloud/sharing/v1/%61lbums", None, None),
    // 表の操作でも、query・body の項目・key の要否が違うもの
    ("GET", "/cloud/sharing/v1/albums?ownerId=x", None, None),
    ("GET", "/cloud/sharing/v1/albums?limit=1&limit=2", None, None),
    (
      "POST",
      "/cloud/sharing/v1/albums",
      Some(serde_json::json!({ "name": "a", "ownerId": "x" })),
      Some("k".to_string()),
    ),
    (
      "POST",
      "/cloud/sharing/v1/albums",
      Some(serde_json::json!({ "name": "a" })),
      None,
    ),
    (
      "POST",
      "/cloud/sharing/v1/albums/a/uploads/u/renew",
      object(),
      Some("k".to_string()),
    ),
    ("DELETE", "/cloud/sharing/v1/albums/a", None, None),
  ] {
    assert_eq!(
      SharingRequest::parse(method, path, body, key).err(),
      Some(AccountError::InvalidResponse),
      "{method} {path}"
    );
  }
  let long = format!("/cloud/sharing/v1/albums/{}", "a".repeat(SEGMENT_MAX + 1));
  assert!(SharingRequest::parse("GET", &long, None, None).is_err());
  let big = serde_json::json!({ "name": "a".repeat(BODY_MAX) });
  assert!(SharingRequest::parse("POST", "/cloud/sharing/v1/albums", Some(big), Some("k".into())).is_err());
}

#[test]
fn upload_tickets_stay_native_and_the_page_gets_a_handle() {
  let response = read_sharing_json(json_response(
    200,
    &added(ticket("https://storage.googleapis.com/synthetic-bucket/upload?x=1")),
  ))
  .unwrap();
  assert_eq!(response.tickets.len(), 1);
  let held = &response.tickets[0];
  assert_eq!(held.upload_id, "synthetic-upload");
  assert_eq!(
    held.ticket.url.as_str(),
    "https://storage.googleapis.com/synthetic-bucket/upload?x=1"
  );
  assert_eq!(held.ticket.size_bytes, 1024);
  let shown = &response.body["value"]["upload"]["ticket"];
  let url = shown["url"].as_str().unwrap();
  assert_eq!(sharing_ticket_handle(url), Some(held.handle.as_str()));
  assert_eq!(shown["method"], "PUT");
  assert_eq!(shown["headers"], serde_json::json!({}));
  assert_eq!(shown["expiresAt"], "2099-01-01T00:00:00.000Z");
  assert!(!serde_json::to_string(&response.body)
    .unwrap()
    .contains("storage.googleapis.com"));

  // 再送の答え（ticket なし）はそのまま
  let replay = read_sharing_json(json_response(200, &added(Value::Null))).unwrap();
  assert!(replay.tickets.is_empty());
  assert_eq!(replay.body["value"]["upload"]["ticket"], Value::Null);

  // renewUpload の形（`{ upload, ticket }`）
  let renewed = serde_json::json!({
    "upload": { "id": "synthetic-upload", "sizeBytes": 1024, "state": "reserved" },
    "ticket": ticket("https://storage.googleapis.com/synthetic-bucket/renewed"),
  });
  let renewed = read_sharing_json(json_response(200, &renewed)).unwrap();
  assert_eq!(renewed.tickets.len(), 1);
  assert!(sharing_ticket_handle(renewed.body["ticket"]["url"].as_str().unwrap()).is_some());
}

#[test]
fn render_output_tickets_are_bound_to_the_requested_output_and_job() {
  let output = serde_json::json!({
    "kind": "rendition",
    "sizeBytes": 1024,
    "sha256": "a".repeat(64),
    "contentType": "image/jpeg",
    "width": 800,
    "height": 600,
    "metadata": { "capturedAt": null, "orientation": 1, "colorProfile": "sRGB" },
  });
  let start = SharingRequest::parse(
    "POST",
    "/cloud/sharing/v1/render-jobs/job-1/outputs",
    Some(serde_json::json!({ "leaseToken": "lease", "output": output })),
    Some("start-output-key".into()),
  )
  .unwrap();
  assert_eq!(start.operation(), "renderJobs.startOutput");
  assert_eq!(start.render_job_id(), Some("job-1"));
  assert_eq!(start.render_upload_id(), None);
  let expectation = start.output_expectation().unwrap().clone();
  assert_eq!(
    expectation,
    SharingOutputExpectation {
      content_type: "image/jpeg".into(),
      size_bytes: 1024
    }
  );

  let started = serde_json::json!({
    "value": { "uploadId": "upload-1", "expiresAt": "2099-01-01T00:00:00.000Z", "ticket": ticket("https://storage.googleapis.com/synthetic-bucket/render") },
    "replayed": false,
  });
  let started = read_sharing_json_for_request(json_response(200, &started), &start).unwrap();
  assert_eq!(started.tickets.len(), 1);
  assert_eq!(started.tickets[0].upload_id, "upload-1");
  assert_eq!(started.tickets[0].ticket.size_bytes, 1024);
  assert!(sharing_ticket_handle(started.body["value"]["ticket"]["url"].as_str().unwrap()).is_some());

  let mut renew = SharingRequest::parse(
    "POST",
    "/cloud/sharing/v1/render-jobs/job-1/outputs/upload-1/renew",
    Some(serde_json::json!({ "leaseToken": "lease" })),
    None,
  )
  .unwrap();
  assert_eq!(renew.render_job_id(), Some("job-1"));
  assert_eq!(renew.render_upload_id(), Some("upload-1"));
  assert_eq!(
    read_sharing_json_for_request(json_response(200, &serde_json::json!({
      "uploadId": "upload-1", "expiresAt": "2099-01-01T00:00:00.000Z", "ticket": ticket("https://storage.googleapis.com/synthetic-bucket/renewed")
    })), &renew).err(),
    Some(AccountError::InvalidResponse),
    "a renewed ticket without the original output expectation must fail closed"
  );
  renew.set_output_expectation(expectation).unwrap();
  let renewed = read_sharing_json_for_request(json_response(200, &serde_json::json!({
    "uploadId": "upload-1", "expiresAt": "2099-01-01T00:00:00.000Z", "ticket": ticket("https://storage.googleapis.com/synthetic-bucket/renewed")
  })), &renew).unwrap();
  assert_eq!(renewed.tickets[0].upload_id, "upload-1");
  assert_eq!(renewed.tickets[0].ticket.size_bytes, 1024);

  let wrong_upload = serde_json::json!({
    "uploadId": "other-upload", "expiresAt": "2099-01-01T00:00:00.000Z", "ticket": ticket("https://storage.googleapis.com/synthetic-bucket/other")
  });
  assert_eq!(
    read_sharing_json_for_request(json_response(200, &wrong_upload), &renew).err(),
    Some(AccountError::InvalidResponse)
  );
  assert!(SharingRequest::parse(
    "POST",
    "/cloud/sharing/v1/render-jobs/job-1/outputs",
    Some(serde_json::json!({ "leaseToken": "lease", "output": { "sizeBytes": SHARING_CONTENT_MAX + 1, "contentType": "image/jpeg" } })),
    Some("too-large-key".into()),
  ).is_err());
}

#[test]
fn untrusted_tickets_and_other_transport_material_are_refused() {
  for value in [
    added(ticket("https://attacker.example/upload")),
    added(ticket("http://storage.googleapis.com/upload")),
    serde_json::json!({ "upload": { "sizeBytes": 1 }, "ticket": ticket("https://storage.googleapis.com/u") }),
    serde_json::json!({ "ticket": ticket("https://storage.googleapis.com/u") }),
    serde_json::json!({ "items": [], "url": "https://storage.googleapis.com/u" }),
    serde_json::json!({ "token": "synthetic" }),
    serde_json::json!([1, 2]),
  ] {
    assert_eq!(
      read_sharing_json(json_response(200, &value)).err(),
      Some(AccountError::InvalidResponse),
      "{value}"
    );
  }
  let mut html = json_response(200, &serde_json::json!({}));
  html.content_type = Some("text/html".into());
  assert!(read_sharing_json(html).is_err());
  let mut large = json_response(200, &serde_json::json!({}));
  large.content_length = Some(JSON_MAX + 1);
  assert!(read_sharing_json(large).is_err());
}

#[test]
fn error_answers_pass_through_without_ticket_handling() {
  let value = serde_json::json!({ "error": { "code": "role_forbidden", "requestId": "r", "retryable": false } });
  let response = read_sharing_json(json_response(403, &value)).unwrap();
  assert_eq!(response.status, 403);
  assert_eq!(error_code(&response.body), Some("role_forbidden"));
  assert!(response.tickets.is_empty());
}

fn content(bytes: &[u8], sha256: &str, total: u64, content_type: &str) -> PhotoHttpResponse {
  PhotoHttpResponse {
    status: 200,
    content_length: Some(total),
    content_type: Some(content_type.into()),
    sha256: Some(sha256.into()),
    total_bytes: Some(total.to_string()),
    body: Box::new(Cursor::new(bytes.to_vec())),
  }
}

#[test]
fn downloads_are_checked_against_the_declared_hash_length_and_type() {
  let bytes = b"synthetic jpeg bytes";
  let digest = format!("{:x}", Sha256::digest(bytes));
  let mut out = Vec::new();
  let metadata = stream_sharing_content(
    content(bytes, &digest, bytes.len() as u64, "image/jpeg"),
    &mut out,
    &PhotoDownloadCancel::default(),
    || Ok(()),
  )
  .unwrap();
  assert_eq!(out, bytes);
  assert_eq!(metadata.total_bytes, bytes.len() as u64);
  assert_eq!(metadata.sha256, digest);

  let wrong = "0".repeat(64);
  for response in [
    content(bytes, &wrong, bytes.len() as u64, "image/jpeg"),
    content(bytes, &digest, bytes.len() as u64 + 1, "image/jpeg"),
    content(bytes, &digest, bytes.len() as u64, "text/html"),
  ] {
    assert!(stream_sharing_content(response, &mut Vec::new(), &PhotoDownloadCancel::default(), || Ok(())).is_err());
  }
  let cancel = PhotoDownloadCancel::default();
  cancel.cancel();
  assert!(stream_sharing_content(
    content(bytes, &digest, bytes.len() as u64, "image/jpeg"),
    &mut Vec::new(),
    &cancel,
    || Ok(())
  )
  .is_err());
}

#[test]
fn ticket_handles_are_only_the_native_placeholder() {
  assert_eq!(
    sharing_ticket_handle(&format!("https://{SHARING_TICKET_HOST}/{}", "a".repeat(32))),
    Some("a".repeat(32).as_str())
  );
  assert_eq!(sharing_ticket_handle("https://storage.googleapis.com/x"), None);
  assert_eq!(
    sharing_ticket_handle(&format!("https://{SHARING_TICKET_HOST}/short")),
    None
  );
}

#[test]
fn the_sharing_prefix_is_a_fixed_api_path() {
  for good in ["/api/me/photo-sharing/v1", "/api/synthetic-sharing/v1"] {
    assert!(Config::sharing_prefix_is_valid(good), "{good}");
  }
  for bad in [
    "/cloud/sharing/v1",
    "/api/",
    "/api/x/",
    "/api//x",
    "/api/../x",
    "/api/X",
    "https://x/api/y",
    "/api/x?y",
  ] {
    assert!(!Config::sharing_prefix_is_valid(bad), "{bad}");
  }
  let config = Config::production(ClientId::Camera, "synthetic-public-key").unwrap();
  assert!(config.with_sharing_prefix("/cloud/x").is_err());
}

#[test]
fn the_route_table_is_the_shared_album_operations_only() {
  let names: Vec<&str> = routes().iter().map(|route| route.operation.as_str()).collect();
  assert_eq!(names.len(), 24);
  for expected in [
    "albums.list",
    "albumItems.addFile",
    "albumItems.renewUpload",
    "albumItems.download",
    "invites.join",
    "members.leave",
  ] {
    assert!(names.contains(&expected), "{expected}");
  }
  assert!(names
    .iter()
    .all(|name| !name.starts_with("hosted") && !name.starts_with("connector") && !name.contains("Pending")));
  assert_eq!(
    SharingRequest::parse(
      "POST",
      "/cloud/sharing/v1/albums/a/uploads/u/renew",
      Some(serde_json::json!({})),
      None
    )
    .unwrap()
    .operation(),
    "albumItems.renewUpload"
  );
  assert_eq!(
    SharingRequest::parse(
      "DELETE",
      "/cloud/sharing/v1/albums/a?expectedRevision=3",
      None,
      Some("k".into())
    )
    .unwrap()
    .operation(),
    "albums.delete"
  );
}

#[test]
fn only_the_download_route_is_content() {
  let download = SharingRequest::parse(
    "GET",
    "/cloud/sharing/v1/albums/a/items/i/renditions/r/content?variant=full",
    None,
    None,
  )
  .unwrap();
  assert!(download.is_content());
  let list = SharingRequest::parse("GET", "/cloud/sharing/v1/albums", None, None).unwrap();
  assert!(!list.is_content());
}

#[test]
fn a_taken_ticket_is_the_only_transport_material_allowed() {
  let mut value = added(Value::Null);
  assert!(validate_taken_tickets_only(&value).is_ok());
  value["value"]["upload"]["upload"]["url"] = Value::String("https://x".into());
  assert!(validate_taken_tickets_only(&value).is_err());
  assert!(validate_taken_tickets_only(&serde_json::json!({ "ticket": {} })).is_err());
  assert!(validate_taken_tickets_only(&serde_json::json!({ "settings": { "url": "opaque" } })).is_ok());
}
