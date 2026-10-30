// Research only (#173): Tauri / wry を介さない素の WKWebView で、同じ page/ を開く（#148 の比べを広げたもの）。
//   wkwebview-probe <page dir> custom        probe://localhost/index.html（WKURLSchemeHandler。Tauri の tauri:// と同じ形）
//   wkwebview-probe <page dir> http <port>   http://127.0.0.1:<port>/index.html（`webview-isolation-probe serve <port>` が配る）
// 応答の header は src/main.rs と同じ。結果は src/main.rs と同じく、report の遷移を止めて JSON の行で stdout へ出す。
import AppKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count >= 3, arguments[2] == "custom" || (arguments[2] == "http" && arguments.count >= 4) else {
  FileHandle.standardError.write("usage: wkwebview-probe <page dir> custom | http <port>\n".data(using: .utf8)!)
  exit(2)
}
let directory = URL(fileURLWithPath: arguments[1])
let mode = "wk-\(arguments[2])"
let first = arguments[2] == "custom"
  ? URL(string: "probe://localhost/index.html")!
  : URL(string: "http://127.0.0.1:\(arguments[3])/index.html")!
let csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: probe-thumb:; connect-src 'self' probe-develop:; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'"
// 1x1 の RGBA PNG（合成。写真ではない）
let thumbnail = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaGj4DwAFhAKAjM1mJgAAAABJRU5ErkJggg==")!

final class SchemeHandler: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    let url = task.request.url!
    var status = 200
    var headers: [String: String] = [:]
    var body = Data()
    switch url.scheme {
    case "probe":
      let name = url.path == "/" ? "index.html" : String(url.path.dropFirst())
      if ["index.html", "probe.js", "worker.js"].contains(name),
        let data = try? Data(contentsOf: directory.appendingPathComponent(name))
      {
        headers = [
          "Content-Type": name.hasSuffix(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": csp,
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
        ]
        body = data
      } else {
        status = 404
      }
    case "probe-thumb":
      headers = ["Content-Type": "image/png", "Cache-Control": "private, max-age=300"]
      if url.path == "/corp.png" { headers["Cross-Origin-Resource-Policy"] = "cross-origin" }
      body = thumbnail
    case "probe-develop":
      headers = ["Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"]
      if task.request.httpMethod == "OPTIONS" {
        status = 204
        headers["Access-Control-Allow-Methods"] = "POST"
        headers["Access-Control-Allow-Headers"] = "content-type, x-probe-client"
        headers["Access-Control-Max-Age"] = "600"
      } else {
        headers["Content-Type"] = "text/plain; charset=utf-8"
        body = "hello".data(using: .utf8)!
      }
    default:
      status = 404
    }
    task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
    if !body.isEmpty { task.didReceive(body) }
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Probe: NSObject, WKNavigationDelegate {
  let window = NSWindow(
    contentRect: NSRect(x: -4000, y: -4000, width: 320, height: 200), styleMask: [.borderless], backing: .buffered,
    defer: false)
  var webView: WKWebView?

  func start() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let handler = SchemeHandler()
    for scheme in ["probe", "probe-thumb", "probe-develop"] {
      configuration.setURLSchemeHandler(handler, forURLScheme: scheme)
    }
    if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
    let webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
    webView.navigationDelegate = self
    window.contentView = webView
    self.webView = webView
    webView.load(URLRequest(url: first))
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url, url.host == "probe-report.invalid" else {
      decisionHandler(.allow)
      return
    }
    decisionHandler(.cancel)
    let report = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "r" }?.value
    let text = report ?? "null"
    print("{\"mode\":\"\(mode)\",\"result\":\(text)}")
    fflush(stdout)
    if text.contains("\"last\":true") { exit(0) }
    let next = URL(string: first.absoluteString + "?stage=2")!
    DispatchQueue.main.async { webView.load(URLRequest(url: next)) }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe()
probe.window.orderBack(nil)
DispatchQueue.main.async { probe.start() }
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
  print("{\"mode\":\"\(mode)\",\"error\":\"timeout\"}")
  exit(1)
}
app.run()
