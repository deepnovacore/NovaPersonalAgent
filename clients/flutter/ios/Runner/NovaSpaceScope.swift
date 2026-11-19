import Foundation
import Flutter

/// Main-thread selection shared by foreground and scheduler engines. No native
/// local planner exists until Flutter selects a standalone Space.
enum NovaSpaceScope {
  struct Selection: Equatable { let id: String; let mode: String }
  static private(set) var selected: Selection?
  static let changed = Notification.Name("NovaSpaceScopeChanged")
  private static let privateDirectories = PrivateSpaceDirectory()
  private static var channels: [ObjectIdentifier: FlutterMethodChannel] = [:]
  static func install(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "nova/space_scope", binaryMessenger: messenger)
    channels[ObjectIdentifier(messenger as AnyObject)] = channel
    channel.setMethodCallHandler { call, reply in
      if call.method == "prepareSpaceDirectory" || call.method == "invalidateModelTransfers" {
        do {
          guard let args = call.arguments as? [String: Any], let id = args["spaceId"] as? String, validID(id) else { throw LocalAgentError("invalid_space_scope") }
          if call.method == "prepareSpaceDirectory" { reply(try supportDirectory(id).path) }
          else { try NativeModelTransfer.shared.invalidate(spaceId: id); reply(nil) }
        } catch { reply(FlutterError(code: "space_privacy_unavailable", message: nil, details: nil)) }
        return
      }
      guard call.method == "setSpaceScope" else { reply(FlutterMethodNotImplemented); return }
      guard let args = call.arguments as? [String: Any], let id = args["spaceId"] as? String,
        validID(id), let mode = args["mode"] as? String, ["standalone", "client"].contains(mode) else {
        reply(FlutterError(code: "invalid_space_scope", message: nil, details: nil)); return
      }
      let next = Selection(id: id, mode: mode)
      if selected != next {
        do { if let old = selected { try NativeModelTransfer.shared.invalidate(spaceId: old.id) } }
        catch { reply(FlutterError(code: "space_privacy_unavailable", message: nil, details: nil)); return }
        selected = next; NotificationCenter.default.post(name: changed, object: nil)
        NativeModelTransfer.shared.reconcile(spaceId: id)
      }
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
  static func modelTransferControlDirectory() throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("ModelTransferAuthority", isDirectory: true)
  }
  static func supportPath(_ id: String) throws -> URL {
    guard validID(id) else { throw LocalAgentError("invalid_space_scope") }
    let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return root.appendingPathComponent("spaces", isDirectory: true).appendingPathComponent(id, isDirectory: true)
  }
  static func supportDirectory(_ id: String) throws -> URL {
    try privateDirectories.prepare(supportPath(id))
  }
  static func invalidateProtection(_ id: String) throws {
    privateDirectories.invalidate(try supportPath(id))
  }
}
