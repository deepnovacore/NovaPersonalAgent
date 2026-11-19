import Flutter
import UIKit
import AVFoundation
import EventKit

/// Executes one explicit Host action after local permission and user confirmation.
/// It never starts an agent, reads model credentials, or chooses a next action.
@MainActor final class NovaSpaceTools: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  private let channel: FlutterMethodChannel
  private let events = EKEventStore()
  private var cameraReply: FlutterResult?
  private var busy = false

  init(registrar: FlutterPluginRegistrar) {
    channel = FlutterMethodChannel(name: "nova/space_tools", binaryMessenger: registrar.messenger())
    super.init()
    channel.setMethodCallHandler { [weak self] call, reply in
      guard let self else { reply(FlutterError(code: "unavailable", message: nil, details: nil)); return }
      guard UIApplication.shared.applicationState == .active else {
        reply(FlutterError(code: "unavailable", message: "Open the app to use this tool.", details: nil)); return
      }
      guard let input = call.arguments as? [String: Any], let tool = input["tool"] as? String,
            ["calendar.read", "reminder.create", "camera.capture"].contains(tool) else {
        reply(FlutterError(code: "unsupported", message: nil, details: nil)); return
      }
      if call.method == "requestPermission" {
        Task { reply(await self.permission(tool, request: true)) }
      } else if call.method == "execute" {
        guard !self.busy, let id = input["action_id"] as? String, !id.isEmpty, id.count <= 200,
              let args = input["args"] as? [String: Any] else {
          reply(FlutterError(code: "unavailable", message: "Another action is active or the request is invalid.", details: nil)); return
        }
        self.busy = true
        Task {
          guard await self.permission(tool, request: false) else {
            self.finish(reply, error: "permission_denied"); return
          }
          switch tool {
          case "calendar.read": self.readCalendar(args, reply: reply)
          case "reminder.create": self.createReminder(args, reply: reply)
          default: self.capture(reply)
          }
        }
      } else { reply(FlutterMethodNotImplemented) }
    }
  }

  private func permission(_ tool: String, request: Bool) async -> Bool {
    if tool == "camera.capture" {
      let status = AVCaptureDevice.authorizationStatus(for: .video)
      if status == .authorized { return true }
      return request && status == .notDetermined ? await AVCaptureDevice.requestAccess(for: .video) : false
    }
    let type: EKEntityType = tool == "calendar.read" ? .event : .reminder
    let status = EKEventStore.authorizationStatus(for: type)
    if #available(iOS 17.0, *) { if status == .fullAccess { return true } }
    else if status == .authorized { return true }
    guard request, status == .notDetermined else { return false }
    do {
      if #available(iOS 17.0, *) {
        return try await (type == .event ? events.requestFullAccessToEvents() : events.requestFullAccessToReminders())
      }
      return try await withCheckedThrowingContinuation { continuation in
        events.requestAccess(to: type) { granted, error in
          if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: granted) }
        }
      }
    } catch { return false }
  }

  private func presenter() -> UIViewController? {
    guard UIApplication.shared.applicationState == .active else { return nil }
    guard var current = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
      .flatMap({ $0.windows }).first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
    while let next = current.presentedViewController { current = next }
    return current
  }
  private func finish(_ reply: FlutterResult, error: String) {
    busy = false
    reply(FlutterError(code: error, message: nil, details: nil))
  }
  private func readCalendar(_ args: [String: Any], reply: @escaping FlutterResult) {
    let formatter = ISO8601DateFormatter()
    guard Set(args.keys).isSubset(of: ["start", "end"]),
          let startText = args["start"] as? String, let endText = args["end"] as? String,
          let start = NovaSpaceDate.parse(startText), let end = NovaSpaceDate.parse(endText),
          end > start, end.timeIntervalSince(start) <= 366 * 86400 else {
      finish(reply, error: "invalid_arguments"); return
    }
    guard let parent = presenter() else { finish(reply, error: "unavailable"); return }
    let alert = UIAlertController(title: "Share calendar with Host?", message: "Your Host requested events from \(startText) to \(endText).", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.finish(reply, error: "permission_denied") })
    alert.addAction(UIAlertAction(title: "Share", style: .default) { _ in
      let found = self.events.events(matching: self.events.predicateForEvents(withStart: start, end: end, calendars: nil)).sorted { $0.startDate < $1.startDate }
      let items = found.prefix(100).map { event in ["id": event.eventIdentifier ?? "", "title": String((event.title ?? "").prefix(500)),
        "start": formatter.string(from: event.startDate), "end": formatter.string(from: event.endDate)] }
      self.busy = false; reply(["items": items, "truncated": found.count > 100])
    })
    parent.present(alert, animated: true)
  }
  private func createReminder(_ args: [String: Any], reply: @escaping FlutterResult) {
    guard Set(args.keys).isSubset(of: ["title", "due"]), let title = args["title"] as? String,
          !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.count <= 200,
          let parent = presenter(), let calendar = events.defaultCalendarForNewReminders(), calendar.allowsContentModifications else {
      finish(reply, error: "invalid_arguments"); return
    }
    let dueText = args["due"] as? String
    let due = dueText.flatMap { NovaSpaceDate.parse($0) }
    guard args["due"] == nil || args["due"] is NSNull || due != nil else { finish(reply, error: "invalid_arguments"); return }
    let alert = UIAlertController(title: "Create reminder?", message: title + (dueText.map { "\n" + $0 } ?? ""), preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.finish(reply, error: "permission_denied") })
    alert.addAction(UIAlertAction(title: "Create", style: .default) { _ in
      let reminder = EKReminder(eventStore: self.events)
      reminder.title = title; reminder.calendar = calendar
      if let due { reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .timeZone], from: due) }
      do {
        try self.events.save(reminder, commit: true)
        self.busy = false
        reply(["id": reminder.calendarItemIdentifier, "title": title, "due": dueText ?? ""])
      } catch { self.finish(reply, error: "outcome_unknown") }
    })
    parent.present(alert, animated: true)
  }
  private func capture(_ reply: @escaping FlutterResult) {
    guard UIImagePickerController.isSourceTypeAvailable(.camera), let parent = presenter() else { finish(reply, error: "unavailable"); return }
    let picker = UIImagePickerController()
    picker.sourceType = .camera; picker.delegate = self; picker.mediaTypes = ["public.image"]
    cameraReply = reply
    parent.present(picker, animated: true)
  }
  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    if let reply = cameraReply { cameraReply = nil; finish(reply, error: "permission_denied") }
  }
  func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
    picker.dismiss(animated: true)
    guard let reply = cameraReply else { return }; cameraReply = nil
    guard let original = info[.originalImage] as? UIImage else { finish(reply, error: "unavailable"); return }
    let scale = min(1, 640 / max(original.size.width, original.size.height))
    let size = CGSize(width: original.size.width * scale, height: original.size.height * scale)
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { _ in original.draw(in: CGRect(origin: .zero, size: size)) }
    guard let data = thumbnail.jpegData(compressionQuality: 0.4), data.count <= 65536 else { finish(reply, error: "image_too_large"); return }
    busy = false
    reply(["mime": "image/jpeg", "data": data.base64EncodedString(), "width": Int(size.width), "height": Int(size.height)])
  }
}
