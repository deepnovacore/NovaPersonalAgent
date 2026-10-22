// A call must be ready before PiP can start; dismissing its window is not hangup.
struct CallPiPLifetime {
    private(set) var id: String?
    private(set) var ready = false
    private var dismissed = false
    var automatic: Bool { id != nil && ready && !dismissed }

    mutating func start(_ id: String) {
        self.id = id
        ready = false
        dismissed = false
    }
    mutating func markReady(_ id: String) {
        guard self.id == id else { return }
        ready = true
    }
    mutating func dismiss(_ id: String) {
        guard self.id == id else { return }
        dismissed = true
    }
    mutating func request(_ id: String) -> Bool {
        guard self.id == id, ready else { return false }
        dismissed = false
        return true
    }
    mutating func end(_ id: String) {
        guard self.id == id else { return }
        self.id = nil
        ready = false
        dismissed = false
    }
}
