import Flutter
import UIKit
import UserNotifications

final class NovaSpacePush: NSObject, FlutterStreamHandler {
  static let shared = NovaSpacePush()
  private var token: String?
  private var events: FlutterEventSink?
  private var pending: [[String: Any]] = []
  private var method: FlutterMethodChannel?
  private var stream: FlutterEventChannel?
  func install(_ messenger: FlutterBinaryMessenger) {
    method = FlutterMethodChannel(name: "nova/space_push", binaryMessenger: messenger)
    method?.setMethodCallHandler { [weak self] call, reply in
      guard let self else { reply(nil); return }
      let args = call.arguments as? [String: Any] ?? [:]
      switch call.method {
      case "requestPermission":
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { allowed, _ in
          DispatchQueue.main.async { if allowed { UIApplication.shared.registerForRemoteNotifications() }; reply(allowed) }
        }
      case "getToken":
        UIApplication.shared.registerForRemoteNotifications()
        reply(self.token.map { ["provider": "apns", "token": $0] })
      case "configureSpace":
        guard let handle = args["handle"] as? String else { reply(FlutterError(code: "invalid_push_config", message: nil, details: nil)); return }
        do { if let key = args["notificationKey"] as? String { try NovaPushCrypto.save(handle: handle, encoded: key) }; reply(nil) }
        catch { reply(FlutterError(code: "push_key_unavailable", message: nil, details: nil)) }
      case "removeSpace":
        if let handle = args["handle"] as? String { NovaPushCrypto.remove(handle: handle) }; reply(nil)
      default: reply(FlutterMethodNotImplemented)
      }
    }
    stream = FlutterEventChannel(name: "nova/space_push/events", binaryMessenger: messenger)
    stream?.setStreamHandler(self)
  }
  func registered(_ data: Data) {
    token = data.map { String(format: "%02x", $0) }.joined()
    emit(["type": "token", "provider": "apns", "token": token!])
  }
  func opened(_ info: [AnyHashable: Any]) {
    guard let notificationID = info["notificationId"] as? String else { return }
    var event: [String: Any] = ["type": "open", "notificationId": notificationID]
    if let handle = info["handle"] as? String { event["handle"] = handle }
    emit(event)
  }
  private func emit(_ event: [String: Any]) {
    if let events { events(event) } else { pending.append(event); if pending.count > 32 { pending.removeFirst() } }
  }
  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    self.events = events; pending.forEach { events($0) }; pending.removeAll(); return nil
  }
  func onCancel(withArguments arguments: Any?) -> FlutterError? { events = nil; return nil }
}
