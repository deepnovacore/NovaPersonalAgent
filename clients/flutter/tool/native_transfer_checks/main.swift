import Foundation
import Flutter

final class DataTask: URLSessionDataTask, @unchecked Sendable {
  let number: Int
  let streaming: Bool
  var cancellations = 0
  init(_ number: Int, _ space: String, _ id: String, token: String? = nil, authority: String? = nil, stream: Bool = false) {
    self.number = number
    self.streaming = stream
    super.init()
    taskDescription = "scope=\(space)/\(id)" + (token.map { "/token=" + $0 } ?? "") + (authority.map { "/authority=" + $0 } ?? "") + (stream ? "/stream" : "")
  }
  override var taskIdentifier: Int { number }
  override var response: URLResponse? {
    HTTPURLResponse(url: URL(string: "https://127.0.0.1:1")!, statusCode: 200,
                    httpVersion: nil, headerFields: ["Content-Type": streaming ? "text/event-stream" : "application/json"])
  }
  override func cancel() { cancellations += 1 }
}

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
try checkPrivateSpaceDirectory(root)
NovaSpaceScope.root = root
let files = ModelTransferFiles(directory: try NovaSpaceScope.supportDirectory("one").appendingPathComponent("ModelTransfers"))
try FileManager.default.createDirectory(at: files.directory, withIntermediateDirectories: true)
var instant: TimeInterval = 1000
// Isolate command-line background sessions from earlier harness runs/devices.
let transport = NativeModelTransfer(clock: { instant }, sessionIdentifier: "com.nova.transfer-checks." + UUID().uuidString)
let session = URLSession.shared
var next = 9000
func restored(_ space: String = "one", token: String? = nil, stream: Bool = false, authorized: Bool = true, id requestID: String = UUID().uuidString) throws -> DataTask {
  next += 1
  let id = requestID
  let directory = try NovaSpaceScope.supportDirectory(space).appendingPathComponent("ModelTransfers")
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let token = authorized ? (token ?? UUID().uuidString) : token
  let epoch = authorized ? try ModelTransferAuthority(controlDirectory: NovaSpaceScope.modelTransferControlDirectory()).authorize(NovaSpaceScope.supportPath(space), id: id, token: token!) : nil
  try Data("private request".utf8).write(to: ModelTransferFiles(directory: directory).request(token.map { id + "." + $0 } ?? id))
  return DataTask(next, space, id, token: token, authority: epoch, stream: stream)
}
func id(_ task: DataTask) -> String { task.taskDescription!.components(separatedBy: "/")[1] }
func fileID(_ task: DataTask) -> String {
  let token = task.taskDescription!.components(separatedBy: "/").first { $0.hasPrefix("token=") }.map { String($0.dropFirst(6)) }
  return token.map { id(task) + "." + $0 } ?? id(task)
}
func registryCount(_ name: String) -> Int {
  Mirror(reflecting: Mirror(reflecting: transport).children.first { $0.label == name }!.value).children.count
}
func retired() {
  for name in ["pending", "tasks", "reservations", "revocations"] { precondition(registryCount(name) == 0, "unretired " + name) }
}
func receive(_ task: DataTask) { transport.urlSession(session, dataTask: task, didReceive: Data("{\"private\":\"response\"}".utf8)) }
func complete(_ task: DataTask, error: Error? = nil) { transport.urlSession(session, task: task, didCompleteWithError: error) }
func absent(_ task: DataTask) {
  precondition(!files.owns(fileID(task)))
  precondition(!FileManager.default.fileExists(atPath: files.directory.appendingPathComponent(fileID(task) + ".result").path))
}

// A terminated turn's successful/error completion never saves an orphan reply.
for error in [nil, NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)] as [Error?] {
  let task = try restored(); receive(task); complete(task, error: error); absent(task)
}
// Dart/native cancellation wins against a late *successful* URLSession callback.
let cancelled = try restored(); receive(cancelled); transport.cancel(id(cancelled)); complete(cancelled); absent(cancelled)
let earlyCancel = try restored(); transport.cancel(id(earlyCancel), reservation: earlyCancel.taskDescription!.components(separatedBy: "/").first { $0.hasPrefix("token=") }.map { String($0.dropFirst(6)) }); receive(earlyCancel); complete(earlyCancel); absent(earlyCancel)
// Forget revokes request ownership before acknowledgement, including tasks not
// yet restored into Pending, and repeated invalidation is safe.
let forgotten = try restored(); receive(forgotten)
let notYetRestored = try restored()
try transport.invalidate(spaceId: "one")
try transport.invalidate(spaceId: "one")
receive(forgotten); complete(forgotten); absent(forgotten)
receive(notYetRestored); complete(notYetRestored); absent(notYetRestored)
// Simulate process relaunch after deletion: a new native writer cannot resurrect.
let relaunched = NativeModelTransfer(sessionIdentifier: "com.nova.transfer-checks." + UUID().uuidString)
relaunched.urlSession(session, dataTask: notYetRestored, didReceive: Data("{}".utf8))
relaunched.urlSession(session, task: notYetRestored, didCompleteWithError: nil)
absent(notYetRestored)
// Switching away then back must not restore the old task's authority.
let switched = try restored(); receive(switched)
try transport.invalidate(spaceId: "one")
NovaSpaceScope.selected = .init(id: "two", mode: "standalone")
NotificationCenter.default.post(name: NovaSpaceScope.changed, object: nil)
NovaSpaceScope.selected = .init(id: "one", mode: "standalone")
complete(switched); absent(switched)
// Legitimate bounded background uploads can receive bytes before Flutter scope
// restoration, but their completed response is never retained for replay.
let background = try restored(token: UUID().uuidString)
NovaSpaceScope.selected = nil
receive(background)
precondition(background.cancellations == 0 && files.owns(fileID(background)))
complete(background); absent(background)
NovaSpaceScope.selected = .init(id: "one", mode: "standalone")
// Reconcile deletes stale requests/legacy results, not the active upload.
let active = try restored(), stale = try restored()
try Data("legacy private response".utf8).write(to: files.directory.appendingPathComponent("legacy.result"))
try files.reconcile(active: [fileID(active)])
precondition(files.owns(fileID(active)) && !files.owns(fileID(stale)))
precondition(!FileManager.default.fileExists(atPath: files.directory.appendingPathComponent("legacy.result").path))
try files.invalidate()
// A scheduled SSE delta flush must be revoked too, not just final completion.
final class Messenger: FlutterBinaryMessenger {}
transport.install(messenger: Messenger())
let streaming = try restored(stream: true)
transport.urlSession(session, dataTask: streaming, didReceive: Data("data: {\"choices\":[{\"delta\":{\"content\":\"private\"}}]}\n\n".utf8))
try transport.invalidate(spaceId: "one")
RunLoop.main.run(until: Date().addingTimeInterval(0.1))
precondition(FlutterMethodChannel.deltas == 0)
complete(streaming); absent(streaming)
// Exercise the actual request writer and live completion closure. Inspect only
// the private task identity to supply deterministic delegate events; no external
// service is used, and the real loopback upload is immediately cancelled.
let config = NativeModelConfiguration(endpoint: "https://127.0.0.1:1", model: "test", key: "test")
func liveRequest(id requestID: String = UUID().uuidString, _ completion: @escaping (Result<[String: Any], Error>) -> Void) -> DataTask {
  let reservation = try! transport.reserve(id: requestID)
  transport.request(id: requestID, reservation: reservation, configuration: config, body: ["private": "context"], completion: completion)
  let tasks = Mirror(reflecting: transport).children.first { $0.label == "tasks" }!.value as! [String: URLSessionTask]
  let real = tasks[requestID]!
  real.cancel()
  let fake = DataTask(real.taskIdentifier, "one", requestID, token: reservation)
  fake.taskDescription = real.taskDescription
  return fake
}
var delivered = 0
let live = liveRequest { result in
  guard case .success(let response) = result else { preconditionFailure("live result lost") }
  precondition(response["private"] as? String == "response")
  delivered += 1
}
precondition(files.owns(fileID(live)))
receive(live); complete(live); absent(live)
precondition(delivered == 1)
var cancellations = 0
let liveCancel = liveRequest { result in
  guard case .failure(let error) = result else { preconditionFailure("cancelled result delivered") }
  precondition((error as? LocalAgentError)?.code == "cancelled")
  cancellations += 1
}
transport.cancel(id(liveCancel))
precondition(cancellations == 1)
receive(liveCancel); complete(liveCancel); absent(liveCancel)
precondition(cancellations == 1)
func rejected(_ requestID: String, _ token: String, code: String = "cancelled") {
  var rejected = false
  transport.request(id: requestID, reservation: token, configuration: config, body: ["private": "must not send"]) { result in
    guard case .failure(let error) = result else { preconditionFailure("revoked request restarted") }
    precondition((error as? LocalAgentError)?.code == code)
    rejected = true
  }
  precondition(rejected)
}
let beforeRequest = UUID().uuidString
let beforeToken = try transport.reserve(id: beforeRequest)
transport.cancel(beforeRequest, reservation: beforeToken)
rejected(beforeRequest, beforeToken)
// Reusing an ID gets a fresh nonce. Neither a delayed request nor a delayed
// cancellation for its old nonce may consume/cancel the new reservation.
let replacementToken = try transport.reserve(id: beforeRequest)
precondition(replacementToken != beforeToken)
rejected(beforeRequest, beforeToken)
transport.cancel(beforeRequest, reservation: beforeToken)
precondition(registryCount("reservations") == 1)
transport.cancel(beforeRequest, reservation: replacementToken)
rejected(UUID().uuidString, UUID().uuidString)
retired()

// An off-main request already queued for main admission still loses to cancel.
let queuedID = UUID().uuidString
let queuedToken = try transport.reserve(id: queuedID)
let enqueued = DispatchSemaphore(value: 0)
var queuedRejected = false
DispatchQueue.global().async {
  transport.request(id: queuedID, reservation: queuedToken, configuration: config, body: ["private": "queued body"]) { result in
    guard case .failure(let error) = result else { preconditionFailure("queued cancelled request admitted") }
    precondition((error as? LocalAgentError)?.code == "cancelled")
    queuedRejected = true
  }
  enqueued.signal()
}
precondition(enqueued.wait(timeout: .now() + 2) == .success)
transport.cancel(queuedID, reservation: queuedToken)
RunLoop.main.run(until: Date().addingTimeInterval(0.1))
precondition(queuedRejected)
precondition(!files.owns(queuedID + "." + queuedToken))
retired()

// Repeated terminal lifecycle cleanup has no process-lifetime UUID registry.
for index in 0..<256 {
  let task = try restored(); receive(task)
  if index.isMultiple(of: 16) { try transport.invalidate(spaceId: "one") }
  else { transport.cancel(id(task)) }
  complete(task); absent(task)
  receive(task); complete(task); absent(task) // callbacks after retirement
  retired()
  let requestID = UUID().uuidString
  let token = try transport.reserve(id: requestID)
  transport.cancel(requestID, reservation: token)
  rejected(requestID, token)
  retired()
}

// Fixed-size expiring admissions do not write bodies, evict live entries, or
// time out an already-started upload. Expired tokens never become admissible.
var backgroundDelivered = 0
let boundedBackground = liveRequest { result in
  guard case .success = result else { preconditionFailure("active background request expired") }
  backgroundDelivered += 1
}
var held = [(String, String)]()
for _ in 0..<NativeModelTransfer.reservationLimit {
  let requestID = UUID().uuidString
  held.append((requestID, try transport.reserve(id: requestID)))
}
precondition(registryCount("reservations") == NativeModelTransfer.reservationLimit)
do { _ = try transport.reserve(id: UUID().uuidString); preconditionFailure("admission overflow accepted") }
catch let error as LocalAgentError { precondition(error.code == "model_admission_full") }
let backgroundFiles = try files.requestIDs()
precondition(backgroundFiles == [fileID(boundedBackground)])
instant += NativeModelTransfer.reservationLifetime + 1
let afterExpiry = UUID().uuidString
let afterToken = try transport.reserve(id: afterExpiry)
precondition(registryCount("reservations") == 1)
for (requestID, token) in held { rejected(requestID, token) }
transport.cancel(afterExpiry, reservation: afterToken)
receive(boundedBackground); complete(boundedBackground); absent(boundedBackground)
precondition(backgroundDelivered == 1)
retired()

let expiredID = UUID().uuidString, scopedID = UUID().uuidString, forgottenID = UUID().uuidString
let expiredToken = try transport.reserve(id: expiredID)
instant += NativeModelTransfer.reservationLifetime + 1
rejected(expiredID, expiredToken)
let scopedToken = try transport.reserve(id: scopedID)
NovaSpaceScope.selected = .init(id: "two", mode: "standalone")
rejected(scopedID, scopedToken)
NovaSpaceScope.selected = .init(id: "one", mode: "standalone")
let forgottenToken = try transport.reserve(id: forgottenID)
try transport.invalidate(spaceId: "one")
rejected(forgottenID, forgottenToken)
let switchedID = UUID().uuidString
let switchedToken = try transport.reserve(id: switchedID)
NovaSpaceScope.selected = .init(id: "two", mode: "standalone")
NotificationCenter.default.post(name: NovaSpaceScope.changed, object: nil)
NovaSpaceScope.selected = .init(id: "one", mode: "standalone")
NotificationCenter.default.post(name: NovaSpaceScope.changed, object: nil)
rejected(switchedID, switchedToken)
retired()

// A real removal error must retain the cancelled terminal entry AND the disk
// gate. New admissions fail closed until revocation succeeds, not by eviction.
var cleanupCancellations = 0
let cleanupFailure = liveRequest { result in
  guard case .failure = result else { preconditionFailure("cancel failed") }
  cleanupCancellations += 1
}
try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: files.directory.path)
transport.cancel(id(cleanupFailure))
complete(cleanupFailure)
precondition(files.owns(fileID(cleanupFailure)))
precondition(registryCount("pending") == 1 && registryCount("tasks") == 1 && registryCount("revocations") > 0)
do { _ = try transport.reserve(id: UUID().uuidString); preconditionFailure("cleanup failure gate discarded") }
catch let error as LocalAgentError { precondition(error.code == "model_cleanup_pending") }
receive(cleanupFailure); complete(cleanupFailure)
precondition(cleanupCancellations == 1 && registryCount("pending") == 1)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: files.directory.path)
let recoveredID = UUID().uuidString
let recoveredToken = try transport.reserve(id: recoveredID)
transport.cancel(recoveredID, reservation: recoveredToken)
absent(cleanupFailure); retired()
// A stale terminal callback cannot read/remove the new same-ID incarnation.
var reusedDelivered = 0
let reused = liveRequest(id: id(cleanupFailure)) { result in
  guard case .success = result else { preconditionFailure("replacement cancelled by old callback") }
  reusedDelivered += 1
}
receive(cleanupFailure); complete(cleanupFailure)
precondition(files.owns(fileID(reused)))
receive(reused); complete(reused); absent(reused)
precondition(reusedDelivered == 1 && cleanupCancellations == 1)
retired()

let forgetFailure = try restored(); receive(forgetFailure)
try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: files.directory.path)
do { try transport.invalidate(spaceId: "one"); preconditionFailure("forget disk error ignored") } catch {}
complete(forgetFailure)
precondition(registryCount("revocations") > 0 && registryCount("pending") == 1)
do { _ = try transport.reserve(id: UUID().uuidString); preconditionFailure("forget failure gate discarded") }
catch let error as LocalAgentError { precondition(error.code == "model_cleanup_pending") }
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: files.directory.path)
let forgetRecoveredID = UUID().uuidString
let forgetRecoveredToken = try transport.reserve(id: forgetRecoveredID)
transport.cancel(forgetRecoveredID, reservation: forgetRecoveredToken)
retired()
// Inaccessible directories are errors, not proof of absence. A forget before
// task restoration must retain its Space gate until an actual successful purge.
let inaccessible = try restored(token: UUID().uuidString)
try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: files.directory.path)
do { try transport.invalidate(spaceId: "one"); preconditionFailure("inaccessible directory treated as absent") } catch {}
do { _ = try transport.reserve(id: UUID().uuidString); preconditionFailure("inaccessible cleanup gate discarded") }
catch let error as LocalAgentError { precondition(error.code == "model_cleanup_pending") }
for _ in 0..<256 { transport.cancel(UUID().uuidString, reservation: UUID().uuidString) }
precondition(registryCount("revocations") == 1) // one Space gate, not arbitrary UUIDs
receive(inaccessible)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: files.directory.path)
let accessibleID = UUID().uuidString
let accessibleToken = try transport.reserve(id: accessibleID)
transport.cancel(accessibleID, reservation: accessibleToken)
complete(inaccessible); absent(inaccessible)
retired()
print("PASS bounded admission/cancellation retirement, delayed-token isolation, cleanup-error gates and late callbacks")
// Truly unseen old incarnation: its file survives and has valid OLD authority,
// but a newer same-ID request replaces that authorization before it is restored.
let overlapID = UUID().uuidString
let overlapAlias = try NovaSpaceScope.supportPath("one-overlap-alias")
try FileManager.default.createSymbolicLink(at: overlapAlias, withDestinationURL: NovaSpaceScope.supportPath("one"))
let unseen = try restored("one-overlap-alias", stream: true, id: overlapID)
precondition(files.owns(fileID(unseen)))
var overlapDelivered = 0
let newer = liveRequest(id: overlapID) { result in
  guard case .success(let value) = result else { preconditionFailure("old incarnation killed newer request: \(result)") }
  precondition(value["private"] as? String == "response")
  overlapDelivered += 1
}
let oldEvents = FlutterMethodChannel.events.count
NovaSpaceScope.selected = nil
let overlapFresh = NativeModelTransfer(sessionIdentifier: "com.nova.overlap-checks." + UUID().uuidString)
overlapFresh.install(messenger: Messenger())
NovaSpaceScope.selected = .init(id: "one", mode: "standalone")
overlapFresh.urlSession(session, dataTask: unseen, didReceive: Data("data: {\"choices\":[{\"delta\":{\"content\":\"OLD PRIVATE CONTENT\"}}]}\n\n".utf8))
precondition(files.owns(fileID(newer)))
overlapFresh.urlSession(session, task: unseen, didCompleteWithError: nil)
precondition(NovaBackgroundExecution.transfers.contains(fileID(newer)))
// Recreate only the old artifact to prove the active writer also rejects it;
// file presence cannot re-establish the durable old nonce authorization.
try Data("surviving old file".utf8).write(to: files.request(fileID(unseen)))
transport.urlSession(session, dataTask: unseen, didReceive: Data("data: {\"choices\":[{\"delta\":{\"content\":\"OLD PRIVATE CONTENT\"}}]}\n\n".utf8))
precondition(unseen.cancellations > 0)
complete(unseen)
precondition(files.owns(fileID(newer)) && NovaBackgroundExecution.transfers.contains(fileID(newer)))
receive(newer); complete(newer); absent(newer)
precondition(overlapDelivered == 1)
RunLoop.main.run(until: Date().addingTimeInterval(0.07))
precondition(FlutterMethodChannel.events.count == oldEvents)
retired()
try checkModelTransferAuthority(root)
// A late completion after the entire Space was removed must not recreate it.
let removed = try restored(); receive(removed)
try FileManager.default.removeItem(at: try NovaSpaceScope.supportPath("one"))
complete(removed)
let removedPath = try NovaSpaceScope.supportPath("one").path
precondition(!FileManager.default.fileExists(atPath: removedPath))
print("PASS native transfer cancellation/forget/switch/relaunch/background/error/cleanup races (host doubles; not an iOS runtime)")
