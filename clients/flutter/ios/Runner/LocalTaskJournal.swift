import Foundation

struct LocalAgentError: Error, LocalizedError {
  let code: String
  init(_ code: String) { self.code = code }
  var errorDescription: String? { code }
}

/// The caller serializes access on the main actor. A task and its action intent
/// are replaced atomically before crossing into an external tool.
final class LocalTaskJournal {
  private let file: URL
  private var records: [[String: Any]]
  init(file: URL) throws {
    self.file = file
    if FileManager.default.fileExists(atPath: file.path) {
      guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]] else {
        throw LocalAgentError("invalid_task_journal")
      }
      records = value
    } else { records = [] }
    var recovered = records
    for i in recovered.indices where ["running", "waiting_approval"].contains(recovered[i]["phase"] as? String ?? "") {
      recovered[i]["phase"] = "interrupted"
      recovered[i]["summary"] = "上次执行中断，请核对结果后重新委托。"
      recovered[i].removeValue(forKey: "proposal")
      var operations = recovered[i]["operations"] as? [[String: Any]] ?? []
      for j in operations.indices where operations[j]["state"] as? String == "intent" { operations[j]["state"] = "unknown" }
      recovered[i]["operations"] = operations
    }
    try save(recovered)
  }
  var tasks: [[String: Any]] { records.reversed() }
  func task(_ id: String) -> [String: Any]? { records.first { $0["id"] as? String == id } }
  private func save(_ next: [[String: Any]]) throws {
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: next, options: [.sortedKeys])
    #if os(iOS)
    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
    try data.write(to: file, options: .atomic)
    #endif
    records = next
  }
  func edit(_ id: String, _ change: (inout [String: Any]) throws -> Void) throws {
    guard let i = records.firstIndex(where: { $0["id"] as? String == id }) else { throw LocalAgentError("task_not_found") }
    var next = records
    try change(&next[i]); try save(next)
  }
  func start(_ input: [String: Any]) throws -> [String: Any] {
    guard let id = input["id"] as? String, !id.isEmpty, id.count <= 100,
          let goal = input["goal"] as? String, !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, goal.count <= 4000,
          let acceptance = input["acceptance"] as? String, !acceptance.isEmpty, acceptance.count <= 2000,
          let target = input["target_package"] as? String, ["nova", "calendar", "reminders"].contains(target) else { throw LocalAgentError("invalid_task") }
    let mode = input["interaction_mode"] as? String ?? "manual"
    guard ["manual", "chat"].contains(mode) else { throw LocalAgentError("invalid_interaction_mode") }
    if let previous = task(id) {
      guard (previous["interaction_mode"] as? String ?? "manual") == mode else { throw LocalAgentError("task_id_conflict") }
      let priorRef = try JSONSerialization.data(withJSONObject: previous["todo_ref"] ?? [:], options: .sortedKeys)
      let nextRef = try JSONSerialization.data(withJSONObject: input["todo_ref"] ?? [:], options: .sortedKeys)
      guard priorRef == nextRef else { throw LocalAgentError("task_id_conflict") }
      guard previous["goal"] as? String == goal, previous["acceptance"] as? String == acceptance,
            previous["target_package"] as? String == target else { throw LocalAgentError("task_id_conflict") }
      return previous
    }
    guard !records.contains(where: { ["running", "waiting_approval"].contains($0["phase"] as? String ?? "") }) else { throw LocalAgentError("another_task_is_active") }
    guard records.count < 1000 else { throw LocalAgentError("task_store_capacity") }
    var record: [String: Any] = ["id": id, "goal": goal, "acceptance": acceptance, "target_package": target,
      "interaction_mode": mode, "phase": "running", "created_at": Date().timeIntervalSince1970 * 1000, "operations": [[String: Any]]()]
    if let todo = input["todo_ref"] {
      guard let ref = todo as? [String: Any], Set(ref.keys) == ["id", "version"], let id = ref["id"] as? String, !id.isEmpty, id.count <= 200,
        let version = ref["version"] as? Int, version > 0 else { throw LocalAgentError("invalid_todo_reference") }
      record["todo_ref"] = ref
    }
    try save(records + [record]); return record
  }
  func propose(_ id: String, action: [String: Any], summary: String, now: TimeInterval) throws -> String {
    let proposal = UUID().uuidString
    try edit(id) { task in
      guard task["phase"] as? String == "running" else { throw LocalAgentError("task_not_running") }
      task["phase"] = "waiting_approval"
      task["proposal"] = ["id": proposal, "action": action, "summary": summary, "expires": now + 90]
    }
    return proposal
  }
  func consume(_ id: String, proposal: String, now: TimeInterval) throws -> String {
    let operation = UUID().uuidString
    try edit(id) { task in
      guard task["phase"] as? String == "waiting_approval", let pending = task["proposal"] as? [String: Any],
            pending["id"] as? String == proposal, let expires = pending["expires"] as? Double, now < expires else { throw LocalAgentError("stale_approval") }
      var operations = task["operations"] as? [[String: Any]] ?? []
      operations.append(["id": operation, "action": pending["action"]!, "state": "intent"])
      task["operations"] = operations; task["phase"] = "running"; task.removeValue(forKey: "proposal")
    }
    return operation
  }
  func chatIntent(_ id: String, action: [String: Any], summary: String) throws -> String {
    let operation = UUID().uuidString
    try edit(id) { task in
      guard task["phase"] as? String == "running", task["interaction_mode"] as? String == "chat" else { throw LocalAgentError("chat_task_not_running") }
      var operations = task["operations"] as? [[String: Any]] ?? []
      operations.append(["id": operation, "action": action, "state": "intent"])
      task["operations"] = operations; task["summary"] = summary
    }
    return operation
  }
  func receipt(_ id: String, operation: String, result: [String: Any]) throws {
    try edit(id) { task in
      var operations = task["operations"] as? [[String: Any]] ?? []
      guard let i = operations.firstIndex(where: { $0["id"] as? String == operation }) else { throw LocalAgentError("operation_not_found") }
      guard operations[i]["state"] as? String != "applied" else { return }
      operations[i]["state"] = "applied"; operations[i]["result"] = result; task["operations"] = operations
    }
  }
  func end(_ id: String, phase: String, summary: String) throws {
    try edit(id) { task in
      guard ["running", "waiting_approval", "verifying"].contains(task["phase"] as? String ?? "") else { return }
      task["phase"] = phase; task["summary"] = summary; task.removeValue(forKey: "proposal")
      if phase == "interrupted" || phase == "cancelled" {
        var operations = task["operations"] as? [[String: Any]] ?? []
        for i in operations.indices where operations[i]["state"] as? String == "intent" { operations[i]["state"] = "unknown" }
        task["operations"] = operations
      }
    }
  }
}
