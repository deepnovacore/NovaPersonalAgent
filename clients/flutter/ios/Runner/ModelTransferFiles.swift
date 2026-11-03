import Foundation

/// Main-queue transfer ownership is also recorded by the request file. Deleting
/// it revokes restored tasks, even if URLSession delivers a late success.
struct ModelTransferFiles {
  let directory: URL
  private let manager = FileManager.default

  func request(_ id: String) -> URL { directory.appendingPathComponent(id + ".request") }
  func owns(_ id: String) -> Bool { manager.fileExists(atPath: request(id).path) }
  func remove(_ id: String) throws {
    for suffix in [".request", ".result"] {
      let file = directory.appendingPathComponent(id + suffix)
      do { _ = try manager.attributesOfItem(atPath: file.path) }
      catch let error as CocoaError where error.code == .fileReadNoSuchFile { continue }
      try manager.removeItem(at: file)
    }
  }
  private func entries() throws -> [URL] {
    do { return try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) }
    catch let error as CocoaError where error.code == .fileReadNoSuchFile { return [] }
  }
  func requestIDs() throws -> Set<String> {
    Set(try entries().filter { $0.pathExtension == "request" }.map { $0.deletingPathExtension().lastPathComponent })
  }
  func purgeResults() throws {
    for file in try entries() where file.pathExtension == "result" { try manager.removeItem(at: file) }
  }
  func invalidate() throws {
    for id in try requestIDs() { try remove(id) }
    try purgeResults()
  }
  func reconcile(active: Set<String>) throws {
    try purgeResults()
    for id in try requestIDs() where !active.contains(id) { try remove(id) }
  }
}
