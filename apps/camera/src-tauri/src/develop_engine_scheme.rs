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
use tauri::http::{header, response, Method, Request, Response, StatusCode, Uri};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

/// scheme の名前（`tauri.conf.json` の CSP の `connect-src` と、画面の native glue）。
pub const SCHEME: &str = "niho-develop";
/// 現像の口に答える窓（`tauri.conf.json` の窓・capabilities の `windows`）。
const MAIN_WINDOW_LABEL: &str = "main";
const NOT_INSTALLED: Unavailable = Unavailable("develop sidecar is not installed");

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
    .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type")
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
pub fn respond(engine: &DevelopEngine, method: &str, body: &[u8]) -> Response<Vec<u8>> {
  match engine.call(method, body) {
    Ok(reply) => answered(reply),
    Err(CallError::UnknownMethod) => not_found(),
    Err(CallError::Unavailable(reason)) => unavailable(reason),
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
    responder.respond(respond(&engine, &method, &body));
  });
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::develop_engine_sidecar::test_support::Fake;
  use crate::develop_engine_sidecar::{Connection, Timeouts, NOT_BUNDLED};
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
      "Content-Type"
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
    let response = respond(&fake.engine, "render", b"abc");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"render:abc");
    assert_eq!(
      respond(&fake.engine, "exportTiff", b"abc").status(),
      StatusCode::NOT_FOUND,
      "hello の口の一覧に無い"
    );
    let crashed = respond(&fake.engine, "crash", b"x");
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
    let response = respond(&engine, "render", b"x");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.body(), NOT_BUNDLED.0.as_bytes());
  }
}
