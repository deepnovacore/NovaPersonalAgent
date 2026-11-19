// Selection and ownership are separate from permission to send input.
func selectedGUIWindow(focused: UInt32?, main: UInt32?, visible: [UInt32]) -> UInt32? {
    let candidates = Set(visible.filter { $0 > 0 })
    if let focused, candidates.contains(focused) { return focused }
    if let main, candidates.contains(main) { return main }
    return candidates.count == 1 ? candidates.first : nil
}

func owningGUIWindow<Node: Equatable>(_ element: Node, pid: Int32,
    process: (Node) -> Int32?, windowID: (Node) -> UInt32?,
    window: (Node) -> Node?, parent: (Node) -> Node?) -> UInt32? {
    var current: Node? = element, visited: [Node] = []
    for _ in 0..<32 {
        guard let node = current, process(node) == pid, !visited.contains(node) else { return nil }
        visited.append(node)
        if let id = windowID(node), id > 0 { return id }
        if let owner = window(node) {
            guard process(owner) == pid, let id = windowID(owner), id > 0 else { return nil }
            return id
        }
        current = parent(node)
    }
    return nil
}

// AX setters may acknowledge before the remote application's readback catches up.
func confirmedGUIReadback(_ read: () throws -> Bool, pause: () -> Void) rethrows -> Bool {
    let deadline=ContinuousClock.now.advanced(by:.milliseconds(500))
    for attempt in 0..<50 {
        if try read() { return true }
        if attempt==49 || ContinuousClock.now>=deadline { return false }
        pause()
    }
    return false
}
