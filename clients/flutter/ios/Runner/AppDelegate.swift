import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var localAgent: AnyObject?
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
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
