import Foundation

struct LocalAgentError: Error {
  let code: String
  init(_ code: String) { self.code = code }
}
#if !REAL_MODEL
struct NativeModelConfiguration {
  let endpoint: String, model: String, key: String
  var apiProtocol: String? = nil
  var requestURL: URL { URL(string: endpoint)! }
  var isResponses: Bool { false }
  func validate() throws {}
}
#endif
enum NovaBackgroundExecution {
  static var transfers = Set<String>()
  static func modelTransferStarted(_ id: String) { transfers.insert(id) }
  static func modelTransferFinished(_ id: String) { transfers.remove(id) }
}
#if !REAL_SCOPE
// The harness never writes to the developer's Application Support directory.
// Actual iOS path selection/protection still requires device acceptance.
enum NovaSpaceScope {
  struct Selection { let id: String; let mode: String }
  static var selected: Selection? = Selection(id: "one", mode: "standalone")
  static var root: URL!
  static let changed = Notification.Name("NovaSpaceScopeChanged")
  static func standaloneID() throws -> String {
    guard let selected, selected.mode == "standalone" else { throw LocalAgentError("space_changed") }
    return selected.id
  }
  static func modelTransferControlDirectory() throws -> URL { root.appendingPathComponent("controls") }
  static func invalidateProtection(_ id: String) throws {}
  static func supportPath(_ id: String) throws -> URL { root.appendingPathComponent(id) }
  static func supportDirectory(_ id: String) throws -> URL {
    let path = try supportPath(id)
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    return path
  }
}
#endif
