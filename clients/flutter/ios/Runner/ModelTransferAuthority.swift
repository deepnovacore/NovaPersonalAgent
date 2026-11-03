import Foundation
import CryptoKit
import Darwin

/// Durable, body-free ownership outside deletable Space roots. All readers and
/// mutations take the same cross-instance/process lock and reread disk state.
final class ModelTransferAuthority {
  private struct Root: Codable, Equatable {
    let device: UInt64, inode: UInt64
    let created: Date
  }
  private struct State: Codable {
    var generation: String
    var root: Root?
    var entries: [String: String] // canonical request UUID -> native nonce
  }
  private let controlDirectory: URL
  private let protection = PrivateSpaceDirectory()
  init(controlDirectory: URL) { self.controlDirectory = controlDirectory }

  func storageKey(_ directory: URL) throws -> String {
    var ancestor = directory.standardizedFileURL
    var missing: [String] = []
    while true {
      do { _ = try FileManager.default.attributesOfItem(atPath: ancestor.path); break }
      catch let error as CocoaError where error.code == .fileReadNoSuchFile {
        missing.insert(ancestor.lastPathComponent, at: 0)
        let parent = ancestor.deletingLastPathComponent()
        guard parent.path != ancestor.path else { throw LocalAgentError("model_authority_unavailable") }
        ancestor = parent
      }
    }
    guard let physical = realpath(ancestor.path, nil) else { throw LocalAgentError("model_authority_unavailable") }
    defer { free(physical) }
    let real = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
    var path = missing.reduce(real) { $0.appendingPathComponent($1) }.path
    guard let sensitive = try real.resourceValues(forKeys: [.volumeSupportsCaseSensitiveNamesKey]).volumeSupportsCaseSensitiveNames else { throw LocalAgentError("model_authority_unavailable") }
    if !sensitive { path = path.lowercased() }
    return SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private func root(_ directory: URL) throws -> Root? {
    let attrs: [FileAttributeKey: Any]
    do { attrs = try FileManager.default.attributesOfItem(atPath: directory.resolvingSymlinksInPath().path) }
    catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    guard let device = attrs[.systemNumber] as? NSNumber, let inode = attrs[.systemFileNumber] as? NSNumber,
          let created = attrs[.creationDate] as? Date else { throw LocalAgentError("model_authority_unavailable") }
    return Root(device: device.uint64Value, inode: inode.uint64Value, created: created)
  }
  private func sync(_ file: URL) throws {
    let fd = open(file.path, O_RDONLY)
    guard fd >= 0 else { throw LocalAgentError("model_authority_unavailable") }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw LocalAgentError("model_authority_unavailable") }
  }
  private func write(_ state: State, to file: URL) throws {
    try JSONEncoder().encode(state).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    try sync(file)
    try sync(controlDirectory)
  }
  private func journal(_ fd: Int32, blocked: Bool) throws {
    guard lseek(fd, 0, SEEK_SET) >= 0 else { throw LocalAgentError("model_authority_unavailable") }
    if blocked {
      var byte: UInt8 = 1
      guard Darwin.write(fd, &byte, 1) == 1, fsync(fd) == 0 else { throw LocalAgentError("model_authority_unavailable") }
    }
    guard ftruncate(fd, blocked ? 1 : 0) == 0 else { throw LocalAgentError("model_authority_unavailable") }
    guard fsync(fd) == 0 else { throw LocalAgentError("model_authority_unavailable") }
    if blocked { try sync(controlDirectory) }
  }
  private func access<T>(_ directory: URL, recovery: Bool = false, mutation: Bool = false, _ work: (inout State) throws -> T) throws -> T {
    let key = try storageKey(directory)
    _ = try protection.prepare(controlDirectory)
    let lock = controlDirectory.appendingPathComponent(key + ".lock")
    let file = controlDirectory.appendingPathComponent(key + ".json")
    let fd = open(lock.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw LocalAgentError("model_authority_unavailable") }
    defer { close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw LocalAgentError("model_authority_unavailable") }
    defer { flock(fd, LOCK_UN) }
    var stat = Darwin.stat()
    guard fstat(fd, &stat) == 0 else { throw LocalAgentError("model_authority_unavailable") }
    guard stat.st_size == 0 || recovery else { throw LocalAgentError("model_cleanup_pending") }
    let currentRoot = try root(directory)
    var state: State
    var created = false
    do { state = try JSONDecoder().decode(State.self, from: Data(contentsOf: file)) }
    catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      state = State(generation: UUID().uuidString, root: currentRoot, entries: [:]); created = true
    } catch {
      guard recovery else { throw LocalAgentError("model_authority_unavailable") }
      state = State(generation: UUID().uuidString, root: currentRoot, entries: [:])
    }
    if UUID(uuidString: state.generation) == nil || state.entries.count > NativeModelTransfer.reservationLimit ||
        !state.entries.allSatisfy({ UUID(uuidString: $0.key) != nil && UUID(uuidString: $0.value) != nil }) {
      guard recovery else { throw LocalAgentError("model_authority_unavailable") }
      state = State(generation: UUID().uuidString, root: currentRoot, entries: [:])
    }
    let replaced = state.root != currentRoot
    if replaced { state = State(generation: UUID().uuidString, root: currentRoot, entries: [:]) }
    if mutation || replaced || created {
      // A failed atomic manifest replacement leaves this durable dirty marker.
      // Restoration cannot trust the old manifest; only explicit Space retry
      // may rotate the generation and clear it after a successful write.
      let result = try work(&state)
      try journal(fd, blocked: true)
      try write(state, to: file)
      try journal(fd, blocked: false)
      return result
    }
    return try work(&state)
  }
  func authorize(_ directory: URL, id: String, token: String, expectedGeneration: String? = nil) throws -> String {
    try access(directory, mutation: true) { state in
      if let expectedGeneration, expectedGeneration != state.generation { throw LocalAgentError("cancelled") }
      guard let id = UUID(uuidString: id)?.uuidString, UUID(uuidString: token) != nil else { throw LocalAgentError("invalid_model_request") }
      guard state.entries[id] != nil || state.entries.count < NativeModelTransfer.reservationLimit else { throw LocalAgentError("model_admission_full") }
      state.entries[id] = token
      return state.generation
    }
  }
  func owns(_ directory: URL, id: String, token: String?, generation: String?) throws -> Bool {
    try access(directory) { state in
      guard let token, let generation, let id = UUID(uuidString: id)?.uuidString else { return false }
      return state.generation == generation && state.entries[id] == token
    }
  }
  func revoke(_ directory: URL, id: String, token: String?) throws {
    try access(directory, mutation: true) { state in
      guard let id = UUID(uuidString: id)?.uuidString, state.entries[id] == token else { return }
      state.entries.removeValue(forKey: id)
    }
  }
  struct Snapshot { let generation: String; let entries: [String: String] }
  func snapshot(_ directory: URL) throws -> Snapshot {
    try access(directory) { Snapshot(generation: $0.generation, entries: $0.entries) }
  }
  func reconcile(_ directory: URL, snapshot: Snapshot, active: Set<String>) throws {
    let active = Set(active.map { $0.uppercased() })
    try access(directory, mutation: true) { state in
      guard state.generation == snapshot.generation else { return }
      state.entries = state.entries.filter {
        snapshot.entries[$0.key] != $0.value || active.contains($0.key + "." + $0.value.uppercased())
      }
    }
  }
  func invalidate(_ directory: URL, recovery: Bool = false) throws {
    try access(directory, recovery: recovery, mutation: true) { state in
      state = State(generation: UUID().uuidString, root: state.root, entries: [:])
    }
  }
}
