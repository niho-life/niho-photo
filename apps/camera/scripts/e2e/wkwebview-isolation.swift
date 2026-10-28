// Research only (#148 の 0): Tauri を介さない素の WKWebView で、COOP / COEP を返す文書が crossOriginIsolated になるかを
// 読み込み方ごとに見る。
//   custom: WKURLSchemeHandler（独自の scheme。Tauri の tauri:// と同じ形）
//   http:   http://127.0.0.1:<port>/（引数で渡した Node の小さなサーバー。tauri-plugin-localhost と同じ形）
// 各モードで最初の読み込みと、location.reload() の後の 2 回を見る。結果は JSON の行で stdout へ。
// usage: wkwebview-isolation <page dir（index.html・worker.js）> <port>
import AppKit
import WebKit

let directory = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")

func body(for path: String) -> (String, Data)? {
  switch path {
  case "/", "/index.html": return ("text/html", try! Data(contentsOf: directory.appendingPathComponent("index.html")))
  case "/worker.js": return ("text/javascript", try! Data(contentsOf: directory.appendingPathComponent("worker.js")))
  default: return nil
  }
}

final class SchemeHandler: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url, let (mime, text) = body(for: url.path.isEmpty ? "/" : url.path) else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    let headers = [
      "Content-Type": mime,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    ]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(text)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Probe: NSObject, WKScriptMessageHandler {
  var modes: [(String, URL)]
  var webView: WKWebView?
  let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 320, height: 240), styleMask: [.borderless], backing: .buffered, defer: false)

  init(port: String) {
    modes = [
      ("custom", URL(string: "nihoprobe://localhost/")!),
      ("http", URL(string: "http://127.0.0.1:\(port)/")!),
    ]
  }

  func next() {
    guard !modes.isEmpty else {
      NSApp.terminate(nil)
      return
    }
    let (mode, url) = modes.removeFirst()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.setURLSchemeHandler(SchemeHandler(), forURLScheme: "nihoprobe")
    configuration.userContentController.add(self, name: "probe")
    if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
    let webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
    webView.customUserAgent = mode
    window.contentView = webView
    self.webView = webView
    webView.load(URLRequest(url: url))
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    let text = message.body as? String ?? "{}"
    print("{\"mode\":\"\(message.webView?.customUserAgent ?? "?")\",\"result\":\(text)}")
    fflush(stdout)
    if text.contains("\"last\":true") {
      controller.removeScriptMessageHandler(forName: "probe")
      DispatchQueue.main.async { self.next() }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe(port: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "18149")
probe.window.orderBack(nil)
DispatchQueue.main.async { probe.next() }
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
  print("{\"error\":\"timeout\"}")
  exit(1)
}
app.run()
