//! 現像の native の口（URI scheme `niho-develop://localhost/<method>`。Issue #152 の口の仕様 5）。画面の Worker の native glue
//! （`packages/photo-editing/src/develop-engine/develop-engine-native-glue.ts`）が同期の XHR で本文を POST し、同梱の sidecar
//! `niho-develop-render serve`（`develop_engine_sidecar.rs`）の応答の本文をそのまま返す。
//!
//! - main 窓（同梱の画面）からの要求だけに答える。ほかの窓・形の違う URL・POST / OPTIONS 以外は 404
//! - `OPTIONS` は CORS の preflight（画面の origin `tauri://localhost` から見て別 origin）に 204
//! - method は `[A-Za-z.]{1,64}` で、sidecar の `hello` の口の一覧に無ければ 404（先に起動と `hello` を済ませてから判定）。
//!   本文が無い・1 GiB を超える → 400
//! - sidecar を使えない（同梱されていない・起動できない・落ちた・待ちすぎ）→ 503（本文は短い英語の理由。画面は wasm へ落ちる）
//! - 本文の中身（JSON の header と binary）は読まない。`ok:false` の応答も 200 のまま返す
//! - 処理は blocking の thread で（main thread を止めない）。その間は App Nap を止める（`activity.rs`）
//! - 画面の CSP の `connect-src` に `niho-develop:` を足してある（`tauri.conf.json`。同梱の sidecar へ渡すだけで、外へは出ない）

use crate::develop_engine_sidecar::{is_method_name, CallError, DevelopEngine, Unavailable, MAX_BODY_BYTES};
use niho_desktop_photo::common::new_opaque_id;
use niho_desktop_photo::develop::{ANALYSIS_CACHE_SUFFIX, CACHE_DIR_NAME};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::http::{header, response, HeaderMap, Method, Request, Response, StatusCode, Uri};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

/// scheme の名前（`tauri.conf.json` の CSP の `connect-src` と、画面の native glue）。
pub const SCHEME: &str = "niho-develop";
/// 現像の口に答える窓（`tauri.conf.json` の窓・capabilities の `windows`）。
const MAIN_WINDOW_LABEL: &str = "main";
const NOT_INSTALLED: Unavailable = Unavailable("develop sidecar is not installed");
const CLIENT_HEADER: &str = "x-niho-develop-client";
const ANALYSIS_GET: &str = "Analysis.get";
const ANALYSIS_PUT: &str = "Analysis.put";
const MAX_ANALYSIS_BYTES: usize = 16 * 1024 * 1024;
const MAX_ANALYSIS_FILES: usize = 4;
static ANALYSIS_CACHE_GUARD: Mutex<()> = Mutex::new(());

/// 受ける要求。
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
  /// CORS の preflight（`OPTIONS`）
  Preflight,
  /// `POST niho-develop://localhost/<method>`
  Call(String),
}

/// 要求の窓・HTTP method・URL を読む。main 窓の `POST` / `OPTIONS niho-develop://localhost/<method>` 以外は None（404）。
pub fn route(webview_label: &str, method: &Method, uri: &Uri) -> Option<Route> {
  if webview_label != MAIN_WINDOW_LABEL
    || uri.scheme_str() != Some(SCHEME)
    || uri.host() != Some("localhost")
    || uri.port().is_some()
    || uri.query().is_some()
  {
    return None;
  }
  let name = uri.path().strip_prefix('/').filter(|name| is_method_name(name))?;
  if method == Method::POST {
    Some(Route::Call(name.to_string()))
  } else if method == Method::OPTIONS {
    Some(Route::Preflight)
  } else {
    None
  }
}

/// 本文（の bytes 数）があり、1 GiB 以下か（違えば 400）。
pub fn body_fits(length: usize) -> bool {
  length > 0 && length <= MAX_BODY_BYTES
}

/// The Worker glue sends one random 128-bit token on every request. This
/// binds its Developer handles to one sidecar process across restarts.
pub fn client_id(headers: &HeaderMap) -> Option<&str> {
  headers
    .get(CLIENT_HEADER)
    .and_then(|value| value.to_str().ok())
    .filter(|value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// どの応答にも付ける（画面の XHR が status を読めるように。中身は都度違うのでキャッシュしない）。
fn base(status: StatusCode) -> response::Builder {
  Response::builder()
    .status(status)
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .header(header::CACHE_CONTROL, "no-store")
}

pub fn not_found() -> Response<Vec<u8>> {
  base(StatusCode::NOT_FOUND).body(Vec::new()).expect("404 response")
}

pub fn bad_request() -> Response<Vec<u8>> {
  base(StatusCode::BAD_REQUEST).body(Vec::new()).expect("400 response")
}

pub fn preflight() -> Response<Vec<u8>> {
  base(StatusCode::NO_CONTENT)
    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "POST")
    .header(
      header::ACCESS_CONTROL_ALLOW_HEADERS,
      "Content-Type, X-Niho-Develop-Client",
    )
    .header(header::ACCESS_CONTROL_MAX_AGE, "600")
    .body(Vec::new())
    .expect("204 response")
}

/// sidecar を使えない（画面は wasm へ落ちる）。
pub fn unavailable(reason: Unavailable) -> Response<Vec<u8>> {
  base(StatusCode::SERVICE_UNAVAILABLE)
    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
    .body(reason.0.as_bytes().to_vec())
    .expect("503 response")
}

/// serve の応答の本文（`ok:false` も含めてそのまま）。
pub fn answered(body: Vec<u8>) -> Response<Vec<u8>> {
  base(StatusCode::OK)
    .header(header::CONTENT_TYPE, "application/octet-stream")
    .body(body)
    .expect("200 response")
}

/// sidecar に渡して応答を作る（blocking。起動と `hello` もここで待つ）。
pub fn respond(engine: &DevelopEngine, client: &str, method: &str, body: &[u8]) -> Response<Vec<u8>> {
  match engine.call_for_client(client, method, body) {
    Ok(reply) => answered(reply),
    Err(CallError::UnknownMethod) => not_found(),
    Err(CallError::Unavailable(reason)) => unavailable(reason),
  }
}

fn analysis_key(body: &[u8]) -> Option<&str> {
  let key = std::str::from_utf8(body.get(..64)?).ok()?;
  (key
    .bytes()
    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
  .then_some(key)
}

fn analysis_file_name(key: &str) -> String {
  format!("{key}{ANALYSIS_CACHE_SUFFIX}")
}

fn private_analysis_dir(root: &Path) -> io::Result<std::path::PathBuf> {
  let dir = root.join(CACHE_DIR_NAME);
  fs::create_dir_all(&dir)?;
  if !fs::symlink_metadata(&dir)?.file_type().is_dir() {
    return Err(io::Error::new(
      io::ErrorKind::InvalidData,
      "analysis cache directory is not private",
    ));
  }
  fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
  Ok(dir)
}

fn write_analysis(dir: &Path, key: &str, bytes: &[u8]) -> io::Result<()> {
  let _guard = ANALYSIS_CACHE_GUARD.lock().unwrap_or_else(|poison| poison.into_inner());
  let dir = private_analysis_dir(dir)?;
  let temp = dir.join(format!(".{}", new_opaque_id("analysis")));
  let result = (|| {
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, dir.join(analysis_file_name(key)))?;
    let mut entries = fs::read_dir(&dir)?
      .filter_map(Result::ok)
      .filter_map(|entry| {
        let name = entry.file_name();
        let name = name.to_str()?;
        let key = name.strip_suffix(ANALYSIS_CACHE_SUFFIX)?;
        if key.len() != 64 || analysis_key(key.as_bytes()) != Some(key) {
          return None;
        }
        let metadata = fs::symlink_metadata(entry.path()).ok()?;
        metadata
          .file_type()
          .is_file()
          .then_some((metadata.modified().unwrap_or(UNIX_EPOCH), entry.path()))
      })
      .collect::<Vec<_>>();
    entries.sort();
    let excess = entries.len().saturating_sub(MAX_ANALYSIS_FILES);
    for (_, old) in entries.into_iter().take(excess) {
      fs::remove_file(old)?;
    }
    Ok(())
  })();
  if result.is_err() {
    let _ = fs::remove_file(temp);
  }
  result
}

/** sidecar から独立した、同じ Mac の作業コピーキャッシュ内の解析 bytes。鍵は SHA-256 だけを受ける。 */
pub fn respond_analysis(root: &Path, method: &str, body: &[u8]) -> Response<Vec<u8>> {
  let Some(key) = analysis_key(body) else {
    return bad_request();
  };
  match method {
    ANALYSIS_GET if body.len() == 64 => {
      let dir = root.join(CACHE_DIR_NAME);
      match fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return not_found(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return not_found(),
        Err(_) => return unavailable(Unavailable("analysis cache unavailable")),
      }
      let file = dir.join(analysis_file_name(key));
      let mut opened = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&file) {
        Ok(opened) => opened,
        Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ELOOP) => {
          return not_found()
        }
        Err(_) => return unavailable(Unavailable("analysis cache unavailable")),
      };
      let Ok(metadata) = opened.metadata() else {
        return unavailable(Unavailable("analysis cache unavailable"));
      };
      if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ANALYSIS_BYTES as u64 {
        return not_found();
      }
      let mut bytes = Vec::with_capacity(metadata.len() as usize);
      match opened.read_to_end(&mut bytes) {
        Ok(length) if length as u64 == metadata.len() => answered(bytes),
        _ => unavailable(Unavailable("analysis cache unavailable")),
      }
    }
    ANALYSIS_PUT if body.len() > 64 && body.len() <= 64 + MAX_ANALYSIS_BYTES => {
      match write_analysis(root, key, &body[64..]) {
        Ok(()) => answered(Vec::new()),
        Err(_) => unavailable(Unavailable("analysis cache unavailable")),
      }
    }
    _ => bad_request(),
  }
}

/// `register_asynchronous_uri_scheme_protocol` の handler。sidecar の待ちは blocking の thread で行う。
pub fn handle(context: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
  let method = match route(context.webview_label(), request.method(), request.uri()) {
    Some(Route::Call(method)) => method,
    Some(Route::Preflight) => return responder.respond(preflight()),
    None => return responder.respond(not_found()),
  };
  if !body_fits(request.body().len()) {
    return responder.respond(bad_request());
  }
  let Some(client) = client_id(request.headers()).map(str::to_owned) else {
    return responder.respond(bad_request());
  };
  if method == ANALYSIS_GET || method == ANALYSIS_PUT {
    let Ok(root) = context.app_handle().path().app_cache_dir() else {
      return responder.respond(unavailable(Unavailable("analysis cache unavailable")));
    };
    let body = request.into_body();
    tauri::async_runtime::spawn_blocking(move || {
      responder.respond(respond_analysis(&root, &method, &body));
    });
    return;
  }
  let Some(engine) = context
    .app_handle()
    .try_state::<DevelopEngine>()
    .map(|state| state.inner().clone())
  else {
    return responder.respond(unavailable(NOT_INSTALLED));
  };
  let body = request.into_body();
  tauri::async_runtime::spawn_blocking(move || {
    let _activity = crate::activity::hold();
    responder.respond(respond(&engine, &client, &method, &body));
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::develop_engine_sidecar::test_support::Fake;
  use crate::develop_engine_sidecar::{hello_request_body, Connection, Timeouts, NOT_BUNDLED};
  use std::sync::Arc;
  use std::time::Instant;

  fn parse(label: &str, method: Method, uri: &str) -> Option<Route> {
    route(label, &method, &uri.parse().ok()?)
  }

  #[test]
  fn only_the_main_window_may_post_a_method_name_to_localhost() {
    assert_eq!(
      parse("main", Method::POST, "niho-develop://localhost/render"),
      Some(Route::Call("render".into()))
    );
    assert_eq!(
      parse("main", Method::POST, "niho-develop://localhost/Developer.render"),
      Some(Route::Call("Developer.render".into()))
    );
    assert_eq!(
      parse("main", Method::OPTIONS, "niho-develop://localhost/Developer.render"),
      Some(Route::Preflight)
    );
    for label in ["", "e2e", "main2", "Main"] {
      assert_eq!(
        parse(label, Method::POST, "niho-develop://localhost/render"),
        None,
        "main 以外の窓: {label}"
      );
      assert_eq!(parse(label, Method::OPTIONS, "niho-develop://localhost/render"), None);
    }
    for method in [Method::GET, Method::PUT, Method::DELETE, Method::HEAD, Method::PATCH] {
      assert_eq!(
        parse("main", method.clone(), "niho-develop://localhost/render"),
        None,
        "{method}"
      );
    }
    for uri in [
      "niho-develop://example.com/render",
      "niho-develop://localhost:1430/render",
      "niho-thumb://localhost/render",
      "https://localhost/render",
      "tauri://localhost/render",
      "niho-develop://localhost/",
      "niho-develop://localhost/a/b",
      "niho-develop://localhost/render?x=1",
      "niho-develop://localhost/render2",
      "niho-develop://localhost/render%2Fx",
      "niho-develop://localhost/..%2F..%2Fetc",
      "niho-develop://localhost//render",
    ] {
      assert_eq!(parse("main", Method::POST, uri), None, "{uri}");
    }
    let long = format!("niho-develop://localhost/{}", "a".repeat(65));
    assert_eq!(parse("main", Method::POST, &long), None, "65 文字の method");
    let longest = format!("niho-develop://localhost/{}", "a".repeat(64));
    assert!(parse("main", Method::POST, &longest).is_some());
  }

  #[test]
  fn a_body_is_required_and_bounded() {
    assert!(!body_fits(0));
    assert!(body_fits(1));
    assert!(body_fits(1 << 30));
    assert!(!body_fits((1 << 30) + 1), "1 GiB を超える");
    let mut headers = HeaderMap::new();
    assert_eq!(client_id(&headers), None);
    headers.insert(CLIENT_HEADER, "0123456789abcdef0123456789abcdef".parse().unwrap());
    assert_eq!(client_id(&headers), Some("0123456789abcdef0123456789abcdef"));
    headers.insert(CLIENT_HEADER, "short".parse().unwrap());
    assert_eq!(client_id(&headers), None);
  }

  #[test]
  fn responses_allow_any_origin_and_are_never_cached() {
    let ok = answered(b"body".to_vec());
    assert_eq!(ok.status(), StatusCode::OK);
    assert_eq!(ok.headers()[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(ok.body(), b"body");
    let preflight = preflight();
    assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
    assert_eq!(preflight.headers()[header::ACCESS_CONTROL_ALLOW_METHODS], "POST");
    assert_eq!(
      preflight.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
      "Content-Type, X-Niho-Develop-Client"
    );
    assert_eq!(preflight.headers()[header::ACCESS_CONTROL_MAX_AGE], "600");
    let gone = unavailable(NOT_BUNDLED);
    assert_eq!(gone.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(gone.body(), NOT_BUNDLED.0.as_bytes());
    assert_eq!(not_found().status(), StatusCode::NOT_FOUND);
    assert_eq!(bad_request().status(), StatusCode::BAD_REQUEST);
    for response in [ok, preflight, gone, not_found(), bad_request()] {
      assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
      assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }
  }

  #[test]
  fn the_sidecar_answer_is_passed_through_and_unknown_methods_are_not_found() {
    let fake = Fake::echo();
    let client = "0123456789abcdef0123456789abcdef";
    assert_eq!(
      respond(&fake.engine, client, "hello", &hello_request_body()).status(),
      StatusCode::OK
    );
    let response = respond(&fake.engine, client, "render", b"abc");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"render:abc");
    assert_eq!(
      respond(&fake.engine, client, "exportTiff", b"abc").status(),
      StatusCode::NOT_FOUND,
      "hello の口の一覧に無い"
    );
    let crashed = respond(&fake.engine, client, "crash", b"x");
    assert_eq!(crashed.status(), StatusCode::SERVICE_UNAVAILABLE);
  }

  #[test]
  fn a_sidecar_that_cannot_start_is_service_unavailable() {
    let engine = DevelopEngine::new(
      Arc::new(|| -> Result<Connection, Unavailable> { Err(NOT_BUNDLED) }),
      Arc::new(Instant::now),
      Arc::new(|_, _| {}),
      Timeouts::default(),
    );
    let response = respond(
      &engine,
      "0123456789abcdef0123456789abcdef",
      "hello",
      &hello_request_body(),
    );
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.body(), NOT_BUNDLED.0.as_bytes());
  }

  #[test]
  fn analysis_cache_uses_only_hash_keys_and_rejects_symlinks() {
    let root = std::env::temp_dir().join(new_opaque_id("analysis-scheme-test"));
    fs::create_dir(&root).unwrap();
    let key = "a".repeat(64);
    let mut body = key.as_bytes().to_vec();
    body.extend_from_slice(&[1, 2, 3]);
    assert_eq!(respond_analysis(&root, ANALYSIS_PUT, &body).status(), StatusCode::OK);
    assert_eq!(respond_analysis(&root, ANALYSIS_GET, key.as_bytes()).body(), &[1, 2, 3]);
    assert_eq!(
      respond_analysis(&root, ANALYSIS_GET, b"not-a-hash").status(),
      StatusCode::BAD_REQUEST
    );
    assert_eq!(
      respond_analysis(&root, ANALYSIS_PUT, key.as_bytes()).status(),
      StatusCode::BAD_REQUEST
    );
    assert_eq!(
      respond_analysis(&root, ANALYSIS_PUT, &vec![b'a'; 65 + MAX_ANALYSIS_BYTES]).status(),
      StatusCode::BAD_REQUEST
    );
    let file = root.join(CACHE_DIR_NAME).join(analysis_file_name(&key));
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(root.join("missing"), &file).unwrap();
    assert_eq!(
      respond_analysis(&root, ANALYSIS_GET, key.as_bytes()).status(),
      StatusCode::NOT_FOUND
    );
    fs::remove_file(&file).unwrap();

    for digit in b'0'..=b'4' {
      let key = std::iter::repeat_n(digit, 64).collect::<Vec<_>>();
      let mut body = key.clone();
      body.push(digit);
      assert_eq!(respond_analysis(&root, ANALYSIS_PUT, &body).status(), StatusCode::OK);
    }
    let count = fs::read_dir(root.join(CACHE_DIR_NAME))
      .unwrap()
      .filter_map(Result::ok)
      .filter(|entry| entry.file_name().to_string_lossy().ends_with(ANALYSIS_CACHE_SUFFIX))
      .count();
    assert_eq!(count, MAX_ANALYSIS_FILES);
    fs::remove_dir_all(root).unwrap();
  }
}
