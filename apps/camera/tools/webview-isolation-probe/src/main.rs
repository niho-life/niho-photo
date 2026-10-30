//! Research only (#173): 同じ page/ を配り方だけ変えて開き、画面と Worker が cross-origin isolated になるかを見る。
//!
//! - `tauri-asset`: Tauri の asset protocol（`tauri://localhost`）。COOP / COEP は tauri.conf.json の `app.security.headers`
//! - `custom`: 自前で登録した独自の scheme（`probe://localhost`）。COOP / COEP はこのファイルで付ける
//! - `http`: このプロセスが bind した `http://127.0.0.1:<port>`。COOP / COEP はこのファイルで付ける
//! - `http-plain`: `http` から COOP / COEP を外した対照
//! - `serve <port>`: http の配信だけ（窓を作らない）。素の WKWebView の比べ（wkwebview-probe.swift）が読む
//!
//! どのモードでも、画面から読む別 origin の資源は `probe-thumb:`（niho-thumb: と同じ形の画像。CORP あり・なし）と
//! `probe-develop:`（niho-develop: と同じ形の CORS の POST）。画面は結果を `https://probe-report.invalid/?r=<JSON>` への
//! 遷移で知らせ、`on_navigation` がその遷移を止めて JSON を 1 行で stdout へ出す。1 回目の後に `?stage=2` を開き直し、
//! 2 回目を出したら終わる。IPC・写真・外部への通信は使わない。

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use tauri::http::{Request, Response};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

const INDEX_HTML: &[u8] = include_bytes!("../page/index.html");
const PROBE_JS: &[u8] = include_bytes!("../page/probe.js");
const WORKER_JS: &[u8] = include_bytes!("../page/worker.js");

/// 1x1 の RGBA PNG（合成。写真ではない）
const THUMBNAIL_PNG: &[u8] = &[
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
  137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 104, 104, 104, 248, 15, 0, 5, 132, 2, 128, 140, 205, 102, 38, 0, 0,
  0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

/// tauri.conf.json の csp と同じ中身（`probe:` と http の応答に付ける）
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; \
  style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: probe-thumb:; connect-src 'self' probe-develop:; \
  object-src 'none'; base-uri 'none'; form-action 'none'";

const REPORT_HOST: &str = "probe-report.invalid";
const TIMEOUT: Duration = Duration::from_secs(60);

type Reply = (u16, Vec<(&'static str, &'static str)>, Vec<u8>);

/// page/ の 3 ファイル。`isolate` なら COOP / COEP / CORP を付ける
fn page(path: &str, isolate: bool) -> Reply {
  let (content_type, body) = match path {
    "/" | "/index.html" => ("text/html; charset=utf-8", INDEX_HTML),
    "/probe.js" => ("text/javascript; charset=utf-8", PROBE_JS),
    "/worker.js" => ("text/javascript; charset=utf-8", WORKER_JS),
    _ => return (404, vec![("Content-Type", "text/plain")], b"not found".to_vec()),
  };
  let mut headers = vec![
    ("Content-Type", content_type),
    ("Cache-Control", "no-store"),
    ("Content-Security-Policy", CSP),
  ];
  if isolate {
    headers.push(("Cross-Origin-Opener-Policy", "same-origin"));
    headers.push(("Cross-Origin-Embedder-Policy", "require-corp"));
    headers.push(("Cross-Origin-Resource-Policy", "same-origin"));
  }
  (200, headers, body.to_vec())
}

/// niho-thumb: と同じ形。`/corp.png` だけ `Cross-Origin-Resource-Policy: cross-origin` を付ける
fn thumbnail(path: &str) -> Reply {
  let mut headers = vec![("Content-Type", "image/png"), ("Cache-Control", "private, max-age=300")];
  match path {
    "/corp.png" => headers.push(("Cross-Origin-Resource-Policy", "cross-origin")),
    "/plain.png" => {}
    _ => return (404, vec![("Content-Type", "text/plain")], b"not found".to_vec()),
  }
  (200, headers, THUMBNAIL_PNG.to_vec())
}

/// niho-develop: と同じ形（独自の header 付きの POST なので preflight が来る）
fn develop(method: &str) -> Reply {
  let mut headers = vec![("Access-Control-Allow-Origin", "*"), ("Cache-Control", "no-store")];
  if method == "OPTIONS" {
    headers.extend([
      ("Access-Control-Allow-Methods", "POST"),
      ("Access-Control-Allow-Headers", "content-type, x-probe-client"),
      ("Access-Control-Max-Age", "600"),
    ]);
    return (204, headers, Vec::new());
  }
  headers.push(("Content-Type", "text/plain; charset=utf-8"));
  (200, headers, b"hello".to_vec())
}

fn respond((status, headers, body): Reply) -> Response<Vec<u8>> {
  let mut builder = Response::builder().status(status);
  for (name, value) in headers {
    builder = builder.header(name, value);
  }
  builder.body(body).expect("probe response")
}

fn serve_http(listener: TcpListener, isolate: bool) {
  for stream in listener.incoming().flatten() {
    std::thread::spawn(move || {
      let _ = answer_http(stream, isolate);
    });
  }
}

fn answer_http(mut stream: TcpStream, isolate: bool) -> std::io::Result<()> {
  let mut reader = BufReader::new(stream.try_clone()?);
  let mut request_line = String::new();
  reader.read_line(&mut request_line)?;
  loop {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
      break;
    }
  }
  let target = request_line.split_whitespace().nth(1).unwrap_or("/");
  let path = target.split(['?', '#']).next().unwrap_or("/");
  let (status, headers, body) = page(path, isolate);
  let mut head = format!(
    "HTTP/1.1 {status} {}\r\n",
    if status == 200 { "OK" } else { "Not Found" }
  );
  for (name, value) in headers {
    head.push_str(&format!("{name}: {value}\r\n"));
  }
  head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
  stream.write_all(head.as_bytes())?;
  stream.write_all(&body)?;
  stream.flush()
}

fn main() {
  let arguments: Vec<String> = std::env::args().skip(1).collect();
  let mode = arguments.first().map(String::as_str).unwrap_or("");
  if mode == "serve" {
    let port = arguments.get(1).and_then(|port| port.parse::<u16>().ok()).unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind 127.0.0.1");
    println!(
      "serving http://127.0.0.1:{}/",
      listener.local_addr().expect("local addr").port()
    );
    serve_http(listener, true);
    return;
  }
  let first = match mode {
    "tauri-asset" => None,
    "custom" => Some("probe://localhost/index.html".to_string()),
    "http" | "http-plain" => {
      let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind 127.0.0.1");
      let port = listener.local_addr().expect("local addr").port();
      let isolate = mode == "http";
      std::thread::spawn(move || serve_http(listener, isolate));
      Some(format!("http://127.0.0.1:{port}/index.html"))
    }
    _ => {
      eprintln!("usage: webview-isolation-probe <tauri-asset|custom|http|http-plain> | serve <port>");
      std::process::exit(2);
    }
  };
  let base = first
    .clone()
    .unwrap_or_else(|| "tauri://localhost/index.html".to_string());
  let label = mode.to_string();
  std::thread::spawn(move || {
    std::thread::sleep(TIMEOUT);
    println!("{{\"mode\":\"{label}\",\"error\":\"timeout\"}}");
    std::process::exit(1);
  });

  let label = mode.to_string();
  tauri::Builder::default()
    .register_uri_scheme_protocol("probe", |_context, request: Request<Vec<u8>>| {
      respond(page(request.uri().path(), true))
    })
    .register_uri_scheme_protocol("probe-thumb", |_context, request: Request<Vec<u8>>| {
      respond(thumbnail(request.uri().path()))
    })
    .register_uri_scheme_protocol("probe-develop", |_context, request: Request<Vec<u8>>| {
      respond(develop(request.method().as_str()))
    })
    .setup(move |app| {
      let url = match first {
        Some(url) => WebviewUrl::External(url.parse().expect("probe url")),
        None => WebviewUrl::App("index.html".into()),
      };
      let handle = app.handle().clone();
      WebviewWindowBuilder::new(app, "probe", url)
        .title("webview-isolation-probe")
        .inner_size(320.0, 200.0)
        .position(40.0, 40.0)
        .focused(false)
        .on_navigation(move |url: &Url| {
          if url.host_str() != Some(REPORT_HOST) {
            return true;
          }
          let report = url
            .query_pairs()
            .find(|(key, _)| key == "r")
            .map(|(_, value)| value.into_owned());
          let report = report.unwrap_or_else(|| "null".to_string());
          println!("{{\"mode\":\"{label}\",\"result\":{report}}}");
          if report.contains("\"last\":true") {
            handle.exit(0);
          } else {
            let next: Url = format!("{base}?stage=2").parse().expect("stage 2 url");
            let reopen = handle.clone();
            let _ = handle.run_on_main_thread(move || {
              if let Some(window) = reopen.get_webview_window("probe") {
                let _ = window.navigate(next);
              }
            });
          }
          false
        })
        .build()?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("tauri probe");
}
