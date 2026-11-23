// Minimal host doubles for the UIKit surface NativeModelTransfer uses: app state
// and background-time assertions the checks can grant, deny and expire.
@_exported import Foundation

public struct UIBackgroundTaskIdentifier: Hashable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
  public static let invalid = UIBackgroundTaskIdentifier(rawValue: 0)
}

public final class UIApplication: @unchecked Sendable {
  public enum State { case active, inactive, background }
  public static let shared = UIApplication()
  /// Background by default so older checks keep the background-session path.
  public var applicationState = State.background
  public var grantsBackgroundTime = true
  public private(set) var handlers = [Int: () -> Void]()
  public private(set) var ended = [Int]()
  private var next = 0
  public func beginBackgroundTask(withName name: String?, expirationHandler: (() -> Void)?) -> UIBackgroundTaskIdentifier {
    guard grantsBackgroundTime else { return .invalid }
    next += 1
    handlers[next] = expirationHandler ?? {}
    return UIBackgroundTaskIdentifier(rawValue: next)
  }
  public func endBackgroundTask(_ identifier: UIBackgroundTaskIdentifier) {
    precondition(handlers.removeValue(forKey: identifier.rawValue) != nil, "background task ended twice or never began")
    ended.append(identifier.rawValue)
  }
  /// iOS calls each expiration handler once, just before suspending the app.
  public func expireAll() {
    for (_, handler) in handlers.sorted(by: { $0.key < $1.key }) { handler() }
  }
}
