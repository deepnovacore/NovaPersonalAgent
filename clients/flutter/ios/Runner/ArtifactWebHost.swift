import Flutter
import UIKit
import WebKit

/// Generated pages have no native bridge, credentials or access to Nova data.
@MainActor final class ArtifactWebHost {
  private let channel: FlutterMethodChannel
  private var probe: ArtifactPage?
  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "nova/artifacts/v1", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, reply in
      Task { @MainActor in
        guard let self else { return }
        guard let input = call.arguments as? [String: Any], let html = input["html"] as? String,
          !html.isEmpty, html.utf8.count <= 256 * 1024,
          let parent = Self.presenter(), (UIApplication.shared.applicationState != .background || (call.method == "inspect" && NovaBackgroundExecution.hasExecutionTime())) else {
          reply(FlutterError(code: "artifact_unavailable", message: nil, details: nil)); return
        }
        do {
          let page = try await ArtifactPage(html: html)
          switch call.method {
          case "open":
            page.title = String((input["title"] as? String ?? "作品").prefix(200))
            let navigation = UINavigationController(rootViewController: page)
            navigation.modalPresentationStyle = .fullScreen
            parent.present(navigation, animated: true)
            reply(["opened": true])
          case "inspect":
            guard self.probe == nil, let script = input["script"] as? String, script.count <= 8000 else {
              reply(FlutterError(code: "artifact_test_busy_or_invalid", message: nil, details: nil)); return
            }
            self.probe = page
            parent.addChild(page); page.view.frame = parent.view.bounds
            parent.view.insertSubview(page.view, at: 0); page.didMove(toParent: parent)
            page.inspect(script: script) { [weak self, weak page] result in
              page?.willMove(toParent: nil); page?.view.removeFromSuperview(); page?.removeFromParent()
              self?.probe = nil; reply(result)
            }
          default: reply(FlutterError(code: "unsupported_artifact_command", message: nil, details: nil))
          }
        } catch { reply(FlutterError(code: "artifact_preview_failed", message: nil, details: nil)) }
      }
    }
  }
  private static func presenter() -> UIViewController? {
    var view = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
    while let shown = view?.presentedViewController { view = shown }
    return view
  }
}

@MainActor private final class ArtifactPage: UIViewController, WKNavigationDelegate {
  private let web: WKWebView
  private let html: String
  private var loaded = false
  private var script: String?
  private var completion: (([String: Any]) -> Void)?
  private var shareFile: URL?
  init(html: String) async throws {
    self.html = html
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let rules = """
    [{"trigger":{"url-filter":"^https?://.*"},"action":{"type":"block"}}]
    """
    let blocker: WKContentRuleList = try await withCheckedThrowingContinuation { continuation in
      WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "nova-local-artifacts-v1", encodedContentRuleList: rules) { rule, error in
        if let rule { continuation.resume(returning: rule) }
        else { continuation.resume(throwing: error ?? NSError(domain: "Artifact", code: 1)) }
      }
    }
    configuration.userContentController.add(blocker)
    configuration.userContentController.addUserScript(WKUserScript(source: """
    window.__novaPreviewErrors=[];
    addEventListener('error', e => window.__novaPreviewErrors.push(String(e.message || 'resource_error').slice(0,500)));
    addEventListener('unhandledrejection', e => window.__novaPreviewErrors.push(String(e.reason).slice(0,500)));
    """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    web = WKWebView(frame: .zero, configuration: configuration)
    super.init(nibName: nil, bundle: nil)
    web.navigationDelegate = self
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = .systemBackground
    web.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(web)
    NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)])
    navigationItem.leftBarButtonItem = UIBarButtonItem(title: "关闭", style: .plain, target: self, action: #selector(close))
    navigationItem.rightBarButtonItems = [UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(share)),
      UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reload))]
    web.loadHTMLString(html, baseURL: nil)
  }
  @objc private func close() { dismiss(animated: true) }
  @objc private func reload() { web.loadHTMLString(html, baseURL: nil) }
  @objc private func share() {
    do {
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let file = folder.appendingPathComponent("index.html")
      try html.write(to: file, atomically: true, encoding: .utf8); shareFile = file
      let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
      sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItems?.first
      sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
      present(sheet, animated: true)
    } catch {
      let alert = UIAlertController(title: "无法导出作品", message: "请重试。", preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "好", style: .default)); present(alert, animated: true)
    }
  }
  func inspect(script: String, completion: @escaping ([String: Any]) -> Void) {
    self.script = script; self.completion = completion
    if loaded { evaluate() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
      self?.finish(["loaded": false, "errors": ["preview_timeout"]])
    }
  }
  private func finish(_ value: [String: Any]) {
    guard let callback = completion else { return }
    completion = nil; web.stopLoading(); callback(value)
  }
  private func evaluate() {
    guard let script, completion != nil else { return }
    self.script = nil
    // Allow initialization promises and the first render to settle before checking.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      guard let self, self.completion != nil else { return }
      let wrapped = """
      (()=>{try {return JSON.stringify({loaded:true,title:document.title,errors:window.__novaPreviewErrors||[],result:(()=>{\(script)})()});}
      catch(e){return JSON.stringify({loaded:true,errors:[String(e)]});}})()
      """
      self.web.evaluateJavaScript(wrapped) { [weak self] value, error in
        guard let self else { return }
        if let text = value as? String, text.utf8.count <= 32768, let data = text.data(using: .utf8),
          let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { self.finish(result) }
        else { self.finish(["loaded": error == nil, "errors": [error == nil ? "invalid_test_result" : "javascript_evaluation_failed"]]) }
      }
    }
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true; evaluate() }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(["loaded": false, "errors": ["preview_navigation_failed"]]) }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(["loaded": false, "errors": ["preview_navigation_failed"]]) }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(["loaded": false, "errors": ["preview_process_stopped"]]) }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.request.url?.scheme == "about" ? .allow : .cancel)
  }
}
