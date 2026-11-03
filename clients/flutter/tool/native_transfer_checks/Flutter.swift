// Minimal host doubles, not an iOS Flutter runtime.
import Foundation
public protocol FlutterBinaryMessenger: AnyObject {}
public typealias FlutterResult = (Any?) -> Void
public final class FlutterError: Error {
  public let code: String
  public init(code: String, message: String?, details: Any?) { self.code = code }
}
public let FlutterMethodNotImplemented = NSObject()
public struct FlutterMethodCall {
  public let method: String
  public let arguments: Any?
}
public final class FlutterMethodChannel {
  public static var deltas = 0
  public static var events = [[String: Any]]()
  public init(name: String, binaryMessenger: FlutterBinaryMessenger) {}
  public func setMethodCallHandler(_ handler: ((FlutterMethodCall, @escaping FlutterResult) -> Void)?) {}
  public func invokeMethod(_ method: String, arguments: Any?) { Self.deltas += 1; if let value = arguments as? [String: Any] { Self.events.append(value) } }
}
