import Foundation

enum NovaScheduleCalendar {
  enum Failure: Error { case invalid }
  static func format(_ zone: String) throws -> DateFormatter {
    guard let timezone = TimeZone(identifier: zone) else { throw Failure.invalid }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian); formatter.timeZone = timezone
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"; formatter.isLenient = false
    return formatter
  }
  static func resolve(_ zone: String, _ day: String, _ time: String) throws -> [String: Any] {
    let formatter = try format(zone), utc = try format("UTC"), target = "\(day)T\(time)"
    guard let nominal = utc.date(from: target) else { throw Failure.invalid }
    let offsets = Set(stride(from: -48, through: 48, by: 6).compactMap { hour -> TimeInterval? in
      let probe = nominal.addingTimeInterval(Double(hour) * 3600)
      return utc.date(from: formatter.string(from: probe))?.timeIntervalSince(probe)
    })
    let candidates = offsets.map { nominal.addingTimeInterval(-$0) }.sorted()
    if let instant = candidates.first(where: { formatter.string(from: $0) == target }) { return ["instant": Int64(instant.timeIntervalSince1970 * 1000)] }
    guard var probe = candidates.first, let last = candidates.last else { throw Failure.invalid }
    while probe <= last {
      if formatter.string(from: probe) >= target { return ["gap_at": Int64(probe.timeIntervalSince1970 * 1000)] }
      probe = probe.addingTimeInterval(60)
    }
    return ["gap_at": Int64(last.timeIntervalSince1970 * 1000)]
  }

}
