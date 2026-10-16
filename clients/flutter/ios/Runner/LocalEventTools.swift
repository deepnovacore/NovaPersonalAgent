import Foundation
import EventKit
import CryptoKit

@MainActor final class LocalEventTools {
  private let store = EKEventStore()
  func permission(_ scope: String) async throws {
    let entity: EKEntityType = scope == "calendar" ? .event : .reminder
    let allowed: Bool
    if #available(iOS 17.0, *) {
      allowed = try await (entity == .event ? store.requestFullAccessToEvents() : store.requestFullAccessToReminders())
    } else {
      allowed = try await withCheckedThrowingContinuation { continuation in
        store.requestAccess(to: entity) { granted, error in
          if let error = error { continuation.resume(throwing: error) } else { continuation.resume(returning: granted) }
        }
      }
    }
    guard allowed else { throw LocalAgentError("permission_denied") }
  }
  private func fingerprint(_ value: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: value, options: .sortedKeys)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
  private func event(_ value: EKEvent) -> [String: Any] {
    var row: [String: Any] = ["id": value.eventIdentifier ?? "", "title": value.title ?? "", "note": value.notes ?? "",
      "start": ISO8601DateFormatter().string(from: value.startDate), "end": ISO8601DateFormatter().string(from: value.endDate),
      "calendar_id": value.calendar.calendarIdentifier, "all_day": value.isAllDay,
      "modified_at": value.lastModifiedDate.map { ISO8601DateFormatter().string(from: $0) } ?? "",
      "editable": value.calendar.allowsContentModifications && !value.hasRecurrenceRules && !value.hasAttendees]
    row["version"] = fingerprint(row); return row
  }
  private func reminder(_ value: EKReminder) -> [String: Any] {
    var row: [String: Any] = ["id": value.calendarItemIdentifier, "title": value.title ?? "", "note": value.notes ?? "",
      "completed": value.isCompleted, "calendar_id": value.calendar.calendarIdentifier,
      "editable": value.calendar.allowsContentModifications && !value.hasRecurrenceRules,
      "modified_at": value.lastModifiedDate.map { ISO8601DateFormatter().string(from: $0) } ?? "",
      "due": value.dueDateComponents.flatMap { ($0.calendar ?? Calendar.current).date(from: $0) }.map { ISO8601DateFormatter().string(from: $0) } ?? ""]
    row["version"] = fingerprint(row); return row
  }
  func observe(_ scope: String) async throws -> [String: Any] {
    let type: EKEntityType = scope == "calendar" ? .event : .reminder
    let calendars = store.calendars(for: type).filter { $0.allowsContentModifications }
    let rows: [[String: Any]]
    if type == .event {
      let from = Date(), to = from.addingTimeInterval(30 * 86400)
      rows = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars)).prefix(50).map(event)
    } else {
      let found: [EKReminder] = try await withCheckedThrowingContinuation { continuation in
        store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { values in
          guard let values = values else { continuation.resume(throwing: LocalAgentError("reminders_read_failed")); return }
          continuation.resume(returning: values)
        }
      }
      rows = found.filter { !$0.isCompleted }.prefix(50).map(reminder)
    }
    return ["scope": scope, "items": rows, "limit": 50, "window": scope == "calendar" ? "next_30_days" : "incomplete",
      "calendars": calendars.map { ["id": $0.calendarIdentifier, "title": $0.title] }]
  }
  // Validation runs before approval and immediately before committing the write.
  func validate(_ action: [String: Any], scope: String) throws {
    guard Set(action.keys).isSubset(of: ["tool", "input"]), action["tool"] as? String == scope,
      let input = action["input"] as? [String: Any], let op = input["op"] as? String,
      ["create", "update"].contains(op),
      Set(input.keys).isSubset(of: scope == "calendar" ? ["op", "id", "expected_version", "calendar_id", "title", "note", "start", "end"] : ["op", "id", "expected_version", "calendar_id", "title", "note", "due", "completed"]) else { throw LocalAgentError("invalid_native_action") }
    for (key, limit) in [("title", 200), ("note", 4000)] where input[key] != nil {
      guard let value = input[key] as? String, value.count <= limit, key != "title" || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LocalAgentError("invalid_\(key)") }
    }
    if op == "create" {
      guard input["id"] == nil, input["expected_version"] == nil, input["title"] is String,
        let calendarId = input["calendar_id"] as? String, let calendar = store.calendar(withIdentifier: calendarId),
        calendar.allowsContentModifications, calendar.allowedEntityTypes.contains(scope == "calendar" ? .event : .reminder) else { throw LocalAgentError("calendar_required") }
      if scope == "calendar" {
        guard let start = date(input["start"]), let end = date(input["end"]), end > start else { throw LocalAgentError("invalid_event_dates") }
      }
    } else {
      guard input["calendar_id"] == nil, let id = input["id"] as? String, let expected = input["expected_version"] as? String else { throw LocalAgentError("version_required") }
      let row: [String: Any]
      if scope == "calendar" {
        guard let existing = store.event(withIdentifier: id) else { throw LocalAgentError("item_not_found") }
        row = event(existing)
        let start = input["start"] == nil ? existing.startDate : date(input["start"])
        let end = input["end"] == nil ? existing.endDate : date(input["end"])
        guard let start = start, let end = end, end > start else { throw LocalAgentError("invalid_event_dates") }
      } else {
        guard let existing = store.calendarItem(withIdentifier: id) as? EKReminder else { throw LocalAgentError("item_not_found") }
        row = reminder(existing)
      }
      guard row["editable"] as? Bool == true, row["version"] as? String == expected else { throw LocalAgentError("version_conflict") }
    }
    if input["due"] != nil && date(input["due"]) == nil { throw LocalAgentError("invalid_due") }
    if input["completed"] != nil && CFGetTypeID(input["completed"] as CFTypeRef) != CFBooleanGetTypeID() { throw LocalAgentError("invalid_completed") }
  }
  private func date(_ value: Any?) -> Date? {
    guard let text = value as? String else { return nil }
    return ISO8601DateFormatter().date(from: text)
  }
  func execute(_ action: [String: Any], scope: String) throws -> [String: Any] {
    try validate(action, scope: scope)
    let input = action["input"] as! [String: Any], create = input["op"] as? String == "create"
    if scope == "calendar" {
      guard let value = create ? EKEvent(eventStore: store) : store.event(withIdentifier: input["id"] as! String) else { throw LocalAgentError("item_not_found") }
      if create {
        guard let calendar = store.calendar(withIdentifier: input["calendar_id"] as! String) else { throw LocalAgentError("calendar_required") }
        value.calendar = calendar
      } else if event(value)["version"] as? String != input["expected_version"] as? String { throw LocalAgentError("version_conflict") }
      if let title = input["title"] as? String { value.title = title }
      if let note = input["note"] as? String { value.notes = note }
      if let start = date(input["start"]) { value.startDate = start }
      if let end = date(input["end"]) { value.endDate = end }
      try store.save(value, span: .thisEvent, commit: true)
      return event(value)
    }
    guard let value = create ? EKReminder(eventStore: store) : store.calendarItem(withIdentifier: input["id"] as! String) as? EKReminder else { throw LocalAgentError("item_not_found") }
    if create {
      guard let calendar = store.calendar(withIdentifier: input["calendar_id"] as! String) else { throw LocalAgentError("calendar_required") }
      value.calendar = calendar
    } else if reminder(value)["version"] as? String != input["expected_version"] as? String { throw LocalAgentError("version_conflict") }
    if let title = input["title"] as? String { value.title = title }
    if let note = input["note"] as? String { value.notes = note }
    if let due = date(input["due"]) { value.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .timeZone], from: due) }
    if let completed = input["completed"] as? Bool { value.isCompleted = completed }
    try store.save(value, commit: true)
    return reminder(value)
  }
}
