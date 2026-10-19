import Foundation

@main struct NovaWorkspaceRequestChecks {
  static func main() throws {
    let good: [String: Any] = ["id":"request-1", "command":"printf 'hello'", "timeout_ms":1234,
      "environment":["NOVA_BROWSER_URL":"http://127.0.0.1:3210", "NOVA_BROWSER_TOKEN":"secret"]]
    let request = try NovaWorkspaceRequest(good)
    precondition(request.cwd == "/workspace" && request.timeout == 1.234)
    precondition(request.environment["NOVA_BROWSER_TOKEN"] == "secret")
    for patch: [String: Any] in [["id":"../escape"], ["id":""], ["cwd":"/workspace/../etc"],
      ["cwd":"/etc"], ["timeout_ms":0], ["timeout_ms":3600001], ["timeout_ms":true],
      ["environment":["PATH":"/evil"]], ["environment":["NOVA_BROWSER_TOKEN":"x\0y"]],
      ["command":"x\0y"], ["command":""], ["cwd":"relative"]] {
      var value = good; value.merge(patch) { _, b in b }
      do { _ = try NovaWorkspaceRequest(value); fatalError("Accepted invalid input: \(patch.keys)") }
      catch is NovaWorkspaceRequest.Invalid {}
    }
    let root = URL(fileURLWithPath:"/private/var/mobile/Library/Application Support")
    precondition(NovaWorkspaceRequest.validRoot(root.appendingPathComponent("nova-workspace").path, support:root))
    precondition(!NovaWorkspaceRequest.validRoot("/tmp/nova-workspace", support:root))
    precondition(NovaWorkspaceRequest.quote("a'b") == "'a'\\''b'")
    print("NovaWorkspaceRequestChecks passed")
  }
}
