import Foundation
import Flutter

func checkModelTransferAuthority(_ scratch: URL) throws {
  func require(_ value: Bool) { precondition(value) }
  let manager = FileManager.default
  let control = try NovaSpaceScope.modelTransferControlDirectory()
  let authority = ModelTransferAuthority(controlDirectory: control)
  let savedSelection = NovaSpaceScope.selected
  defer { NovaSpaceScope.selected = savedSelection }
  var number = 30000
  func writer() -> NativeModelTransfer { NativeModelTransfer(sessionIdentifier: "com.nova.authority-checks." + UUID().uuidString) }
  func task(_ space: String, id: String = UUID().uuidString, authorized: Bool = true, stream: Bool = true) throws -> DataTask {
    let directory = try NovaSpaceScope.supportDirectory(space)
    let transfers = directory.appendingPathComponent("ModelTransfers")
    try manager.createDirectory(at: transfers, withIntermediateDirectories: true)
    let token = UUID().uuidString
    let epoch = authorized ? try authority.authorize(directory, id: id, token: token) : nil
    try Data("private request".utf8).write(to: ModelTransferFiles(directory: transfers).request(id + "." + token))
    number += 1
    return DataTask(number, space, id, token: token, authority: epoch, stream: stream)
  }
  func stream(_ writer: NativeModelTransfer, _ task: DataTask, text: String = "private old bytes") {
    writer.urlSession(.shared, dataTask: task, didReceive: Data("data: {\"choices\":[{\"delta\":{\"content\":\"\(text)\"}}]}\n\n".utf8))
  }
  func finish(_ writer: NativeModelTransfer, _ task: DataTask) { writer.urlSession(.shared, task: task, didCompleteWithError: nil) }
  func token(_ task: DataTask) -> String { task.taskDescription!.components(separatedBy: "/").first { $0.hasPrefix("token=") }!.dropFirst(6).description }
  func epoch(_ task: DataTask) -> String? { task.taskDescription!.components(separatedBy: "/").first { $0.hasPrefix("authority=") }.map { String($0.dropFirst(10)) } }
  func owns(_ task: DataTask, space: String) throws -> Bool {
    try authority.owns(NovaSpaceScope.supportPath(space), id: id(task), token: token(task), generation: epoch(task))
  }

  // A valid generation-backed upload survives a genuinely new native instance
  // before Flutter restores selection. Its SSE is nonce-labelled when selected.
  let valid = try task("authority-valid")
  NovaSpaceScope.selected = .init(id: "authority-valid", mode: "standalone")
  let fresh = writer(); fresh.install(messenger: Messenger())
  NovaSpaceScope.selected = nil
  stream(fresh, valid)
  let validOwned = try owns(valid, space: "authority-valid")
  require(valid.cancellations == 0 && validOwned)
  NovaSpaceScope.selected = .init(id: "authority-valid", mode: "standalone")
  RunLoop.main.run(until: Date().addingTimeInterval(0.07))
  require(FlutterMethodChannel.events.last?["reservation"] as? String == token(valid))
  finish(fresh, valid)
  require(!(try owns(valid, space: "authority-valid")))
  // Pre-authority upgrade artifacts are never implicitly promoted to authority.
  let legacy = try task("authority-valid", authorized: false)
  stream(writer(), legacy)
  require(legacy.cancellations > 0)

  // Revoke through a symlink alias, fail removal, then restore into a NEW writer.
  let durable = try task("authority-durable")
  let durableRoot = try NovaSpaceScope.supportPath("authority-durable")
  let alias = try NovaSpaceScope.supportPath("authority-link")
  try manager.createSymbolicLink(at: alias, withDestinationURL: durableRoot)
  require(try authority.storageKey(alias) == authority.storageKey(durableRoot))
  NovaSpaceScope.selected = .init(id: "authority-durable", mode: "standalone")
  let transfers = durableRoot.appendingPathComponent("ModelTransfers")
  try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: transfers.path)
  do { try writer().invalidate(spaceId: "authority-link"); preconditionFailure("cleanup failure ignored") } catch {}
  let afterFailure = writer(); afterFailure.install(messenger: Messenger())
  let events = FlutterMethodChannel.events.count
  stream(afterFailure, durable)
  require(durable.cancellations > 0 && FlutterMethodChannel.events.count == events)
  require(manager.fileExists(atPath: transfers.appendingPathComponent(fileID(durable) + ".request").path))
  try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: transfers.path)
  try afterFailure.invalidate(spaceId: "authority-durable")
  finish(afterFailure, durable)

  // Real case-folding alias coverage only where the host filesystem supports it.
  if try durableRoot.resourceValues(forKeys: [.volumeSupportsCaseSensitiveNamesKey]).volumeSupportsCaseSensitiveNames == false {
    let folded = try task("authority-durable")
    try writer().invalidate(spaceId: "AUTHORITY-DURABLE")
    require(!(try owns(folded, space: "authority-durable")))
    stream(writer(), folded); precondition(folded.cancellations > 0)
    print("PASS case-insensitive Space aliases share durable authority")
  } else { print("SKIP case-folding alias runtime check: host volume is case-sensitive; symlink alias checked") }

  // An outstanding reservation in another native instance is bound to the
  // durable epoch too, not just that instance's in-memory selection generation.
  NovaSpaceScope.selected = .init(id: "authority-durable", mode: "standalone")
  let staleAdmissionWriter = writer()
  let staleID = UUID().uuidString
  let staleToken = try staleAdmissionWriter.reserve(id: staleID)
  try writer().invalidate(spaceId: "authority-link")
  var staleRejected = false
  staleAdmissionWriter.request(id: staleID, reservation: staleToken,
      configuration: NativeModelConfiguration(endpoint: "https://127.0.0.1:1", model: "test", key: "test"), body: [:]) { result in
    guard case .failure(let error) = result else { preconditionFailure("old cross-instance admission accepted") }
    require((error as? LocalAgentError)?.code == "cancelled")
    staleRejected = true
  }
  require(staleRejected)
  // A failed manifest atomic replacement leaves a durable dirty lock marker.
  // Even after permissions are repaired, a NEW instance must require explicit retry.
  let blocked = try task("authority-blocked")
  NovaSpaceScope.selected = .init(id: "authority-blocked", mode: "standalone")
  try manager.setAttributes([.posixPermissions: 0o555], ofItemAtPath: control.path)
  let failedBarrierWriter = writer()
  do { try failedBarrierWriter.invalidate(spaceId: "authority-blocked"); preconditionFailure("barrier write failure ignored") } catch {}
  try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: control.path)
  do { _ = try failedBarrierWriter.reserve(id: UUID().uuidString); preconditionFailure("admission implicitly repaired dirty control") }
  catch let error as LocalAgentError { require(error.code == "model_cleanup_pending") }
  let blockedFresh = writer()
  stream(blockedFresh, blocked)
  require(blocked.cancellations > 0)
  do { _ = try blockedFresh.reserve(id: UUID().uuidString); preconditionFailure("dirty control admitted a request") }
  catch let error as LocalAgentError { precondition(error.code == "model_cleanup_pending") }
  try blockedFresh.invalidate(spaceId: "authority-blocked")
  finish(blockedFresh, blocked)

  // If even the barrier/lock cannot be written, cancellation is not acknowledged.
  // A fresh instance also fails closed while the control location is unwritable;
  // repairing permissions is followed by an explicit generation-reset retry.
  let unwritable = try task("authority-unwritable")
  let unwritableRoot = try NovaSpaceScope.supportPath("authority-unwritable")
  let lock = control.appendingPathComponent(try authority.storageKey(unwritableRoot) + ".lock")
  NovaSpaceScope.selected = .init(id: "authority-unwritable", mode: "standalone")
  try manager.setAttributes([.posixPermissions: 0o400], ofItemAtPath: lock.path)
  let cannotPersist = writer()
  require(!cannotPersist.cancel(id(unwritable), reservation: token(unwritable)))
  let cannotRestore = writer(); stream(cannotRestore, unwritable)
  require(unwritable.cancellations > 0)
  try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lock.path)
  try cannotPersist.invalidate(spaceId: "authority-unwritable")
  finish(cannotRestore, unwritable)

  // Corrupt control is never an empty ledger or permission to adopt request files.
  let corrupt = try task("authority-corrupt")
  let corruptRoot = try NovaSpaceScope.supportPath("authority-corrupt")
  let manifest = control.appendingPathComponent(try authority.storageKey(corruptRoot) + ".json")
  try Data("corrupt control".utf8).write(to: manifest)
  NovaSpaceScope.selected = .init(id: "authority-corrupt", mode: "standalone")
  let corruptFresh = writer(); stream(corruptFresh, corrupt)
  require(corrupt.cancellations > 0)
  do { _ = try corruptFresh.reserve(id: UUID().uuidString); preconditionFailure("corrupt control admitted") } catch {}
  try corruptFresh.invalidate(spaceId: "authority-corrupt")
  finish(corruptFresh, corrupt)

  // Same path, different filesystem root: copied old artifacts have no authority.
  let replaced = try task("authority-replaced")
  let replaceRoot = try NovaSpaceScope.supportPath("authority-replaced")
  let oldCopy = scratch.appendingPathComponent("old-root-copy")
  try manager.moveItem(at: replaceRoot, to: oldCopy)
  let newRoot = try NovaSpaceScope.supportDirectory("authority-replaced")
  let newTransfers = newRoot.appendingPathComponent("ModelTransfers")
  try manager.createDirectory(at: newTransfers, withIntermediateDirectories: true)
  try Data("old copied request".utf8).write(to: newTransfers.appendingPathComponent(fileID(replaced) + ".request"))
  NovaSpaceScope.selected = .init(id: "authority-replaced", mode: "standalone")
  let replacementFresh = writer(); stream(replacementFresh, replaced)
  require(replaced.cancellations > 0)
  finish(replacementFresh, replaced)
  let deleted = try task("authority-replaced")
  try manager.removeItem(at: newRoot)
  stream(writer(), deleted)
  require(deleted.cancellations > 0 && !manager.fileExists(atPath: newRoot.path))
  try manager.removeItem(at: oldCopy)

  // Independent instances cannot overwrite a newer same-ID authorization with
  // a stale revocation: the read/modify/write transaction holds the stable lock.
  let concurrent = try NovaSpaceScope.supportDirectory("authority-concurrent")
  let requestID = UUID().uuidString
  for _ in 0..<16 {
    let old = UUID().uuidString, new = UUID().uuidString
    let current = try authority.authorize(concurrent, id: requestID, token: old)
    let errors = NSLock(); var failures = 0
    DispatchQueue.concurrentPerform(iterations: 2) { index in
      do {
        let store = ModelTransferAuthority(controlDirectory: control)
        if index == 0 { _ = try store.authorize(concurrent, id: requestID, token: new) }
        else { try store.revoke(concurrent, id: requestID, token: old) }
      } catch { errors.lock(); failures += 1; errors.unlock() }
    }
    require(failures == 0)
    require(try authority.owns(concurrent, id: requestID, token: new, generation: current))
  }
  try authority.invalidate(concurrent)
  print("PASS durable authority new-instance/failure/alias/root-replacement/corruption/concurrent-instance controls")
}
