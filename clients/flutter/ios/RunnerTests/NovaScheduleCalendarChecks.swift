import Foundation
@main struct NovaScheduleCalendarChecks {
 static func main() throws {
  let iso=ISO8601DateFormatter()
  let cases:[(String,String,String,String,String)]=[
   ("America/New_York","2026-03-08","02:30","gap_at","2026-03-08T07:00:00Z"),
   ("America/New_York","2026-11-01","01:30","instant","2026-11-01T05:30:00Z"),
   ("Australia/Lord_Howe","2026-10-04","02:15","gap_at","2026-10-03T15:30:00Z"),
   ("Asia/Kathmandu","2026-10-17","09:00","instant","2026-10-17T03:15:00Z")]
  for(zone,day,time,key,expected) in cases {
   let value=try NovaScheduleCalendar.resolve(zone,day,time)
   precondition(value[key] as? Int64 == Int64(iso.date(from:expected)!.timeIntervalSince1970*1000), "Calendar mismatch: \(zone) \(day)")
  }
  print("4 native calendar cases passed")
 }
}
