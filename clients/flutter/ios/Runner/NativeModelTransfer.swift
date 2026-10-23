import Flutter
import Foundation
import UIKit

/// File-backed background POSTs survive Flutter suspension; no Live Activity.
final class NativeModelTransfer: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  static let shared = NativeModelTransfer()
  static let sessionID = "com.nova.novaMobile.model-transfer.v1"
  private final class Pending {
    let id: String
    let spaceId: String?
    var data = Data()
    var failure: String?
    var parser: ModelStreamParser?
    var responses = false
    var deltas = [[String: Any]]()
    var flushScheduled = false
    var completion: ((Result<[String: Any], Error>) -> Void)?
    init(id: String, spaceId: String?, completion: ((Result<[String: Any], Error>) -> Void)? = nil) { self.id = id; self.spaceId = spaceId; self.completion = completion }
  }
  private var pending: [Int: Pending] = [:]
  private var tasks: [String: URLSessionTask] = [:]
  private var channel: FlutterMethodChannel?
  private var wakeCompletion: (() -> Void)?
  private var scopeObserver: NSObjectProtocol?
  override init() {
    super.init()
    scopeObserver = NotificationCenter.default.addObserver(forName: NovaSpaceScope.changed, object: nil, queue: .main) { [weak self] _ in
      self?.tasks.values.forEach { $0.cancel() }
    }
  }
  deinit { if let observer = scopeObserver { NotificationCenter.default.removeObserver(observer) } }
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: Self.sessionID)
    config.isDiscretionary = false; config.sessionSendsLaunchEvents = true
    config.waitsForConnectivity = true
    config.timeoutIntervalForRequest = 180; config.timeoutIntervalForResource = 600
    config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
    return URLSession(configuration: config, delegate: self, delegateQueue: .main)
  }()
  private func folder(spaceId: String) throws -> URL {
    let root = try NovaSpaceScope.supportDirectory(spaceId)
    var folder = root.appendingPathComponent("ModelTransfers", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var attrs = URLResourceValues(); attrs.isExcludedFromBackup = true; try folder.setResourceValues(attrs)
    return folder
  }
  func install(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "nova/model_transfer/v1", binaryMessenger: messenger)
    channel?.setMethodCallHandler { [weak self] call, reply in
      guard let self, let input = call.arguments as? [String: Any], let id = input["id"] as? String, UUID(uuidString: id) != nil else { reply(FlutterError(code: "invalid_model_request", message: nil, details: nil)); return }
      if call.method == "cancel" { self.cancel(id); reply(nil); return }
      guard call.method == "request", let raw = input["configuration"] as? [String: Any], let body = input["body"] as? [String: Any],
        let endpoint = raw["endpoint"] as? String, let model = raw["model"] as? String, let key = raw["key"] as? String else { reply(FlutterMethodNotImplemented); return }
      let configuration = NativeModelConfiguration(endpoint: endpoint, model: model, key: key, apiProtocol:raw["protocol"] as? String)
      self.request(id: id, configuration: configuration, body: body) { result in
        switch result {
        case .success(let value): reply(value)
        case .failure(let error): reply(FlutterError(code: (error as? LocalAgentError)?.code ?? "model_request_failed", message: nil, details: nil))
        }
      }
    }
    _ = session
  }
  func handleEvents(identifier: String, completion: @escaping () -> Void) {
    guard identifier == Self.sessionID else { completion(); return }
    wakeCompletion = completion; _ = session
  }
  func request(id: String, configuration: NativeModelConfiguration, body: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
    do {
      let spaceId = try NovaSpaceScope.standaloneID()
      try configuration.validate()
      guard UUID(uuidString: id) != nil, tasks[id] == nil else { throw LocalAgentError("invalid_model_request") }
      let payload = try JSONSerialization.data(withJSONObject: body)
      guard payload.count <= 2 * 1024 * 1024 else { throw LocalAgentError("model_context_too_large") }
      let file = try folder(spaceId: spaceId).appendingPathComponent(id + ".request")
      try payload.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var request = URLRequest(url: configuration.requestURL)
      request.httpMethod = "POST"; request.setValue("Bearer \(configuration.key)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue(body["stream"] as? Bool == true ? "text/event-stream" : "application/json", forHTTPHeaderField: "Accept")
      let task = session.uploadTask(with: request, fromFile: file); task.taskDescription = "scope=" + spaceId + "/" + id + (configuration.isResponses ? "/responses" : "") + (body["stream"] as? Bool == true ? "/stream" : "")
      let value = Pending(id: id, spaceId: spaceId, completion: completion)
      value.responses = configuration.isResponses
      if body["stream"] as? Bool == true { value.parser = parser(for: value) }
      pending[task.taskIdentifier] = value; tasks[id] = task
      NovaBackgroundExecution.modelTransferStarted(id); task.resume()
    } catch { completion(.failure(error)) }
  }
  func cancel(_ id: String) { tasks[id]?.cancel() }
  private func entry(_ task: URLSessionTask) -> Pending {
    if let value = pending[task.taskIdentifier] { return value }
    let parts = task.taskDescription?.components(separatedBy:"/") ?? []
    let scoped = parts.first?.hasPrefix("scope=") == true
    let spaceId = scoped ? String(parts[0].dropFirst(6)) : nil
    let raw = scoped && parts.count > 1 ? parts[1] : nil
    let id = raw.flatMap { UUID(uuidString: $0) == nil ? nil : $0 } ?? UUID().uuidString
    let value = Pending(id: id, spaceId: spaceId)
    if spaceId == nil || spaceId != (try? NovaSpaceScope.standaloneID()) { task.cancel() }
    value.responses = task.taskDescription?.contains("/responses") == true
    if task.taskDescription?.hasSuffix("/stream") == true { value.parser = parser(for: value) }; pending[task.taskIdentifier] = value; return value
  }
  private func parser(for value: Pending) -> ModelStreamParser {
    ModelStreamParser(responses:value.responses) { [weak self, weak value] delta in
      guard let self, let value else { return }
      value.deltas.append(delta)
      guard !value.flushScheduled else { return }; value.flushScheduled = true
      DispatchQueue.main.asyncAfter(deadline:.now()+0.05) { [weak self, weak value] in
        if let value { self?.flush(value) }
      }
    }
  }
  private func flush(_ value: Pending) {
    value.flushScheduled = false
    guard value.spaceId == (try? NovaSpaceScope.standaloneID()), !value.deltas.isEmpty else { value.deltas.removeAll(); return }
    let deltas = value.deltas; value.deltas.removeAll(keepingCapacity:true)
    channel?.invokeMethod("deltas", arguments:["id":value.id,"deltas":deltas])
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let value = entry(dataTask)
    if let parser = value.parser, dataTask.response?.mimeType == "text/event-stream" {
      do { try parser.append(data) }
      catch { value.failure = (error as? LocalAgentError)?.code ?? "invalid_model_response"; dataTask.cancel() }
      return
    }
    guard value.data.count + data.count <= 2 * 1024 * 1024 else { value.failure = "model_response_too_large"; dataTask.cancel(); return }
    value.data.append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let value = entry(task)
    pending.removeValue(forKey: task.taskIdentifier); tasks.removeValue(forKey: value.id)
    defer {
      if let id = value.spaceId, let file = try? folder(spaceId: id).appendingPathComponent(value.id + ".request") { try? FileManager.default.removeItem(at: file) }
    }
    NovaBackgroundExecution.modelTransferFinished(value.id)
    let result: Result<[String: Any], Error>
    do {
      guard value.spaceId != nil, value.spaceId == (try? NovaSpaceScope.standaloneID()) else { throw LocalAgentError("space_changed") }
      if let failure = value.failure { throw LocalAgentError(failure) }
      if let error = error as NSError? {
        switch error.code {
        case NSURLErrorTimedOut: throw LocalAgentError("model_timeout")
        case NSURLErrorCancelled: throw LocalAgentError("cancelled")
        case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: throw LocalAgentError("network_unavailable")
        default: throw LocalAgentError("model_request_failed")
        }
      }
      guard let http = task.response as? HTTPURLResponse else { throw LocalAgentError("model_request_failed") }
      guard http.statusCode == 200 else { throw LocalAgentError("model_http_\(http.statusCode)") }
      if let parser = value.parser, task.response?.mimeType == "text/event-stream" {
        guard parser.finished else { throw LocalAgentError("model_stream_interrupted") }
        flush(value); result = .success(parser.response())
      } else {
      guard let object = try JSONSerialization.jsonObject(with: value.data) as? [String: Any], (object["error"] == nil || object["error"] is NSNull) else { throw LocalAgentError("invalid_model_response") }
      result = .success(object)
      }
    } catch { result = .failure((error as? LocalAgentError) ?? LocalAgentError("invalid_model_response")) }
    if let completion = value.completion { completion(result) }
    else {
      // A terminated Flutter turn is never auto-replayed. Retain the completed
      // response privately for recovery/inspection, without credentials.
      let object: [String: Any]
      switch result { case .success(let output): object = ["response":output]; case .failure(let error): object = ["error":(error as? LocalAgentError)?.code ?? "model_request_failed"] }
      if let id = value.spaceId, let file = try? folder(spaceId: id).appendingPathComponent(value.id + ".result"), let bytes = try? JSONSerialization.data(withJSONObject: object) {
        try? bytes.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let completion = wakeCompletion; wakeCompletion = nil; completion?()
  }
}
