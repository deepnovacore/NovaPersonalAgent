import Foundation
import CoreFoundation

/// Host-only channel input. No model-provided native paths or arbitrary environment.
struct NovaWorkspaceRequest {
  struct Invalid: Error {}
  let id: String
  let command: String
  let cwd: String
  let timeout: TimeInterval
  let environment: [String: String]

  init(_ args: [String: Any]) throws {
    guard let id = args["id"] as? String, Self.validID(id),
          let command = args["command"] as? String, !command.isEmpty,
          !command.contains("\0"), command.utf8.count <= 1_048_576,
          let millis = args["timeout_ms"] as? NSNumber,
          CFGetTypeID(millis) != CFBooleanGetTypeID(), millis.doubleValue.isFinite,
          millis.doubleValue >= 1, millis.doubleValue <= 3_600_000 else { throw Invalid() }
    let cwd = args["cwd"] as? String ?? "/workspace"
    guard (cwd == "/workspace" || cwd.hasPrefix("/workspace/")),
          !cwd.split(separator:"/", omittingEmptySubsequences:false).contains(".."),
          !cwd.contains("\0"), cwd.utf8.count < 4096 else { throw Invalid() }
    let environment = args["environment"] as? [String:String] ?? [:]
    guard args["environment"] == nil || args["environment"] is [String:String],
          environment.allSatisfy({ ["NOVA_BROWSER_URL", "NOVA_BROWSER_TOKEN"].contains($0.key) && !$0.value.contains("\0") && $0.value.utf8.count < 2048 }) else { throw Invalid() }
    self.id = id; self.command = command; self.cwd = cwd
    timeout = millis.doubleValue / 1000; self.environment = environment
  }

  static func validID(_ id: String) -> Bool {
    !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
  }
  static func validRoot(_ path: String, support: URL, spaceID: String? = nil) -> Bool {
    guard path.hasPrefix("/") else { return false }
    let scoped = spaceID.map { support.appendingPathComponent("spaces").appendingPathComponent($0) } ?? support
    let expected = scoped.appendingPathComponent("nova-workspace").standardizedFileURL.resolvingSymlinksInPath()
    return URL(fileURLWithPath:path).standardizedFileURL.resolvingSymlinksInPath() == expected
  }
  static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of:"'", with:"'\\''") + "'" }
}
