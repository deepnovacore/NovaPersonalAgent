import Foundation

private final class TrackingFileManager: FileManager, @unchecked Sendable {
  var protectedPaths: [String] = []
  var failPath: String?
  override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
    precondition(attributes[.protectionKey] as? FileProtectionType == .completeUntilFirstUserAuthentication)
    protectedPaths.append(path)
    if path == failPath { throw CocoaError(.fileWriteNoPermission) }
    try super.setAttributes(attributes, ofItemAtPath: path)
  }
}

func checkPrivateSpaceDirectory(_ scratch: URL) throws {
  let manager = TrackingFileManager()
  let protection = PrivateSpaceDirectory(manager: manager)
  let directory = scratch.appendingPathComponent("private-directory")
  try manager.createDirectory(at: directory, withIntermediateDirectories: true)
  let memory = directory.appendingPathComponent("local_memory.json")
  try Data("existing sensitive file".utf8).write(to: memory)
  _ = try protection.prepare(directory)
  precondition(manager.protectedPaths.filter { $0 == memory.path }.count == 1)
  // A cached migration still reapplies root backup exclusion/protection.
  var root = directory
  var attributes = URLResourceValues(); attributes.isExcludedFromBackup = false
  try root.setResourceValues(attributes)
  _ = try protection.prepare(directory)
  precondition(manager.protectedPaths.filter { $0 == memory.path }.count == 1)
  let excluded = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
  precondition(excluded == true)
  // Same-process deletion/recreation at the same path changes filesystem identity.
  try manager.removeItem(at: directory)
  try manager.createDirectory(at: directory, withIntermediateDirectories: true)
  try Data("replacement".utf8).write(to: memory)
  _ = try protection.prepare(directory)
  precondition(manager.protectedPaths.filter { $0 == memory.path }.count == 2)
  // Reset/switch invalidation also forces migration when the root inode is unchanged.
  let snapshot = directory.appendingPathComponent("local_memory.json.corrupt-test")
  try Data("recovery copy".utf8).write(to: snapshot)
  protection.invalidate(directory)
  _ = try protection.prepare(directory)
  precondition(manager.protectedPaths.contains(snapshot.path))
  // Do not protect unrelated files through a workspace symlink.
  let unrelated = scratch.appendingPathComponent("unrelated")
  try Data("user file".utf8).write(to: unrelated)
  try manager.createSymbolicLink(at: directory.appendingPathComponent("external"), withDestinationURL: unrelated)
  protection.invalidate(directory)
  _ = try protection.prepare(directory)
  precondition(!manager.protectedPaths.contains(unrelated.path))
  // A partial migration failure must be retried rather than cached as success.
  protection.invalidate(directory)
  manager.failPath = memory.path
  do {
    _ = try protection.prepare(directory)
    preconditionFailure("migration error ignored")
  } catch let error as CocoaError { precondition(error.code == .fileWriteNoPermission) }
  let attempts = manager.protectedPaths.filter { $0 == memory.path }.count
  manager.failPath = nil
  _ = try protection.prepare(directory)
  precondition(manager.protectedPaths.filter { $0 == memory.path }.count == attempts + 1)
  try manager.removeItem(at: directory)
  try manager.removeItem(at: unrelated)
  print("PASS PrivateSpaceDirectory root exclusion/cache/replacement/reset/failed-migration retry (macOS host, not iOS protection verification)")
}
