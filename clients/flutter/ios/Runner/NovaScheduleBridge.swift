import Foundation
import Flutter
import UIKit
import BackgroundTasks
import UserNotifications

/// OS tasks only wake the same durable Dart scheduler. No script execution lane.
final class NovaScheduleBridge {
  static let identifier = "com.nova.mobile.schedule.refresh"
  private static var owner: String?
  private static var channel: FlutterMethodChannel?
  private static var channels: [String: FlutterMethodChannel] = [:]
  private static var headless: FlutterEngine?
  private static var workspace: NovaWorkspaceBridge?
  private static var artifactHost: ArtifactWebHost?
  private static var ownerIsHeadless = false
  private static var ready = false
  private static var completion: ((Bool) -> Void)?
  private static var waitingOwner: (() -> Void)?
  private static var wakeGeneration = 0

  static func register() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
      guard UIApplication.shared.isProtectedDataAvailable else {
        UserDefaults.standard.set("foreground_unlock_required", forKey: "nova.schedule.lastWake")
        task.setTaskCompleted(success: false); schedule(); return
      }
      guard completion == nil else { task.setTaskCompleted(success: false); return }
      wakeGeneration += 1
      let generation = wakeGeneration
      completion = { success in task.setTaskCompleted(success: success); schedule() }
      task.expirationHandler = {
        DispatchQueue.main.async {
          guard wakeGeneration == generation, completion != nil else { return }
          channel?.invokeMethod("expired", arguments: nil)
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if wakeGeneration == generation { finish(false) } }
        }
      }
      if owner == nil {
        let engine = FlutterEngine(name: "nova-schedule", project: nil, allowHeadlessExecution: true)
        headless = engine
        GeneratedPluginRegistrant.register(with: engine)
        install(messenger: engine.binaryMessenger)
        workspace = NovaWorkspaceBridge(messenger: engine.binaryMessenger)
        artifactHost = ArtifactWebHost(messenger: engine.binaryMessenger)
        NovaBackgroundExecution.install(with: engine.binaryMessenger)
        if !engine.run(withEntrypoint: "novaScheduleMain") { finish(false) }
      } else if ready { dispatch() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
        if wakeGeneration == generation, completion != nil {
          channel?.invokeMethod("expired", arguments: nil)
          DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if wakeGeneration == generation { finish(false) } }
        }
      }
    }
  }
  static func install(messenger: FlutterBinaryMessenger) {
    NovaSpaceScope.install(messenger: messenger)
    let id = UUID().uuidString
    let candidate = FlutterMethodChannel(name: "nova/schedule/v1", binaryMessenger: messenger)
    channels[id] = candidate
    candidate.setMethodCallHandler { call, reply in
      let args = call.arguments as? [String: Any] ?? [:]
      do {
        switch call.method {
        case "localDay":
          guard let zone = args["timezone"] as? String, let instant = args["instant"] as? NSNumber else { throw Failure.invalid }
          reply(String(try NovaScheduleCalendar.format(zone).string(from: Date(timeIntervalSince1970: instant.doubleValue / 1000)).prefix(10)))
        case "resolve":
          guard let zone = args["timezone"] as? String, let day = args["date"] as? String, let time = args["time"] as? String else { throw Failure.invalid }
          reply(try NovaScheduleCalendar.resolve(zone, day, time))
        case "acquire":
          let acquire = { owner = id; channel = candidate; ready = false; ownerIsHeadless = args["headless"] as? Bool == true; reply(true) }
          if owner == nil || owner == id { acquire() }
          else if ownerIsHeadless && waitingOwner == nil { waitingOwner = acquire }
          else { reply(false) }
        case "ready":
          guard owner == id else { throw Failure.invalid }
          ready = true; reply(nil); if completion != nil { dispatch() }
        case "configure":
          guard owner == id else { throw Failure.invalid }
          UserDefaults.standard.set(args["enabled"] as? Bool == true, forKey: "nova.schedule.enabled")
          schedule(); reply(nil)
        case "release":
          if owner == id { release() }; channels.removeValue(forKey: id); reply(nil)
        case "requestNotifications":
          UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in DispatchQueue.main.async { reply(nil) } }
        case "notifyWaiting":
          let content = UNMutableNotificationContent()
          content.title = "Nova 定时任务需要确认"; content.body = "打开应用查看当前状态，未自动批准操作。"
          UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "nova.schedule.waiting", content: content, trigger: nil))
          reply(nil)
        default: reply(FlutterMethodNotImplemented)
        }
      } catch { reply(FlutterError(code: "schedule_unavailable", message: "Schedule operation unavailable", details: nil)) }
    }
  }
  private static func schedule() {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
    guard UserDefaults.standard.bool(forKey: "nova.schedule.enabled") else { return }
    let request = BGAppRefreshTaskRequest(identifier: identifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    do { try BGTaskScheduler.shared.submit(request) }
    catch { UserDefaults.standard.set("background_unavailable", forKey: "nova.schedule.lastWake") }
  }
  private static func dispatch() {
    let generation = wakeGeneration
    channel?.invokeMethod("wake", arguments: nil) { value in
      guard generation == wakeGeneration else { return }
      finish((value as? [String: Any])?["finished"] as? Bool == true)
    }
  }
  private static func finish(_ success: Bool) {
    guard let done = completion else { return }
    completion = nil
    UserDefaults.standard.set(success ? "wake_returned" : "interrupted", forKey: "nova.schedule.lastWake")
    done(success)
    if ownerIsHeadless || owner == nil {
      let engine = headless; headless = nil
      if let id = owner { channels.removeValue(forKey: id) }
      workspace = nil; artifactHost = nil
      if let engine { NovaSpaceScope.uninstall(messenger: engine.binaryMessenger) }
      engine?.destroyContext(); release()
    }
  }
  private static func release() {
    owner = nil; channel = nil; ready = false; ownerIsHeadless = false
    let waiting = waitingOwner; waitingOwner = nil; waiting?()
  }
  enum Failure: Error { case invalid }
}
