//! 一覧のタイルと開いた直後の仮の画のサムネイルを返す URI scheme（`niho-thumb://localhost/<entryId>?size=<64..256>`。macOS の
//! WKWebView の形）。編集面は写真の行の `previewUrl` を `<img src>` に入れるだけなので、この Mac の `PhotoLibrary`
//! （`src/local-library/local-photo-library.ts`）は一覧の写真ごとにこの URL を返す。
//!
//! - 受けるのは一覧で発行した不透明な `entryId` と大きさだけ（パスは受けない・返さない）。中身は `packages/desktop-photo` の
//!   `PhotoLibrary::thumbnail`（QuickLook / ImageIO・キャッシュ・同じ上限）
//! - 知らない ID・形の違う要求・作れなかったサムネイルは 404。main 窓（同梱の画面）からの要求だけに答える
//! - 画面の CSP の `img-src` に `niho-thumb:` を足してある（`tauri.conf.json`。`connect-src` は変えない）

use crate::library::{library, validate_thumbnail_request, ThumbnailRequest};
use crate::save::percent_decode;
use tauri::http::{header, Method, Request, Response, StatusCode, Uri};
use tauri::{UriSchemeContext, UriSchemeResponder, Wry};

/// scheme の名前（`tauri.conf.json` の CSP の `img-src` と、画面の `LOCAL_THUMBNAIL_SCHEME`）。
pub const SCHEME: &str = "niho-thumb";
/// サムネイルに答える窓（`tauri.conf.json` の窓・capabilities の `windows`）。
const MAIN_WINDOW_LABEL: &str = "main";

/// 要求の URL を読む（`GET niho-thumb://localhost/<entryId>?size=<n>`）。形が違えば None。
pub fn parse_thumbnail_request(method: &Method, uri: &Uri) -> Option<ThumbnailRequest> {
  if method != Method::GET || uri.scheme_str() != Some(SCHEME) || uri.host() != Some("localhost") {
    return None;
  }
  let entry_id = percent_decode(uri.path().strip_prefix('/')?)?;
  if entry_id.contains('/') || entry_id.chars().any(char::is_control) {
    return None;
  }
  let size = uri.query()?.strip_prefix("size=")?;
  if size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_digit()) || size.len() > 4 {
    return None;
  }
  let request = ThumbnailRequest {
    entry_id,
    max_dimension: size.parse().ok()?,
  };
  validate_thumbnail_request(&request).ok()?;
  Some(request)
}

/// サムネイルの形式（PNG か JPEG。どちらでもなければ None）。
pub fn image_content_type(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
    Some("image/png")
  } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
    Some("image/jpeg")
  } else {
    None
  }
}

fn not_found() -> Response<Vec<u8>> {
  Response::builder()
    .status(StatusCode::NOT_FOUND)
    .body(Vec::new())
    .expect("404 response")
}

fn image(bytes: Vec<u8>) -> Response<Vec<u8>> {
  let Some(content_type) = image_content_type(&bytes) else {
    return not_found();
  };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, content_type)
    // 中身は同じ ID・同じ大きさなら変わらない間はキャッシュにある（native もキャッシュする）
    .header(header::CACHE_CONTROL, "private, max-age=300")
    // 画面（tauri://localhost）は COEP: require-corp なので、別 origin のこの scheme は CORP を返さないと読めない（#148）
    .header("cross-origin-resource-policy", "cross-origin")
    .body(bytes)
    .unwrap_or_else(|_| not_found())
}

/// `register_asynchronous_uri_scheme_protocol` の handler。サムネイルは重いので、待ちは blocking の thread で行う。
pub fn handle(context: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
  if context.webview_label() != MAIN_WINDOW_LABEL {
    responder.respond(not_found());
    return;
  }
  let (Some(parsed), Ok(library)) = (
    parse_thumbnail_request(request.method(), request.uri()),
    library(context.app_handle()),
  ) else {
    responder.respond(not_found());
    return;
  };
  tauri::async_runtime::spawn_blocking(move || {
    let response = library
      .thumbnail(&parsed.entry_id, parsed.max_dimension)
      .map(image)
      .unwrap_or_else(|_| not_found());
    responder.respond(response);
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn parse(method: Method, uri: &str) -> Option<(String, u32)> {
    parse_thumbnail_request(&method, &uri.parse().ok()?).map(|request| (request.entry_id, request.max_dimension))
  }

  #[test]
  fn only_an_opaque_entry_id_and_a_size_are_accepted() {
    assert_eq!(
      parse(Method::GET, "niho-thumb://localhost/entry-1?size=256"),
      Some(("entry-1".into(), 256))
    );
    assert_eq!(
      parse(Method::GET, "niho-thumb://localhost/entry%201?size=64"),
      Some(("entry 1".into(), 64))
    );
    for uri in [
      "niho-thumb://localhost/entry-1",
      "niho-thumb://localhost/entry-1?size=63",
      "niho-thumb://localhost/entry-1?size=257",
      "niho-thumb://localhost/entry-1?size=-1",
      "niho-thumb://localhost/entry-1?size=256&path=/Users",
      "niho-thumb://localhost/entry-1?size=+256",
      "niho-thumb://localhost/?size=256",
      "niho-thumb://localhost/a/b?size=256",
      "niho-thumb://localhost/..%2F..%2Fetc%2Fpasswd?size=256",
      "niho-thumb://localhost/%0A?size=256",
      "niho-thumb://example.com/entry-1?size=256",
      "https://localhost/entry-1?size=256",
    ] {
      assert_eq!(parse(Method::GET, uri), None, "{uri}");
    }
    let long = format!("niho-thumb://localhost/{}?size=128", "x".repeat(129));
    assert_eq!(parse(Method::GET, &long), None, "長すぎる ID");
    assert_eq!(parse(Method::POST, "niho-thumb://localhost/entry-1?size=256"), None);
  }

  #[test]
  fn only_png_and_jpeg_thumbnails_are_served() {
    assert_eq!(image_content_type(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
    assert_eq!(image_content_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
    assert_eq!(image_content_type(b"<svg/>"), None);
    assert_eq!(image(b"<svg/>".to_vec()).status(), StatusCode::NOT_FOUND);
    let png = image(b"\x89PNG\r\n\x1a\n".to_vec());
    assert_eq!(png.status(), StatusCode::OK);
    assert_eq!(png.headers()[header::CONTENT_TYPE], "image/png");
  }
}
