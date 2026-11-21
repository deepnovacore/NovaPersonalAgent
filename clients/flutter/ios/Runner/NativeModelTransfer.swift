import Flutter
import Foundation
import UIKit

/// File-backed background POSTs survive Flutter suspension; no Live Activity.
/// Background sessions deliver bytes in batches through nsurlsessiond, so a
/// streaming request started while the app is active runs on an ephemeral
/// session for live deltas. If iOS ends the app's background time before the
/// stream finishes, the same request file is relayed to the background session.
final class NativeModelTransfer: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  static let shared = NativeModelTransfer()
  static let sessionID = "com.nova.novaMobile.model-transfer.v1"
  private final class Pending {
    let id: String
    let spaceId: String?
    let token: String?
    let authorityGeneration: String?
    var fileID: String { token.map { id + "." + $0 } ?? id }
    var terminal = false
    var cancelled = false
    var data = Data()
    var failure: String?
    var parser: ModelStreamParser?
    var responses = false
    var deltas = [[String: Any]]()
    var flushScheduled = false
    /// Relayed requests restart on the background session; their deltas would
    /// repeat what Flutter already showed, so only the final response is sent.
    var quiet = false
    var request: URLRequest?
    var file: URL?
    var taskDescription: String?
    var backgroundTask = UIBackgroundTaskIdentifier.invalid
    var completion: ((Result<[String: Any], Error>) -> Void)?
    init(id: String, spaceId: String?, token: String? = nil, authorityGeneration: String? = nil, completion: ((Result<[String: Any], Error>) -> Void)? = nil) { self.id = id; self.spaceId = spaceId; self.token = token; self.authorityGeneration = authorityGeneration; self.completion = completion }
  }
  private var pending: [String: Pending] = [:]
  /// Foreground tasks cancelled by a relay; their callbacks are ignored.
  private var relayed = Set<String>()
  private var tasks: [String: URLSessionTask] = [:]
  private struct Reservation {
    let token: String, storageKey: String, authorityGeneration: String, generation: UUID
    let expires: TimeInterval
  }
  private enum Revocation: Hashable {
    case file(spaceId: String, fileID: String)
    case space(String)
  }
  static let reservationLimit = 128
  static let reservationLifetime: TimeInterval = 60
  private var reservations: [String: Reservation] = [:]
  private var generation = UUID()
  // Only failed disk revocations remain here. They block new admissions until
  // cleanup succeeds; they are never evicted to make room for fresh requests.
  private var revocations = Set<Revocation>()
  private let clock: () -> TimeInterval
  private let sessionIdentifier: String
  private var authorityStore: ModelTransferAuthority?
  private var channel: FlutterMethodChannel?
  private var wakeCompletion: (() -> Void)?
  private var scopeObserver: NSObjectProtocol?
  init(clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }, sessionIdentifier: String = NativeModelTransfer.sessionID) {
    self.clock = clock; self.sessionIdentifier = sessionIdentifier
    super.init()
    scopeObserver = NotificationCenter.default.addObserver(forName: NovaSpaceScope.changed, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.reservations.removeAll(); self.generation = UUID()
      for value in self.pending.values where !self.sameSpace(value.spaceId, try? NovaSpaceScope.standaloneID()) { self.cancel(value.id) }
      self.session.getAllTasks { tasks in
        DispatchQueue.main.async {
          for task in tasks where task.state != .completed {
            let value = self.entry(task)
            if !self.sameSpace(value.spaceId, try? NovaSpaceScope.standaloneID()) { self.cancelTask(task, value) }
          }
        }
      }
    }
  }
  deinit { if let observer = scopeObserver { NotificationCenter.default.removeObserver(observer) } }
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
    config.isDiscretionary = false; config.sessionSendsLaunchEvents = true
    config.waitsForConnectivity = true
    config.timeoutIntervalForRequest = 180; config.timeoutIntervalForResource = 600
    config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
    return URLSession(configuration: config, delegate: self, delegateQueue: .main)
  }()
  private lazy var foregroundSession: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    config.timeoutIntervalForRequest = 180; config.timeoutIntervalForResource = 600
    config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
    return URLSession(configuration: config, delegate: self, delegateQueue: .main)
  }()
  static let foregroundMarker = "/foreground"
  /// Task identifiers are only unique within one session.
  static func taskKey(description: String?, identifier: Int) -> String {
    (description?.hasSuffix(foregroundMarker) == true ? "f" : "b") + String(identifier)
  }
  static func streams(_ description: String?) -> Bool {
    description?.components(separatedBy: "/").contains("stream") == true
  }
  /// A relayed generation must also replace reasoning shown by the discarded one,
  /// so its final message always carries `reasoning_content`.
  static func replacingReasoning(_ response: [String: Any]) -> [String: Any] {
    guard var choices = response["choices"] as? [[String: Any]], var message = choices.first?["message"] as? [String: Any] else { return response }
    if !(message["reasoning_content"] is String) { message["reasoning_content"] = "" }
    choices[0]["message"] = message
    var copy = response; copy["choices"] = choices; return copy
  }
  private func key(_ task: URLSessionTask) -> String { Self.taskKey(description: task.taskDescription, identifier: task.taskIdentifier) }
  private func authority() throws -> ModelTransferAuthority {
    if let authorityStore { return authorityStore }
    let store = ModelTransferAuthority(controlDirectory: try NovaSpaceScope.modelTransferControlDirectory())
    authorityStore = store; return store
  }
  private func storageKey(_ spaceId: String) throws -> String { try authority().storageKey(NovaSpaceScope.supportPath(spaceId)) }
  private func sameSpace(_ left: String?, _ right: String?) -> Bool {
    guard let left, let right, let a = try? storageKey(left), let b = try? storageKey(right) else { return false }
    return a == b
  }
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
      guard let self else { reply(FlutterError(code: "model_request_failed", message: nil, details: nil)); return }
      guard let input = call.arguments as? [String: Any], let id = input["id"] as? String, UUID(uuidString: id) != nil else { reply(FlutterError(code: "invalid_model_request", message: nil, details: nil)); return }
      if call.method == "reserve" {
        do { reply(try self.reserve(id: id)) }
        catch { reply(FlutterError(code: (error as? LocalAgentError)?.code ?? "model_request_failed", message: nil, details: nil)) }
        return
      }
      guard let token = input["reservation"] as? String, UUID(uuidString: token) != nil else { reply(FlutterError(code: "invalid_model_request", message: nil, details: nil)); return }
      if call.method == "cancel" {
        if self.cancel(id, reservation: token) { reply(nil) }
        else { reply(FlutterError(code: "model_cleanup_pending", message: nil, details: nil)) }
        return
      }
      guard call.method == "request", let raw = input["configuration"] as? [String: Any], let body = input["body"] as? [String: Any],
        let endpoint = raw["endpoint"] as? String, let model = raw["model"] as? String, let key = raw["key"] as? String else { reply(FlutterMethodNotImplemented); return }
      let configuration = NativeModelConfiguration(endpoint: endpoint, model: model, key: key, apiProtocol:raw["protocol"] as? String)
      self.request(id: id, reservation: token, configuration: configuration, body: body) { result in
        switch result {
        case .success(let value): reply(value)
        case .failure(let error): reply(FlutterError(code: (error as? LocalAgentError)?.code ?? "model_request_failed", message: nil, details: nil))
        }
      }
    }
    _ = session
    if let id = try? NovaSpaceScope.standaloneID() { reconcile(spaceId: id) }
  }
  func handleEvents(identifier: String, completion: @escaping () -> Void) {
    guard identifier == Self.sessionID else { completion(); return }
    wakeCompletion = completion; _ = session
  }
  /// Admission contains no body and starts no transfer. Unknown, expired or
  /// revoked nonces can never become fresh requests, even after ID reuse.
  func reserve(id: String) throws -> String {
    dispatchPrecondition(condition: .onQueue(.main))
    let spaceId = try NovaSpaceScope.standaloneID()
    try retryCleanup()
    let directory = try NovaSpaceScope.supportDirectory(spaceId)
    let epoch = try authority().snapshot(directory).generation
    let key = try storageKey(spaceId)
    let now = clock()
    reservations = reservations.filter { $0.value.expires > now }
    guard UUID(uuidString: id) != nil, tasks[id] == nil, reservations[id] == nil else { throw LocalAgentError("invalid_model_request") }
    guard reservations.count < Self.reservationLimit else { throw LocalAgentError("model_admission_full") }
    let token = UUID().uuidString
    reservations[id] = Reservation(token: token, storageKey: key, authorityGeneration: epoch, generation: generation, expires: now + Self.reservationLifetime)
    return token
  }
  func request(id: String, reservation token: String, configuration: NativeModelConfiguration, body: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { self.request(id: id, reservation: token, configuration: configuration, body: body, completion: completion) }; return
    }
    var admittedSpace: String?
    do {
      let spaceId = try NovaSpaceScope.standaloneID()
      guard let admission = reservations[id], admission.token == token else { throw LocalAgentError("cancelled") }
      reservations.removeValue(forKey: id)
      guard admission.expires > clock(), admission.storageKey == (try storageKey(spaceId)), admission.generation == generation else { throw LocalAgentError("cancelled") }
      try retryCleanup()
      try configuration.validate()
      guard UUID(uuidString: id) != nil, tasks[id] == nil else { throw LocalAgentError("invalid_model_request") }
      let payload = try JSONSerialization.data(withJSONObject: body)
      guard payload.count <= 2 * 1024 * 1024 else { throw LocalAgentError("model_context_too_large") }
      let files = ModelTransferFiles(directory: try folder(spaceId: spaceId))
      try files.purgeResults()
      let epoch = try authority().authorize(NovaSpaceScope.supportPath(spaceId), id: id, token: token, expectedGeneration: admission.authorityGeneration)
      admittedSpace = spaceId
      let file = files.request(id + "." + token)
      try payload.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var request = URLRequest(url: configuration.requestURL)
      request.httpMethod = "POST"; request.setValue("Bearer \(configuration.key)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue(body["stream"] as? Bool == true ? "text/event-stream" : "application/json", forHTTPHeaderField: "Accept")
      let streaming = body["stream"] as? Bool == true
      let description = "scope=" + spaceId + "/" + id + "/token=" + token + "/authority=" + epoch + (configuration.isResponses ? "/responses" : "") + (streaming ? "/stream" : "")
      let value = Pending(id: id, spaceId: spaceId, token: token, authorityGeneration: epoch, completion: completion)
      value.responses = configuration.isResponses
      if streaming { value.parser = parser(for: value) }
      var foreground = false
      if streaming && UIApplication.shared.applicationState == .active {
        value.request = request; value.file = file; value.taskDescription = description
        // Strong capture: the handler must always end this background task.
        value.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Nova model stream") { [weak self] in
          if let self { self.relay(value) } else { UIApplication.shared.endBackgroundTask(value.backgroundTask) }
        }
        // Without an assertion there is no relay point, so start on the background session.
        foreground = value.backgroundTask != .invalid
      }
      let task = (foreground ? foregroundSession : session).uploadTask(with: request, fromFile: file)
      task.taskDescription = description + (foreground ? Self.foregroundMarker : "")
      pending[key(task)] = value; tasks[id] = task
      NovaBackgroundExecution.modelTransferStarted(value.fileID); task.resume()
    } catch {
      if let spaceId = admittedSpace { try? revoke(.file(spaceId: spaceId, fileID: id + "." + token)) }
      completion(.failure(error))
    }
  }
  /// Called by the expiration handler just before iOS suspends the app.
  private func relay(_ value: Pending) {
    defer { endBackgroundTask(value) }
    guard let current = tasks[value.id], pending[key(current)] === value, !value.terminal, !value.cancelled,
      let request = value.request, let file = value.file, let description = value.taskDescription else { return }
    // A revoked or switched Space must never send the request a second time.
    guard owns(value), sameSpace(value.spaceId, try? NovaSpaceScope.standaloneID()) else { cancelTask(current, value); return }
    // The terminal SSE event already arrived: finish now instead of paying twice.
    if let parser = value.parser, parser.finished {
      flush(value); NovaBackgroundExecution.modelTransferFinished(value.fileID)
      let response = parser.response()
      relayed.insert(key(current)); current.cancel()
      finish(value, current, .success(response)); return
    }
    let next = Pending(id: value.id, spaceId: value.spaceId, token: value.token, authorityGeneration: value.authorityGeneration, completion: value.completion)
    value.completion = nil
    next.responses = value.responses; next.quiet = true
    if value.parser != nil { next.parser = parser(for: next) }
    let task = session.uploadTask(with: request, fromFile: file); task.taskDescription = description
    pending.removeValue(forKey: key(current)); relayed.insert(key(current))
    pending[key(task)] = next; tasks[value.id] = task
    current.cancel(); task.resume()
  }
  private func endBackgroundTask(_ value: Pending) {
    guard value.backgroundTask != .invalid else { return }
    let task = value.backgroundTask; value.backgroundTask = .invalid
    UIApplication.shared.endBackgroundTask(task)
  }
  private func files(_ spaceId: String) throws -> ModelTransferFiles {
    // Cleanup must never create a removed Space or transfer directory.
    ModelTransferFiles(directory: try NovaSpaceScope.supportPath(spaceId).appendingPathComponent("ModelTransfers", isDirectory: true))
  }
  private func revoke(_ revocation: Revocation) throws {
    revocations.insert(revocation)
    switch revocation {
    case .file(let spaceId, let fileID):
      let parts = fileID.components(separatedBy: ".")
      try authority().revoke(NovaSpaceScope.supportPath(spaceId), id: parts[0], token: parts.count == 2 ? parts[1] : nil)
      try files(spaceId).remove(fileID)
    case .space(let spaceId):
      try authority().invalidate(NovaSpaceScope.supportPath(spaceId))
      try files(spaceId).invalidate()
    }
    revocations.remove(revocation)
  }
  private func retire(_ taskKey: String, _ value: Pending) throws {
    guard value.terminal else { return }
    if let spaceId = value.spaceId { try revoke(.file(spaceId: spaceId, fileID: value.fileID)) }
    pending.removeValue(forKey: taskKey)
    if tasks[value.id].map(key) == taskKey { tasks.removeValue(forKey: value.id) }
  }
  private func retryCleanup() throws {
    for revocation in revocations { try? revoke(revocation) }
    for (taskKey, value) in pending where value.terminal { try? retire(taskKey, value) }
    guard revocations.isEmpty, !pending.values.contains(where: { $0.terminal }) else { throw LocalAgentError("model_cleanup_pending") }
  }
  @discardableResult func cancel(_ id: String, reservation token: String? = nil) -> Bool {
    guard Thread.isMainThread else { DispatchQueue.main.async { self.cancel(id, reservation: token) }; return false }
    let reserved = reservations[id] != nil && (token == nil || reservations[id]?.token == token)
    if reserved { reservations.removeValue(forKey: id) }
    if reserved && tasks[id] == nil { return true }
    if let task = tasks[id], let value = pending[key(task)], token == nil || value.token == token {
      return cancelTask(task, value)
    }
    // Revoke the exact restored incarnation before its delegate is recovered.
    // No tombstone is needed: a delayed request requires a live reservation,
    // and a restored callback requires this incarnation's request file.
    var revoked = false
    if let spaceId = try? NovaSpaceScope.standaloneID() {
      let file = Revocation.file(spaceId: spaceId, fileID: token.map { id + "." + $0 } ?? id)
      do { try revoke(file); revoked = true }
      catch {
        // An inaccessible directory cannot prove that an unknown incarnation
        // is absent. Coalesce such failures into a stronger Space-wide gate,
        // rather than retaining arbitrary cancel-before-restoration UUIDs.
        revocations.insert(.space(spaceId)); revocations.remove(file)
      }
    }
    session.getAllTasks { all in
      DispatchQueue.main.async {
        for task in all where task.state != .completed && task.taskDescription?.components(separatedBy: "/").dropFirst().first == id {
          let value = self.entry(task)
          if token == nil || value.token == token { self.cancelTask(task, value) }
        }
      }
    }
    return revoked
  }
  @discardableResult private func cancelTask(_ task: URLSessionTask, _ value: Pending) -> Bool {
    value.cancelled = true; value.data.removeAll(); value.deltas.removeAll(); value.parser = nil
    endBackgroundTask(value)
    var revoked = true
    if let spaceId = value.spaceId {
      do { try revoke(.file(spaceId: spaceId, fileID: value.fileID)) }
      catch { revoked = false }
    }
    task.cancel()
    let completion = value.completion; value.completion = nil
    completion?(.failure(LocalAgentError("cancelled")))
    return revoked
  }
  /// The synchronous file revocation precedes acknowledgement to Dart. Any
  /// restored callback checks ownership before parsing, flushing or delivering.
  func invalidate(spaceId: String) throws {
    dispatchPrecondition(condition: .onQueue(.main))
    let key = try storageKey(spaceId)
    reservations = reservations.filter { $0.value.storageKey != key }
    revocations.insert(.space(spaceId))
    // Explicit lifecycle revocation is the only path allowed to repair a
    // corrupt/dirty control record. Ordinary admission retries never repair it.
    try authority().invalidate(NovaSpaceScope.supportPath(spaceId), recovery: true)
    try NovaSpaceScope.invalidateProtection(spaceId)
    for value in pending.values where sameSpace(value.spaceId, spaceId) {
      if let task = tasks[value.id] { cancelTask(task, value) }
      else { value.cancelled = true }
    }
    try revoke(.space(spaceId))
    reconcile(spaceId: spaceId)
  }
  func reconcile(spaceId: String) {
    let snapshot = try? authority().snapshot(NovaSpaceScope.supportPath(spaceId))
    let candidates = (try? files(spaceId).requestIDs()) ?? []
    session.getAllTasks { all in
      DispatchQueue.main.async {
        var active = Set<String>()
        for task in all where task.state != .completed {
          let value = self.entry(task)
          if self.sameSpace(value.spaceId, spaceId) {
            if self.owns(value) { active.insert(value.fileID) }
            else { self.cancelTask(task, value) }
          }
        }
        // Include requests submitted since getAllTasks took its snapshot.
        for value in self.pending.values where self.sameSpace(value.spaceId, spaceId) && self.owns(value) { active.insert(value.fileID) }
        do {
          if let snapshot { try self.authority().reconcile(NovaSpaceScope.supportPath(spaceId), snapshot: snapshot, active: active) }
          try self.files(spaceId).purgeResults()
          for fileID in candidates.subtracting(active) { try self.files(spaceId).remove(fileID) }
        } catch { self.revocations.insert(.space(spaceId)) }
      }
    }
  }
  private func owns(_ value: Pending) -> Bool {
    guard !value.cancelled, let spaceId = value.spaceId else { return false }
    for revocation in revocations {
      switch revocation {
      case .space(let other): if sameSpace(spaceId, other) { return false }
      case .file(let other, let fileID): if value.fileID == fileID && sameSpace(spaceId, other) { return false }
      }
    }
    guard (try? authority().owns(NovaSpaceScope.supportPath(spaceId), id: value.id, token: value.token, generation: value.authorityGeneration)) == true else { return false }
    return (try? files(spaceId).owns(value.fileID)) == true
  }
  private func entry(_ task: URLSessionTask) -> Pending {
    if let value = pending[key(task)] { return value }
    let parts = task.taskDescription?.components(separatedBy:"/") ?? []
    let scoped = parts.first?.hasPrefix("scope=") == true
    let spaceId = scoped ? String(parts[0].dropFirst(6)) : nil
    let raw = scoped && parts.count > 1 ? parts[1] : nil
    let id = raw.flatMap { UUID(uuidString: $0) == nil ? nil : $0 } ?? UUID().uuidString
    let rawToken = parts.first { $0.hasPrefix("token=") }.map { String($0.dropFirst(6)) }
    let token = rawToken.flatMap { UUID(uuidString: $0) != nil ? $0 : nil }
    let epoch = parts.first { $0.hasPrefix("authority=") }.map { String($0.dropFirst(10)) }
    let value = Pending(id: id, spaceId: spaceId, token: token, authorityGeneration: epoch)
    if let current = tasks[id], key(current) != key(task) { value.cancelled = true }
    if token == nil || epoch == nil {
      value.cancelled = true; value.failure = "model_transfer_interrupted"
    }
    // A background relaunch can precede Flutter selecting a Space. Keep a
    // legitimate upload bounded by URLSession's timeout, but never save its reply.
    if !owns(value) || (NovaSpaceScope.selected != nil && !sameSpace(spaceId, try? NovaSpaceScope.standaloneID())) { value.cancelled = true; task.cancel() }
    if tasks[id] == nil { tasks[id] = task }
    value.responses = task.taskDescription?.contains("/responses") == true
    if Self.streams(task.taskDescription) { value.parser = parser(for: value) }; pending[key(task)] = value; return value
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
    guard !value.quiet, let token = value.token, owns(value), sameSpace(value.spaceId, try? NovaSpaceScope.standaloneID()), !value.deltas.isEmpty else { value.deltas.removeAll(); return }
    let deltas = value.deltas; value.deltas.removeAll(keepingCapacity:true)
    channel?.invokeMethod("deltas", arguments:["id":value.id,"reservation":token,"deltas":deltas])
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if relayed.contains(key(dataTask)) { return }
    let value = entry(dataTask)
    guard owns(value) else { cancelTask(dataTask, value); return }
    if let parser = value.parser, dataTask.response?.mimeType == "text/event-stream" {
      do { try parser.append(data) }
      catch { value.failure = (error as? LocalAgentError)?.code ?? "invalid_model_response"; dataTask.cancel() }
      return
    }
    guard value.data.count + data.count <= 2 * 1024 * 1024 else { value.failure = "model_response_too_large"; dataTask.cancel(); return }
    value.data.append(data)
  }
  private func finish(_ value: Pending, _ task: URLSessionTask, _ result: Result<[String: Any], Error>) {
    let completion = value.completion; value.completion = nil
    value.terminal = true; value.cancelled = true
    value.data.removeAll(); value.deltas.removeAll(); value.parser = nil
    // Failed cleanup retains the cancelled terminal entry and blocks new
    // admissions. Successful cleanup retires all per-request cancellation state.
    try? retire(key(task), value)
    completion?(result)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // The relayed successor owns the request file, completion and lease.
    if relayed.remove(key(task)) != nil { return }
    let value = entry(task)
    endBackgroundTask(value)
    // Deliver already-parsed thinking even when the same batch ends in an error.
    flush(value)
    if tasks[value.id].map(key) == key(task) { NovaBackgroundExecution.modelTransferFinished(value.fileID) }
    let result: Result<[String: Any], Error>
    do {
      if let failure = value.failure { throw LocalAgentError(failure) }
      guard owns(value), value.spaceId != nil, sameSpace(value.spaceId, try? NovaSpaceScope.standaloneID()) else { throw LocalAgentError("space_changed") }
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
        result = .success(value.quiet ? Self.replacingReasoning(parser.response()) : parser.response())
      } else {
      guard let object = try JSONSerialization.jsonObject(with: value.data) as? [String: Any], (object["error"] == nil || object["error"] is NSNull) else { throw LocalAgentError("invalid_model_response") }
      result = .success(object)
      }
    } catch { result = .failure((error as? LocalAgentError) ?? LocalAgentError("invalid_model_response")) }
    finish(value, task, result)
    // No orphan result is persisted: there is no reader/replay consumer. A
    // suspended live turn still receives its completion; a terminated one does not.
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let completion = wakeCompletion; wakeCompletion = nil; completion?()
  }
}
