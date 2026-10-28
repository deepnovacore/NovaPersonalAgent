import Foundation

@main enum SpaceDateChecks {
  static func main() {
    let plain = NovaSpaceDate.parse("2026-10-24T08:00:00Z")
    precondition(plain != nil)
    precondition(NovaSpaceDate.parse("2026-10-24T08:00:00.000Z") == plain)
    precondition(NovaSpaceDate.parse("2026-10-24T08:00:00.123Z") != nil)
    precondition(NovaSpaceDate.parse("not-a-date") == nil)
    print("PASS Host ISO timestamps with and without fractional seconds")
  }
}
