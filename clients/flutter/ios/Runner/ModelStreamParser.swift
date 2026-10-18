import Foundation

/// Incremental UTF-8/SSE parsing; transport framing has its own bounded budget.
final class ModelStreamParser {
  private var buffer = Data(), lines = [String]()
  private var wireBytes = 0, outputBytes = 0
  private var content = "", tools = [Int: [String: Any]]()
  private let responses: Bool
  private var responseItems = [[String:Any]]()
  private let emit: ([String: Any]) -> Void
  private(set) var finished = false
  init(responses: Bool = false, emit: @escaping ([String: Any]) -> Void) { self.responses = responses; self.emit = emit }
  func append(_ bytes: Data) throws {
    wireBytes += bytes.count
    guard wireBytes <= 16 * 1024 * 1024 else { throw LocalAgentError("model_response_too_large") }
    if finished { return }
    buffer.append(bytes)
    while let index = buffer.firstIndex(of: 10) {
      var lineData = buffer[..<index]; buffer.removeSubrange(...index)
      if lineData.last == 13 { lineData = lineData.dropLast() }
      guard let line = String(data: lineData, encoding: .utf8) else { throw LocalAgentError("invalid_model_response") }
      if line.isEmpty { try event() }
      else if line.hasPrefix("data:") { var value = String(line.dropFirst(5)); if value.hasPrefix(" ") { value.removeFirst() }; lines.append(value) }
    }
    guard buffer.count <= 1024 * 1024 else { throw LocalAgentError("model_response_too_large") }
  }
  private func event() throws {
    guard !lines.isEmpty else { return }
    let text = lines.joined(separator: "\n"); lines.removeAll(keepingCapacity: true)
    if text == "[DONE]" { guard !responses || finished else { throw LocalAgentError("model_stream_interrupted") }; finished = true; return }
    guard let root = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], root["error"] == nil else { throw LocalAgentError("invalid_model_response") }
    if responses { try responseEvent(root); return }
    guard let choices = root["choices"] as? [[String:Any]] else { throw LocalAgentError("invalid_model_response") }
    if choices.isEmpty { return }
    guard choices.count == 1 else { throw LocalAgentError("invalid_model_response") }
    if choices[0]["finish_reason"] as? String == "length" { throw LocalAgentError("model_output_limit") }
    let delta = choices[0]["delta"] as? [String: Any] ?? [:]
    if let value = delta["content"] as? String { content += value; outputBytes += value.utf8.count }
    for fragment in delta["tool_calls"] as? [[String: Any]] ?? [] {
      guard let index = fragment["index"] as? Int, (0..<8).contains(index) else { throw LocalAgentError("invalid_tool_calls") }
      var tool = tools[index] ?? ["id":"", "type":"function", "function":["name":"", "arguments":""]]
      if let id = fragment["id"] as? String { tool["id"] = (tool["id"] as? String ?? "") + id }
      var function = tool["function"] as! [String: String]
      if let part = fragment["function"] as? [String: Any] {
        for key in ["name", "arguments"] { if let value = part[key] as? String { function[key, default:""] += value; outputBytes += value.utf8.count } }
      }
      tool["function"] = function; tools[index] = tool
    }
    guard outputBytes <= 512 * 1024 else { throw LocalAgentError("model_response_too_large") }
    if !delta.isEmpty { emit(delta) }
  }
  private func responseEvent(_ root: [String:Any]) throws {
    switch root["type"] as? String {
    case "response.output_text.delta":
      guard let text = root["delta"] as? String else { throw LocalAgentError("invalid_model_response") }
      content += text; outputBytes += text.utf8.count; emit(["content":text])
    case "response.output_item.done":
      guard let item = root["item"] as? [String:Any], let type = item["type"] as? String,
        ["message","function_call","reasoning"].contains(type) else { throw LocalAgentError("unsupported_model_output") }
      responseItems.append(item); outputBytes += try JSONSerialization.data(withJSONObject:item).count
      if type == "function_call" {
        guard let id = item["call_id"] as? String, !id.isEmpty, let name = item["name"] as? String,
          let arguments = item["arguments"] as? String, tools.count < 8 else { throw LocalAgentError("invalid_tool_calls") }
        let index = tools.count
        let call: [String:Any] = ["id":id,"type":"function","function":["name":name,"arguments":arguments]]
        tools[index] = call
        var delta = call; delta["index"] = index; emit(["tool_calls":[delta]])
      }
    case "response.completed":
      guard let response = root["response"] as? [String:Any], response["status"] == nil || response["status"] as? String == "completed" else { throw LocalAgentError("model_stream_interrupted") }
      finished = true
    case "response.failed", "response.incomplete", "error":
      let response = root["response"] as? [String:Any]
      let error = (response?["error"] ?? root["error"]) as? [String:Any]
      throw LocalAgentError(error?["code"] as? String ?? "model_response_failed")
    default: break
    }
    guard outputBytes <= 512 * 1024 else { throw LocalAgentError("model_response_too_large") }
  }
  func response() -> [String: Any] {
    var message: [String: Any] = ["content":content]
    if responses { message["_nova_response_items"] = responseItems }
    if !tools.isEmpty { message["tool_calls"] = tools.keys.sorted().map { tools[$0]! } }
    return ["choices":[["finish_reason":tools.isEmpty ? "stop" : "tool_calls", "message":message]], "_nova_streamed":true]
  }
}
