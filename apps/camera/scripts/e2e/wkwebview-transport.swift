// Research only (#148 B): WKURLSchemeHandler（Tauri の独自の scheme と同じ形）と Worker の間の受け渡しの速さ。
// usage: wkwebview-transport <page dir（index.html・worker.js）>
import AppKit
import WebKit

let directory = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")

final class SchemeHandler: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    var mime = "application/octet-stream"
    var data: Data
    switch url.path {
    case "/", "/index.html":
      mime = "text/html"
      data = try! Data(contentsOf: directory.appendingPathComponent("index.html"))
    case "/worker.js":
      mime = "text/javascript"
      data = try! Data(contentsOf: directory.appendingPathComponent("worker.js"))
    case "/blob":
      let bytes = Int(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "0") ?? 0
      data = Data(count: bytes)
    case "/echo":
      var length = UInt32(task.request.httpBody?.count ?? 0)
      if length == 0, let stream = task.request.httpBodyStream {
        stream.open()
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        while stream.hasBytesAvailable {
          let read = stream.read(&buffer, maxLength: buffer.count)
          if read <= 0 { break }
          length += UInt32(read)
        }
        stream.close()
      }
      data = withUnsafeBytes(of: length.littleEndian) { Data($0) }
    default:
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Access-Control-Allow-Origin": "*"])!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Probe: NSObject, WKScriptMessageHandler {
  let window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 320, height: 240), styleMask: [.borderless], backing: .buffered, defer: false)
  var webView: WKWebView?

  func start() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.setURLSchemeHandler(SchemeHandler(), forURLScheme: "nihoprobe")
    configuration.userContentController.add(self, name: "probe")
    if #available(macOS 14.0, *) { configuration.preferences.inactiveSchedulingPolicy = .none }
    let webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
    window.contentView = webView
    self.webView = webView
    webView.load(URLRequest(url: URL(string: "nihoprobe://localhost/")!))
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    print(message.body as? String ?? "{}")
    exit(0)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe()
probe.window.orderBack(nil)
DispatchQueue.main.async { probe.start() }
DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
  print("{\"error\":\"timeout\"}")
  exit(1)
}
app.run()
