import Foundation

/// Main-queue protection for app-owned Space roots. Backup exclusion is always
/// reapplied; the potentially large existing-file migration runs only once per
/// filesystem identity, or after an explicit lifecycle invalidation.
final class PrivateSpaceDirectory {
  private struct Identity: Equatable {
    let device: UInt64, inode: UInt64
    let created: Date
  }
  private let manager: FileManager
  private var migrated: [String: Identity] = [:]
  init(manager: FileManager = .default) { self.manager = manager }

  func invalidate(_ directory: URL) { migrated.removeValue(forKey: directory.path) }

  func prepare(_ directory: URL) throws -> URL {
    var directory = directory
    let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: protection)
    // The containing root protects backup coverage for atomic temporary files
    // and renamed snapshots, independently of individual-file attributes.
    var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
    try directory.setResourceValues(attributes)
    try manager.setAttributes(protection, ofItemAtPath: directory.path)
    let stat = try manager.attributesOfItem(atPath: directory.path)
    guard let device = stat[.systemNumber] as? NSNumber, let inode = stat[.systemFileNumber] as? NSNumber,
          let created = stat[.creationDate] as? Date else { throw CocoaError(.fileReadUnknown) }
    let identity = Identity(device: device.uint64Value, inode: inode.uint64Value, created: created)
    if migrated[directory.path] == identity { return directory }
    var migrationError: Error?
    guard let entries = manager.enumerator(at: directory, includingPropertiesForKeys: [.isSymbolicLinkKey], errorHandler: { _, error in
      migrationError = error; return false
    }) else { throw CocoaError(.fileReadUnknown) }
    for case let file as URL in entries {
      if try file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true { entries.skipDescendants(); continue }
      try manager.setAttributes(protection, ofItemAtPath: file.path)
    }
    if let error = migrationError { throw error }
    migrated[directory.path] = identity // Never cache partial/failed migration.
    return directory
  }
}
