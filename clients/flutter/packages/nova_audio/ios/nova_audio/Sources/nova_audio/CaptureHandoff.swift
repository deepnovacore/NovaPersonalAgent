import Foundation

struct StartupInputCheck {
    private var silentMS = 0.0
    private var warned = false
    private var finished = false
    mutating func observe(allZero: Bool, durationMS: Double) -> String? {
        guard !finished, durationMS.isFinite, durationMS > 0 else { return nil }
        if !allZero {
            finished = true
            return warned ? "microphone.recovered" : nil
        }
        guard !warned else { return nil }
        silentMS += durationMS
        guard silentMS >= 1000 else { return nil }
        warned = true
        return "microphone.silent"
    }
    mutating func pause() { silentMS = 0 }
}


/// Single in-flight capture buffer; resetting invalidates a delayed Dart reply.
struct CaptureHandoff {
    private var serial = 0
    private var pending: (ticket: Int, since: Double)?
    mutating func offer(nowMS: Double) -> Int? {
        guard pending == nil else { return nil }
        serial += 1; pending = (serial, nowMS); return serial
    }
    mutating func acknowledge(_ ticket: Int) {
        if pending?.ticket == ticket { pending = nil }
    }
    func overloaded(nowMS: Double) -> Bool { pending.map { nowMS - $0.since >= 1000 } ?? false }
    mutating func reset() { serial += 1; pending = nil }
}
