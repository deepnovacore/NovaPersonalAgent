import Flutter
import UIKit
import SafariServices
import UserNotifications
#if NOVA_WORKSPACE_ACCEPTANCE
import Network
#endif

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate, SFSafariViewControllerDelegate {
  private var chatGptBrowser: SFSafariViewController?
  private var chatGptBrowserChannel: FlutterMethodChannel?
  private var localAgent: AnyObject?
  private var scopeObserver: NSObjectProtocol?
  private var spaceTools: NovaSpaceTools?
  private var workspace: NovaWorkspaceBridge?
  private var artifactHost: ArtifactWebHost?
  #if NOVA_WORKSPACE_ACCEPTANCE
  private var acceptanceNetwork: FlutterMethodChannel?
  #endif
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    chatGptBrowser = nil
    chatGptBrowserChannel?.invokeMethod("closed", arguments:nil)
  }
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    #if NOVA_WORKSPACE_ACCEPTANCE
    application.isIdleTimerDisabled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 600) { application.isIdleTimerDisabled = false }
    #endif
    NovaScheduleBridge.register()
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    NovaSpacePush.shared.registered(deviceToken)
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }
  override func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    NovaSpacePush.shared.opened(response.notification.request.content.userInfo)
    super.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler)
  }

  override func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    if identifier == NativeModelTransfer.sessionID { NativeModelTransfer.shared.handleEvents(identifier: identifier, completion: completionHandler) }
    else { super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler) }
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaSpacePush") { NovaSpacePush.shared.install(registrar.messenger()) }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaSpaceTools") { spaceTools = NovaSpaceTools(registrar: registrar) }
    #if NOVA_WORKSPACE_ACCEPTANCE
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaAcceptanceNetwork") {
      let channel = FlutterMethodChannel(name: "nova/acceptance_network/v1", binaryMessenger: registrar.messenger())
      acceptanceNetwork = channel
      channel.setMethodCallHandler { call, reply in
        guard call.method == "probe" else { reply(FlutterMethodNotImplemented); return }
        let monitor = NWPathMonitor()
        var pathInfo: [String: Any] = ["status": "pending"]
        monitor.pathUpdateHandler = { path in
          pathInfo = ["status": String(describing: path.status),
                      "unsatisfied_reason": String(describing: path.unsatisfiedReason),
                      "wifi": path.usesInterfaceType(.wifi),
                      "cellular": path.usesInterfaceType(.cellular),
                      "supports_dns": path.supportsDNS,
                      "supports_ipv4": path.supportsIPv4,
                      "supports_ipv6": path.supportsIPv6]
        }
        monitor.start(queue: .main)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        let session = URLSession(configuration: configuration)
        var request = URLRequest(url: URL(string: "https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.21/main/aarch64/APKINDEX.tar.gz")!)
        request.httpMethod = "HEAD"
        session.dataTask(with: request) { _, response, error in
          DispatchQueue.main.async {
            var result: [String: Any] = ["path": pathInfo]
            if let response = response as? HTTPURLResponse { result["http_status"] = response.statusCode }
            if let error = error as NSError? {
              result["error_domain"] = error.domain
              result["error_code"] = error.code
              result["error"] = error.localizedDescription
              if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
                result["underlying_domain"] = underlying.domain
                result["underlying_code"] = underlying.code
                result["underlying"] = underlying.localizedDescription
              }
            }
            monitor.cancel()
            session.invalidateAndCancel()
            reply(result)
          }
        }.resume()
      }
    }
    #endif
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
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaWorkspace") {
      workspace = NovaWorkspaceBridge(messenger: registrar.messenger())
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaArtifacts") {
      artifactHost = ArtifactWebHost(messenger: registrar.messenger())
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NovaLocalAgent") {
      let messenger = registrar.messenger()
      let updateScope: () -> Void = { [weak self] in
        guard let self else { return }
        (self.localAgent as? LocalAgentHost)?.close(); self.localAgent = nil
        do {
          let id = try NovaSpaceScope.standaloneID()
          self.localAgent = try LocalAgentHost(messenger: messenger, spaceId: id)
        } catch {
          let channel = FlutterMethodChannel(name: "nova/local_agent/v1", binaryMessenger: messenger)
          channel.setMethodCallHandler { _, reply in reply(FlutterError(code: "local_runtime_unavailable", message: nil, details: nil)) }
          self.localAgent = channel
        }
      }
      if let observer = scopeObserver { NotificationCenter.default.removeObserver(observer) }
      scopeObserver = NotificationCenter.default.addObserver(forName: NovaSpaceScope.changed, object: nil, queue: .main) { _ in updateScope() }
      updateScope()
      NovaSpaceScope.install(messenger: messenger)
    }
  }
}
