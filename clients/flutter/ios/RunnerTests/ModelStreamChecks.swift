import Foundation
@main struct ModelStreamChecks {
 static func main() throws {
  var events = [[String:Any]]()
  let stream = ModelStreamParser { events.append($0) }
  let text = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"x\",\"function\":{\"name\":\"artifact_write\",\"arguments\":\"{}\"}}]}}]}\n\ndata: [DONE]\n\n"
  for byte in Data(text.utf8) { try stream.append(Data([byte])) }
  assert(stream.finished); assert(events.count == 2)
  assert(events.first?["content"] as? String == "你好")
  let response = stream.response()
  let message = (response["choices"] as! [[String:Any]])[0]["message"] as! [String:Any]
  assert(message["content"] as? String == "你好")
  assert((message["tool_calls"] as! [[String:Any]])[0]["id"] as? String == "x")
  let truncated = ModelStreamParser { _ in }
  do { try truncated.append(Data("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n".utf8)); fatalError("truncation accepted") } catch let error as LocalAgentError { assert(error.code == "model_output_limit") }
  var responseEvents = [[String:Any]]()
  let responses = ModelStreamParser(responses: true) { responseEvents.append($0) }
  for event: [String:Any] in [
    ["type":"response.output_text.delta","delta":"hello"],
    ["type":"response.output_item.done","item":["type":"reasoning","id":"r","encrypted_content":"opaque","summary":[]]],
    ["type":"response.output_item.done","item":["type":"function_call","id":"f","call_id":"call","name":"lookup","arguments":"{}"]],
    ["type":"response.completed","response":["status":"completed"]]
  ] {
    let json = String(data:try JSONSerialization.data(withJSONObject:event),encoding:.utf8)!
    for byte in Data("data: \(json)\n\n".utf8) { try responses.append(Data([byte])) }
  }
  assert(responses.finished)
  let responseMessage = (responses.response()["choices"] as! [[String:Any]])[0]["message"] as! [String:Any]
  assert(responseMessage["content"] as? String == "hello")
  assert((responseMessage["_nova_response_items"] as! [[String:Any]]).count == 2)
  assert((responseMessage["tool_calls"] as! [[String:Any]])[0]["id"] as? String == "call")
  let incompleteResponses = ModelStreamParser(responses:true) { _ in }
  do { try incompleteResponses.append(Data("data: [DONE]\n\n".utf8)); fatalError("premature done accepted") } catch { }
  print("Model stream: split UTF8, incremental text/tools, final response and truncation passed")
 }
}
