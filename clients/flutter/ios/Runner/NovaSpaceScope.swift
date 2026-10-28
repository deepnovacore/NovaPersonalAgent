import Foundation
import Flutter

/// Main-thread selection shared by foreground and scheduler engines. No native
/// local planner exists until Flutter selects a standalone Space.
enum NovaSpaceScope {
  struct Selection: Equatable { let id: String; let mode: String }
  static private(set) var selected: Selection?
  static let changed = Notification.Name("NovaSpaceScopeChanged")
  private static var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]
  static func install(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "nova/space_scope", binaryMessenger: messenger)
    channels[ObjectIdentifier(messenger as AnyObject)] = channel
    channel.setMethodCallHandler { call, reply in
      guard call.method == "setSpaceScope" else { reply(FlutterMethodNotImplemented); return }
      guard let args = call.arguments as? [String: Any], let id = args["spaceId"] as? String,
        validID(id), let mode = args["mode"] as? String, ["standalone", "client"].contains(mode) else {
        reply(FlutterError(code: "invalid_space_scope", message: nil, details: nil)); return
      }
      let next = Selection(id: id, mode: mode)
      if selected != next { selected = next; NotificationCenter.default.post(name: changed, object: nil) }
      reply(nil)
    }
  }
  static func uninstall(messenger: FlutterBinaryMessenger) {
    channels.removeValue(forKey: ObjectIdentifier(messenger as AnyObject))?.setMethodCallHandler(nil)
  }
  static func validID(_ id: String) -> Bool {
    !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
  }
  static func standaloneID() throws -> String {
    guard let selected, selected.mode == "standalone" else { throw LocalAgentError("local_runtime_unavailable") }
    return selected.id
  }
  static func supportDirectory(_ id: String) throws -> URL {
    guard validID(id) else { throw LocalAgentError("invalid_space_scope") }
    let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return root.appendingPathComponent("spaces", isDirectory: true).appendingPathComponent(id, isDirectory: true)
  }
}
