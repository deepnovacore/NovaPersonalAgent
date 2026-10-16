import Foundation

// Runs without a simulator: swiftc LocalTaskJournal.swift this-file -o checks.
@main struct LocalTaskJournalChecks {
  static func main() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: file) }
    var journal = try LocalTaskJournal(file: file)
    let task: [String: Any] = ["id": "t", "goal": "fixture", "acceptance": "one item", "target_package": "nova"]
    _ = try journal.start(task)
    _ = try journal.propose("t", action: ["tool": "life", "input": ["op": "create"]], summary: "create fixture", now: 100)
    let proposal = (journal.task("t")!["proposal"] as! [String: Any])["id"] as! String
    do { _ = try journal.consume("t", proposal: "wrong", now: 101); fatalError("stale approval accepted") } catch {}
    let operation = try journal.consume("t", proposal: proposal, now: 101)
    do { _ = try journal.consume("t", proposal: proposal, now: 102); fatalError("approval reused") } catch {}
    journal = try LocalTaskJournal(file: file)
    assert(journal.task("t")!["phase"] as? String == "interrupted")
    assert((journal.task("t")!["operations"] as! [[String: Any]]).first?["state"] as? String == "unknown")
    let replay = try journal.start(task)
    assert(replay["phase"] as? String == "interrupted")
    var changed = task; changed["goal"] = "different"
    do { _ = try journal.start(changed); fatalError("conflicting task accepted") } catch {}
    let next: [String: Any] = ["id": "t2", "goal": "fixture", "acceptance": "one item", "target_package": "nova"]
    _ = try journal.start(next)
    _ = try journal.propose("t2", action: ["tool": "life"], summary: "fixture", now: 100)
    let expired = (journal.task("t2")!["proposal"] as! [String: Any])["id"] as! String
    do { _ = try journal.consume("t2", proposal: expired, now: 191); fatalError("expired approval accepted") } catch {}
    try journal.end("t2", phase: "cancelled", summary: "stopped")
    do { _ = try journal.consume("t2", proposal: expired, now: 101); fatalError("stopped task acted") } catch {}
    // A late result is evidence, never permission to restart a stopped task.
    try journal.receipt("t", operation: operation, result: ["id": "fixture"])
    assert(journal.task("t")!["phase"] as? String == "interrupted")
    print("LocalTaskJournal: restart, conflict, approval, expiry, stop and late-receipt checks passed")
  }
}
