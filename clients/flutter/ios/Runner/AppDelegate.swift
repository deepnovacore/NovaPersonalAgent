import Flutter
import UIKit
import SafariServices

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate, SFSafariViewControllerDelegate {
  private var chatGptBrowser: SFSafariViewController?
  private var chatGptBrowserChannel: FlutterMethodChannel?
  private var localAgent: AnyObject?
  private var artifactHost: ArtifactWebHost?
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    chatGptBrowser = nil
    chatGptBrowserChannel?.invokeMethod("closed", arguments:nil)
  }
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    NovaScheduleBridge.register()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    if identifier == NativeModelTransfer.sessionID { NativeModelTransfer.shared.handleEvents(identifier: identifier, completion: completionHandler) }
    else { super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler) }
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaChatGptBrowser") {
      let channel = FlutterMethodChannel(name: "nova/chatgpt_browser/v1", binaryMessenger: registrar.messenger())
      chatGptBrowserChannel = channel
      channel.setMethodCallHandler { [weak self] call, reply in
        guard let self else { reply(false); return }
        if call.method == "close" {
          self.chatGptBrowser?.dismiss(animated: true); self.chatGptBrowser = nil; reply(nil); return
        }
        guard call.method == "open", let args = call.arguments as? [String:Any],
              let text = args["url"] as? String, let url = URL(string:text),
              url.scheme == "https", url.host == "auth.openai.com", url.path == "/api/accounts/authorize",
              self.chatGptBrowser == nil,
              let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap({ $0.windows }).first(where: { $0.isKeyWindow })?.rootViewController else { reply(false); return }
        var presenter = root
        while let presented = presenter.presentedViewController { presenter = presented }
        let browser = SFSafariViewController(url:url)
        browser.delegate = self
        self.chatGptBrowser = browser
        presenter.present(browser, animated:true) { reply(true) }
      }
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaExecution") {
      NovaScheduleBridge.install(messenger: registrar.messenger())
      NovaBackgroundExecution.install(with: registrar.messenger())
      NativeModelTransfer.shared.install(messenger: registrar.messenger())
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaArtifacts") {
      artifactHost = ArtifactWebHost(messenger: registrar.messenger())
    }
    if #available(iOS 15.0, *), let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaLocalAgent") {
      do { localAgent = try LocalAgentHost(messenger: registrar.messenger()) }
      catch {
        let channel = FlutterMethodChannel(name: "nova/local_agent/v1", binaryMessenger: registrar.messenger())
        channel.setMethodCallHandler { _, reply in
          reply(FlutterError(code: "native_task_store_unavailable", message: "本机任务记录无法打开，未覆盖已有数据。", details: nil))
        }
        localAgent = channel
      }
    }
  }
}
