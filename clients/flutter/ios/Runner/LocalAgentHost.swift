import Flutter
import Foundation
import UIKit

/// Main-actor single writer. User-started work shares the chat background lease.
@available(iOS 15.0, *)
@MainActor final class LocalAgentHost {
  private let channel: FlutterMethodChannel
  private let lifeChannel: FlutterMethodChannel
  private let journal: LocalTaskJournal
  private let settings: NativeModelSettings
  private let spaceId: String
  private var closed = false
  private let tools = LocalEventTools()
  private var active: String?
  private var worker: Task<Void, Never>?
  private var model: LocalNativeModel?
  private var approval: CheckedContinuation<Bool, Never>?
  private var approvalID: String?
  private var backgroundObserver: NSObjectProtocol?
  private var expiryObserver: NSObjectProtocol?
  private var cachedConfiguration: NativeModelConfiguration?
  init(messenger: FlutterBinaryMessenger, spaceId: String) throws {
    self.spaceId = spaceId
    settings = NativeModelSettings(spaceId: spaceId)
    let root = try NovaSpaceScope.supportDirectory(spaceId)
    var folder = root.appendingPathComponent("NativeTasks", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
    try folder.setResourceValues(attributes)
    cachedConfiguration = try? settings.read()
    journal = try LocalTaskJournal(file: folder.appendingPathComponent("tasks-v1.json"))
    channel = FlutterMethodChannel(name: "nova/local_agent/v1", binaryMessenger: messenger)
    lifeChannel = FlutterMethodChannel(name: "nova/local_life/v1", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, reply in
      Task { @MainActor in
        guard let self = self else { return }
        do {
          let input = try JSONSerialization.jsonObject(with: Data((call.arguments as? String ?? "{}").utf8)) as? [String: Any] ?? [:]
          let result = try await self.command(call.method, input)
          reply(String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self))
        } catch {
          reply(FlutterError(code: (error as? LocalAgentError)?.code ?? "native_operation_failed", message: nil, details: nil))
        }
      }
    }
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in
        guard let self = self, let id = self.active, !NovaBackgroundExecution.hasExecutionTime() else { return }
        try? self.stop(id, phase: "interrupted", summary: "Nova 已进入后台，任务暂停；请核对结果后重新委托。")
      }
    }
    expiryObserver = NotificationCenter.default.addObserver(forName: NSNotification.Name("NovaAgentExecutionExpired"), object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in
        guard let self = self, let id = self.active else { return }
        try? self.stop(id, phase: "interrupted", summary: "iOS 已结束后台执行；已保存结果，未完成的操作不会自动重试。")
      }
    }
  }
  deinit {
    if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
    if let observer = expiryObserver { NotificationCenter.default.removeObserver(observer) }
  }
  func close() {
    closed = true
    if let id = active { try? stop(id, phase: "interrupted", summary: "Space changed; verify any dispatched action.") }
    worker?.cancel(); model?.cancel(); cachedConfiguration = nil
    channel.setMethodCallHandler(nil)
  }
  private func command(_ method: String, _ input: [String: Any]) async throws -> Any {
    guard !closed, (try? NovaSpaceScope.standaloneID()) == spaceId else { throw LocalAgentError("local_runtime_unavailable") }
    switch method {
    case "capabilities": return ["platform": "ios", "model_runtime": true, "model_configured": try settings.read() != nil,
      "native_tools": ["nova", "calendar", "reminders"], "foreground_only": false, "background_execution": "system_managed"]
    case "apps": return [["package": "nova", "label": "Nova 待办与目标"], ["package": "calendar", "label": "系统日历"], ["package": "reminders", "label": "系统提醒事项"]]
    case "preparePermissions":
      guard UIApplication.shared.applicationState != .background else { return ["deferred": true] }
      let key = "nova.native-permissions-prompted.v1"
      var statuses: [String:String] = [:]
      if !UserDefaults.standard.bool(forKey:key) {
        UserDefaults.standard.set(true,forKey:key)
        for scope in ["calendar","reminders"] {
          do { try await tools.permission(scope); statuses[scope]="available" }
          catch { statuses[scope]=(error as? LocalAgentError)?.code ?? "unavailable" }
        }
      }
      return statuses

    case "query":
      guard let scope = input["scope"] as? String, ["calendar", "reminders"].contains(scope) else { throw LocalAgentError("invalid_native_scope") }
      do {
        try await tools.permission(scope, requestIfNeeded: false)
        return try await tools.observe(scope, input: input)
      } catch {
        return ["scope": scope, "available": false, "error": (error as? LocalAgentError)?.code ?? "native_query_failed"]
      }
    case "tasks": return journal.tasks
    case "modelSettings": return try settings.status()
    case "clearChatGptSettings":
      if let id = active { try stop(id, phase:"cancelled", summary:"ChatGPT account changed; verify any dispatched action.") }
      try settings.clearChatGpt(); cachedConfiguration = try settings.read(); return try settings.status()
    case "saveModelSettings":
      guard active == nil else { throw LocalAgentError("stop_task_before_changing_model") }
      try settings.save(input); cachedConfiguration = try settings.read(); return try settings.status()
    case "run": return try start(input)
    case "stop":
      let id = input["id"] as? String ?? ""
      try stop(id, phase: "cancelled", summary: "用户已停止；已派发的动作可能已生效，请核对结果。")
      return journal.task(id) ?? [:]
    case "approve":
      guard let id = input["id"] as? String, id == active, let proposed = input["proposal_id"] as? String,
        proposed == approvalID, let continuation = approval,
        let pending = journal.task(id)?["proposal"] as? [String: Any], let expires = pending["expires"] as? Double,
        Date().timeIntervalSince1970 < expires else { return ["accepted": false] }
      approval = nil; approvalID = nil
      continuation.resume(returning: input["allow"] as? Bool == true)
      return ["accepted": true]
    case "verify":
      let id = input["id"] as? String ?? ""
      try journal.edit(id) { task in
        guard task["phase"] as? String == "verifying", task["evidence"] != nil else { throw LocalAgentError("task_not_ready_for_verification") }
        task["phase"] = "completed"; task["verified_by"] = "user"; task["verified_at"] = Date().timeIntervalSince1970 * 1000
      }
      return journal.task(id)!
    default: throw LocalAgentError("unsupported_command")
    }
  }
  private func start(_ input: [String: Any]) throws -> [String: Any] {
    if let id = input["id"] as? String, journal.task(id) != nil { return try journal.start(input) }
    guard active == nil, UIApplication.shared.applicationState != .background || NovaBackgroundExecution.hasExecutionTime() else { throw LocalAgentError("foreground_required") }
    let configuration = try cachedConfiguration ?? settings.read()
    guard let config = configuration else { throw LocalAgentError("model_settings_required") }
    let task = try journal.start(input), id = task["id"] as! String, scope = task["target_package"] as! String
    let chat = task["interaction_mode"] as? String == "chat"
    _ = NovaBackgroundExecution.beginLease("native-" + id)
    active = id; let client = LocalNativeModel(config); model = client
    worker = Task { [weak self] in
      guard let self = self else { return }
      do {
        if scope != "nova" { try await tools.permission(scope, requestIfNeeded: !chat) }
        try check(id)
        for _ in 0..<30 {
          let observation = try await observe(scope)
          try check(id)
          let decision = try await client.decide(task: journal.task(id)!, observation: observation, schema: schema(scope))
          try check(id)
          let summary = decision["summary"] as! String
          switch decision["kind"] as! String {
          case "complete":
            let evidence = try await observe(scope); try check(id)
            try journal.edit(id) { $0["evidence"] = evidence }
            if chat { try journal.edit(id) { $0["completed_by"] = "agent" } }
            try journal.end(id, phase: chat ? "completed" : "verifying", summary: summary); end(id); return
          case "wait": try stop(id, phase: "interrupted", summary: summary); return
          default:
            let action = decision["action"] as! [String: Any]
            try await validate(action, scope: scope); try check(id)
            let operation: String
            if chat {
              try check(id)
              operation = try journal.chatIntent(id, action: action, summary: summary)
            } else {
              let proposal = try journal.propose(id, action: action, summary: summary, now: Date().timeIntervalSince1970)
              let allow = await waitApproval(id, proposal: proposal)
              try check(id)
              guard allow else { try stop(id, phase: "interrupted", summary: "操作未获批准。请调整任务后重新委托。"); return }
              try await validate(action, scope: scope); try check(id)
              operation = try journal.consume(id, proposal: proposal, now: Date().timeIntervalSince1970)
            }
            // No suspension between final authority check and EventKit dispatch.
            let result: [String: Any]
            if scope == "nova" {
              result = try await life("mutate", ["input": action["input"]!, "operation_id": operation])
            } else { result = try tools.execute(action, scope: scope) }
            try journal.receipt(id, operation: operation, result: result)
            NovaBackgroundExecution.progressLease("native-" + id, units: Int64((journal.task(id)?["operations"] as? [Any])?.count ?? 0), phase: "device_run_task")
            try check(id)
          }
        }
        try stop(id, phase: "interrupted", summary: "达到本次操作上限，请核对进展。")
      } catch {
        if active == id {
          let code = (error as? LocalAgentError)?.code ?? "native_or_model_failed"
          try? stop(id, phase: "interrupted", summary: "执行暂停（\(code)）。请核对结果；不会自动重复操作。")
        }
      }
    }
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 300_000_000_000)
      guard let self = self, self.active == id else { return }
      try? self.stop(id, phase: "interrupted", summary: "达到 5 分钟执行上限，请核对进展。")
    }
    return task
  }
  private func check(_ id: String) throws {
    try Task.checkCancellation()
    guard active == id, UIApplication.shared.applicationState != .background || NovaBackgroundExecution.hasExecutionTime() else { throw LocalAgentError("task_stopped") }
  }
  private func end(_ id: String) {
    guard active == id else { return }
    NovaBackgroundExecution.endLease("native-" + id, success: journal.task(id)?["phase"] as? String == "completed")
    active = nil; worker?.cancel(); worker = nil; model?.cancel(); model = nil
    approval?.resume(returning: false); approval = nil; approvalID = nil
  }
  private func stop(_ id: String, phase: String, summary: String) throws {
    end(id); try journal.end(id, phase: phase, summary: summary)
  }
  private func waitApproval(_ id: String, proposal: String) async -> Bool {
    await withCheckedContinuation { continuation in
      approval = continuation; approvalID = proposal
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: 90_000_000_000)
        guard let self = self, self.active == id, self.approvalID == proposal else { return }
        self.approval?.resume(returning: false); self.approval = nil; self.approvalID = nil
      }
    }
  }
  private func life(_ method: String, _ args: [String: Any] = [:]) async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
      lifeChannel.invokeMethod(method, arguments: args) { result in
        if let value = result as? [String: Any] { continuation.resume(returning: value) }
        else { continuation.resume(throwing: LocalAgentError("life_tool_unavailable_or_conflict")) }
      }
    }
  }
  private func observe(_ scope: String) async throws -> [String: Any] {
    if scope == "nova" { return try await life("snapshot") }
    return try await tools.observe(scope)
  }
  private func validate(_ action: [String: Any], scope: String) async throws {
    if scope == "nova" {
      guard Set(action.keys) == ["tool", "input"], action["tool"] as? String == "nova", action["input"] is [String: Any] else { throw LocalAgentError("invalid_life_action") }
      _ = try await life("validate", ["input": action["input"]!])
    } else { try tools.validate(action, scope: scope) }
  }
  private func schema(_ scope: String) -> [String: Any] {
    let detail = scope == "nova"
      ? "Nova input: op create or update; kind todo or goal; title, note, importance normal/high, todo due YYYY-MM-DD or goal_id, goal success_criteria. Update requires observed id and integer expected_version; status todo open/doing/waiting/done/cancelled or goal active/paused/completed/archived."
      : "Native input: op create or update; title, note. Create requires observed calendar_id. Update requires observed id and string expected_version; cannot move calendar or edit recurring/shared attendee events. Calendar create requires ISO8601 start and end with timezone. Reminders supports ISO8601 due and boolean completed."
    return ["type": "object", "additionalProperties": false, "required": ["kind", "summary"], "properties": [
      "kind": ["type": "string", "enum": ["action", "complete", "wait"]], "summary": ["type": "string"],
      "action": ["type": "object", "additionalProperties": false, "required": ["tool", "input"], "properties": [
        "tool": ["type": "string", "enum": [scope]], "input": ["type": "object", "description": detail]]]]]
  }
}
