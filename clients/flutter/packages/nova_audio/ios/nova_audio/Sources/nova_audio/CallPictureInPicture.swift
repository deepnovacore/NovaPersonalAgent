@preconcurrency import AVKit
import UIKit
#if PIP_SIZE_PROBE
import ObjectiveC
#endif

@MainActor final class CallPiPView: UIView {
    var attached: ((CallPiPView) -> Void)?
    private let orb = UIView()
    private let avatar = UIImageView()
    private let ring = CAShapeLayer()
    private let badge = UIImageView(image: UIImage(systemName: "mic.slash.fill"))
    private let status = UILabel()
    private var muted = false
    private let live = UIColor(red: 76/255, green: 175/255, blue: 125/255, alpha: 1)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .white
        layer.cornerRadius = 10
        clipsToBounds = true
        orb.backgroundColor = .white
        avatar.backgroundColor = UIColor(red: 190/255, green: 232/255, blue: 212/255, alpha: 1)
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle.main
        #endif
        avatar.image = UIImage(named: "nova_orb_avatar", in: bundle, compatibleWith: nil)
        avatar.contentMode = .scaleAspectFill
        if avatar.image == nil {
            avatar.image = UIImage(systemName: "mic.fill")
            avatar.contentMode = .scaleAspectFit
        }
        avatar.tintColor = UIColor(red: 29/255, green: 45/255, blue: 39/255, alpha: 1)
        avatar.clipsToBounds = true
        ring.fillColor = UIColor.clear.cgColor
        ring.lineWidth = 3
        orb.addSubview(avatar)
        orb.layer.addSublayer(ring)
        badge.backgroundColor = UIColor(red: 200/255, green: 84/255, blue: 80/255, alpha: 1)
        badge.tintColor = .white
        badge.contentMode = .center
        badge.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
        badge.layer.borderColor = UIColor.white.cgColor
        badge.layer.borderWidth = 2
        orb.addSubview(badge)
        addSubview(orb)
        status.font = .systemFont(ofSize: 11, weight: .medium)
        status.textColor = avatar.tintColor
        status.textAlignment = .center
        status.adjustsFontSizeToFitWidth = true
        status.minimumScaleFactor = 0.7
        addSubview(status)
        isAccessibilityElement = true
        NotificationCenter.default.addObserver(self, selector: #selector(updatePulse), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
        update(muted: false, phase: "listening", language: "zh")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        let compact = bounds.height < 56
        let captionHeight: CGFloat = compact ? 0 : 18
        let diameter = max(0, min(bounds.width - 8, bounds.height - 8 - captionHeight))
        orb.frame = CGRect(x: (bounds.width - diameter)/2, y: (bounds.height - diameter - captionHeight)/2, width: diameter, height: diameter)
        orb.layer.cornerRadius = diameter/2
        avatar.frame = orb.bounds.insetBy(dx: 4, dy: 4)
        avatar.layer.cornerRadius = avatar.bounds.width/2
        ring.frame = orb.bounds
        ring.path = UIBezierPath(ovalIn: orb.bounds.insetBy(dx: 2, dy: 2)).cgPath
        badge.frame = CGRect(x: diameter - 20, y: diameter - 20, width: 20, height: 20)
        badge.layer.cornerRadius = 10
        status.isHidden = compact
        status.frame = CGRect(x: 4, y: orb.frame.maxY + 2, width: max(0, bounds.width - 8), height: 16)
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        updatePulse()
        if window != nil { attached?(self) }
    }
    @objc private func updatePulse() {
        ring.removeAnimation(forKey: "breathing")
        ring.strokeColor = (muted ? UIColor(red: 176/255, green: 181/255, blue: 186/255, alpha: 1) : live).cgColor
        guard window != nil, !muted, !UIAccessibility.isReduceMotionEnabled else { return }
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1
        pulse.toValue = 0.45
        pulse.duration = 1.8
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        ring.add(pulse, forKey: "breathing")
    }
    func update(muted: Bool, phase: String, language: String) {
        let changed = self.muted != muted
        self.muted = muted
        badge.isHidden = !muted
        let zh = language == "zh"
        if muted {
            status.text = zh ? "麦克风已静音" : "Microphone muted"
        } else {
            switch phase {
            case "speaking": status.text = zh ? "正在回应" : "Speaking"
            case "thinking": status.text = zh ? "正在思考" : "Thinking"
            default: status.text = zh ? "我在听" : "Listening"
            }
        }
        if changed || ring.animation(forKey: "breathing") == nil { updatePulse() }
        accessibilityLabel = "Nova · \(status.text ?? "")"
    }
}

// Owns presentation only. Audio continues through the existing VoiceAudio session.
@MainActor final class CallPictureInPicture: NSObject, @preconcurrency AVPictureInPictureControllerDelegate {
    var event: ((String, String) -> Void)?
    var restore: ((String, @escaping (Bool) -> Void) -> Void)?
    private(set) var lifetime = CallPiPLifetime()
    private weak var source: CallPiPView?
    #if PIP_SIZE_PROBE
    private var contentTypeProbe: PiPContentTypeProbe?
    #endif
    private var controller: AVPictureInPictureController?
    private var content = AVPictureInPictureVideoCallViewController()
    private var picture = CallPiPView(frame: .zero)
    private var possible: NSKeyValueObservation?
    private var pendingStart: ((Bool) -> Void)?
    private var startTimeout: DispatchWorkItem?
    private var pendingRestore: ((Bool) -> Void)?
    private var restoreTimeout: DispatchWorkItem?
    private var restoring = false
    private var restoreSequence = 0
    private var muted = false, phase = "listening", language = "zh"

    private func resetContent() {
        // AVKit presentation state belongs to one call, even after its controller stops.
        content = AVPictureInPictureVideoCallViewController()
        picture = CallPiPView(frame: .zero)
        content.preferredContentSize = CGSize(width: 88, height: 104)
        picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        picture.frame = content.view.bounds
        content.view.addSubview(picture)
    }

    #if PIP_SIZE_PROBE
    private func probeController(_ source: AVPictureInPictureController.ContentSource, id: String) -> AVPictureInPictureController? {
        guard ProcessInfo.processInfo.arguments.contains("--construction-style=5") else {
            return AVPictureInPictureController(contentSource: source)
        }
        // Source hypothesis: GlobalRefresh-PiP/PiPCoexistenceExperiment.swift construction policy.
        let selector = NSSelectorFromString("_proxyControlsStyle")
        guard let adapterClass = NSClassFromString("AVPictureInPicturePlatformAdapter"),
              let method = class_getInstanceMethod(adapterClass, selector),
              method_getNumberOfArguments(method) == 2 else {
            event?(id, "constructionStyleUnavailable"); return nil
        }
        let returnType = method_copyReturnType(method)
        defer { free(returnType) }
        guard String(cString: returnType) == "q" else {
            event?(id, "constructionStyleSignatureMismatch"); return nil
        }
        typealias Getter = @convention(c) (AnyObject, Selector) -> Int
        let original = method_getImplementation(method)
        let getter = unsafeBitCast(original, to: Getter.self)
        var captured: AnyObject?
        var hits = 0
        let replacement: @convention(block) (AnyObject) -> Int = { object in
            guard Thread.isMainThread else { return getter(object, selector) }
            if captured == nil { captured = object }
            guard captured === object else { return getter(object, selector) }
            hits += 1
            return 5
        }
        // shortcut: probe-only synchronous hook; no other controller construction runs during this call.
        let implementation = imp_implementationWithBlock(replacement)
        method_setImplementation(method, implementation)
        let result = AVPictureInPictureController(contentSource: source)
        method_setImplementation(method, original)
        // Keep the replacement allocated for any concurrent invocation already in flight.
        guard let cls = object_getClass(result),
              let ivar = class_getInstanceVariable(cls, "_platformAdapter"),
              let encoding = ivar_getTypeEncoding(ivar), encoding.pointee == 64,
              let adapter = object_getIvar(result, ivar) as? NSObject, captured === adapter, hits > 0 else {
            event?(id, "constructionStyleCaptureMismatch"); return nil
        }
        event?(id, "constructionStyleApplied=5 hits=\(hits)")
        return result
    }

    func probeSize(_ mode: String) -> String {
        switch mode {
        case "Square": content.preferredContentSize = CGSize(width: 100, height: 100)
        case "Landscape": content.preferredContentSize = CGSize(width: 200, height: 100)
        case "Portrait": content.preferredContentSize = CGSize(width: 50, height: 200)
        case "Reference":
            content.preferredContentSize = CGSize(width: 200, height: 44)
            source?.frame.size = content.preferredContentSize
        case "ReferenceTiny":
            content.preferredContentSize = CGSize(width: 200, height: 0.1)
            source?.frame.size = content.preferredContentSize
        case "Avatar":
            content.preferredContentSize = CGSize(width: 88, height: 104)
            source?.frame.size = content.preferredContentSize
        case "Half": content.preferredContentSize = CGSize(width: 44, height: 52)
        case "Wide": content.preferredContentSize = CGSize(width: 300, height: 44)
        case "Source":
            content.preferredContentSize = CGSize(width: 44, height: 52)
            source?.frame.size = CGSize(width: 44, height: 52)
            source?.superview?.layoutIfNeeded()
        case "Clear":
            content.view.backgroundColor = .clear
            content.view.isOpaque = false
            content.view.layer.backgroundColor = UIColor.clear.cgColor
            picture.backgroundColor = .clear
            picture.isOpaque = false
            picture.layer.backgroundColor = UIColor.clear.cgColor
            picture.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
            picture.frame = CGRect(x: (content.view.bounds.width - 88)/2, y: (content.view.bounds.height - 104)/2, width: 88, height: 104)
        default: break
        }
        content.view.setNeedsLayout()
        content.view.layoutIfNeeded()
        return "\(mode): preferred \(content.preferredContentSize), actual \(content.view.bounds.size)"
    }
    #endif

    func start(_ id: String) {
        if let old = lifetime.id { stop(old) }
        resetContent()
        lifetime.start(id)
        event?(id, AVPictureInPictureController.isPictureInPictureSupported() ? "pipSupported" : "pipUnsupported")
    }
    func attach(_ view: CallPiPView) {
        source = view
        view.update(muted: muted, phase: phase, language: language)
        configure()
    }
    func update(_ id: String, muted: Bool, phase: String, language: String) {
        guard lifetime.id == id else { return }
        lifetime.markReady(id)
        self.muted = muted; self.phase = phase; self.language = language
        source?.update(muted: muted, phase: phase, language: language)
        picture.update(muted: muted, phase: phase, language: language)
        configure()
    }
    private func configure() {
        guard lifetime.ready, let id = lifetime.id, let source, source.window != nil,
              AVPictureInPictureController.isPictureInPictureSupported() else { return }
        if controller == nil {
            let contentSource = AVPictureInPictureController.ContentSource(activeVideoCallSourceView: source, contentViewController: content)
            #if PIP_SIZE_PROBE
            guard let next = probeController(contentSource, id: id) else { return }
            #else
            let next = AVPictureInPictureController(contentSource: contentSource)
            #endif
            #if PIP_SIZE_PROBE
            let arguments = ProcessInfo.processInfo.arguments
            if arguments.contains("--content-type-transition") {
                let probe = PiPContentTypeProbe()
                guard probe.prepare(next) else { event?(id, "contentTypePrepareFailed"); return }
                contentTypeProbe = probe
                event?(id, probe.summary)
                event?(id, probe.geometryInterfaces)
            }
            if let argument = arguments.first(where: { $0.hasPrefix("--controls-style=") }),
               let style = Int(argument.dropFirst("--controls-style=".count)), [1, 2].contains(style) {
                // shortcut: private KVC is probe-only; validate each OS before considering product use.
                if next.responds(to: NSSelectorFromString("setControlsStyle:")) {
                    next.setValue(style, forKey: "controlsStyle")
                    event?(id, "controlsStyleApplied=\(style)")
                } else { event?(id, "controlsStyleSetterUnavailable") }
            } else { event?(id, "controlsStyleDefault") }
            #endif
            controller = next
            next.delegate = self
            possible = next.observe(\.isPictureInPicturePossible, options: [.initial, .new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self, let next = self.controller, self.lifetime.id == id else { return }
                    self.event?(id, next.isPictureInPicturePossible ? "pipReady" : "pipUnavailable")
                }
            }
        } else if controller?.isPictureInPictureActive == false,
                  controller?.contentSource?.activeVideoCallSourceView !== source {
            controller?.contentSource = .init(activeVideoCallSourceView: source, contentViewController: content)
        }
        controller?.canStartPictureInPictureAutomaticallyFromInline = lifetime.automatic
    }
    func minimize(_ id: String, completion: @escaping (Bool) -> Void) {
        guard lifetime.request(id) else { completion(false); return }
        configure()
        guard let controller, controller.isPictureInPicturePossible, pendingStart == nil else {
            completion(false); return
        }
        if controller.isPictureInPictureActive { completion(true); return }
        pendingStart = completion
        let timeout = DispatchWorkItem { [weak self, weak controller] in
            guard let self, let controller, self.controller === controller, self.lifetime.id == id else { return }
            self.finishStart(false)
            self.event?(id, "pipFailed")
        }
        startTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timeout)
        controller.startPictureInPicture()
    }
    private func finishStart(_ success: Bool) {
        startTimeout?.cancel(); startTimeout = nil
        let completion = pendingStart; pendingStart = nil
        completion?(success)
    }
    private func finishRestore(_ success: Bool) {
        restoreSequence += 1
        restoreTimeout?.cancel(); restoreTimeout = nil
        let completion = pendingRestore; pendingRestore = nil
        if completion != nil && !success { restoring = false }
        completion?(success)
    }
    func stop(_ id: String) {
        guard lifetime.id == id else { return }
        lifetime.end(id)
        finishStart(false)
        finishRestore(false)
        possible = nil
        controller?.canStartPictureInPictureAutomaticallyFromInline = false
        controller?.delegate = nil
        controller?.stopPictureInPicture()
        #if PIP_SIZE_PROBE
        contentTypeProbe?.clear(); contentTypeProbe = nil
        #endif
        controller?.contentSource = nil
        controller = nil
        restoring = false
    }
    func pictureInPictureControllerDidStartPictureInPicture(_ pip: AVPictureInPictureController) {
        guard controller === pip, let id = lifetime.id else { return }
        finishStart(true)
        event?(id, "pipActive")
        #if PIP_SIZE_PROBE
        if let probe = contentTypeProbe {
            _ = probe.apply(4)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak pip, weak probe] in
                guard let self, let pip, let probe, self.controller === pip,
                      self.lifetime.id == id, pip.isPictureInPictureActive, !pip.isPictureInPictureSuspended else { return }
                self.event?(id, probe.apply(6) ? probe.summary : "contentTypeTransitionFailed")
            }
        }
        #endif
    }
    func pictureInPictureController(_ pip: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        guard controller === pip, let id = lifetime.id else { return }
        finishStart(false)
        event?(id, "pipFailed")
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ pip: AVPictureInPictureController) {
        guard controller === pip, let id = lifetime.id else { return }
        // shortcut: AVKit gives no stop reason; suppress non-restoration stops until a public dismissal reason is available.
        if !restoring { lifetime.dismiss(id) }
        pip.canStartPictureInPictureAutomaticallyFromInline = lifetime.automatic
        restoring = false
        finishStart(false)
        event?(id, "pipInactive")
        configure()
    }
    func pictureInPictureController(_ pip: AVPictureInPictureController,
                                    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        guard controller === pip, let id = lifetime.id, let restore else { completionHandler(false); return }
        finishRestore(false)
        restoring = true
        pendingRestore = completionHandler
        let request = restoreSequence
        let timeout = DispatchWorkItem { [weak self] in self?.finishRestore(false) }
        restoreTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timeout)
        restore(id) { [weak self, weak pip] restored in
            guard let self, let pip, self.controller === pip, self.lifetime.id == id, self.restoreSequence == request else { return }
            self.finishRestore(restored)
        }
    }
}

#if PIP_SIZE_PROBE
// Probe follows GlobalRefresh-PiP's early provider and post-start content-type sequence.
private final class PiPContentTypeProbe: NSObject {
    private static var key: UInt8 = 0
    private static var installed = Set<ObjectIdentifier>()
    private let lock = NSLock()
    private var requested = 4
    private var calls = 0
    private weak var adapter: NSObject?
    private weak var proxy: NSObject?
    typealias Getter = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
    typealias IntGetter = @convention(c) (AnyObject, Selector) -> Int
    typealias Setter = @convention(c) (AnyObject, Selector, Int) -> Void
    typealias Mutation = @convention(block) (AnyObject) -> Void
    typealias Updater = @convention(c) (AnyObject, Selector, Mutation) -> Void

    static func method(_ type: AnyClass, _ name: String, _ result: String, _ arguments: [String] = []) -> Method? {
        guard let m = class_getInstanceMethod(type, NSSelectorFromString(name)),
              method_getNumberOfArguments(m) == arguments.count + 2 else { return nil }
        let r = method_copyReturnType(m)
        defer { free(r) }
        guard String(cString: r) == result else { return nil }
        for (i, expected) in arguments.enumerated() {
            guard let a = method_copyArgumentType(m, UInt32(i + 2)) else { return nil }
            let actual = String(cString: a); free(a)
            guard actual == expected else { return nil }
        }
        return m
    }
    static func object(_ owner: NSObject, _ name: String) -> NSObject? {
        guard let cls = object_getClass(owner), let m = method(cls, name, "@") else { return nil }
        return unsafeBitCast(method_getImplementation(m), to: Getter.self)(owner, NSSelectorFromString(name))?.takeUnretainedValue() as? NSObject
    }
    static func install(_ cls: AnyClass) -> Bool {
        if installed.contains(ObjectIdentifier(cls)) { return true }
        let provider = NSSelectorFromString("pictureInPictureProxyContentType:")
        guard class_getInstanceMethod(cls, provider) == nil,
              let responds = method(cls, "respondsToSelector:", "B", [":"]),
              let encoding = method_getTypeEncoding(responds) else { return false }
        typealias Responds = @convention(c) (AnyObject, Selector, Selector) -> Bool
        let original = unsafeBitCast(method_getImplementation(responds), to: Responds.self)
        let response: @convention(block) (AnyObject, Selector) -> Bool = { object, selector in
            if selector == provider { return objc_getAssociatedObject(object, &key) is PiPContentTypeProbe }
            return original(object, NSSelectorFromString("respondsToSelector:"), selector)
        }
        let value: @convention(block) (AnyObject, AnyObject?) -> Int = { object, queried in
            guard let probe = objc_getAssociatedObject(object, &key) as? PiPContentTypeProbe else { return 4 }
            probe.lock.lock(); defer { probe.lock.unlock() }
            if probe.proxy == nil { probe.proxy = queried as? NSObject }
            guard queried === probe.proxy else { return 4 }
            probe.calls += 1
            return probe.requested
        }
        let imp = imp_implementationWithBlock(value)
        guard class_addMethod(cls, provider, imp, "q@:@") else { imp_removeBlock(imp); return false }
        class_replaceMethod(cls, NSSelectorFromString("respondsToSelector:"), imp_implementationWithBlock(response), encoding)
        installed.insert(ObjectIdentifier(cls))
        return true
    }
    func prepare(_ controller: AVPictureInPictureController) -> Bool {
        guard let a = Self.object(controller, "platformAdapter"), let cls = object_getClass(a),
              Self.install(cls) else { return false }
        adapter = a
        objc_setAssociatedObject(a, &Self.key, self, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        guard let p = Self.object(a, "pegasusProxy"),
              let expected = NSClassFromString("PGPictureInPictureProxy"), p.isKind(of: expected),
              proxy == nil || proxy === p else { clear(); return false }
        proxy = p
        guard apply(4) else { clear(); return false }
        return true
    }
    func apply(_ value: Int) -> Bool {
        guard let a = adapter, objc_getAssociatedObject(a, &Self.key) as? PiPContentTypeProbe === self,
              let p = proxy, let pc = object_getClass(p),
              let update = Self.method(pc, "updatePlaybackStateUsingBlock:", "v", ["@?"]),
              let state = Self.object(p, "playbackState"), let sc = object_getClass(state),
              let setter = Self.method(sc, "setContentType:", "v", ["q"]) else { return false }
        lock.lock(); requested = value; lock.unlock()
        let mutation: Mutation = { [weak self, weak a] current in
            guard let self, let a, objc_getAssociatedObject(a, &Self.key) as? PiPContentTypeProbe === self,
                  object_getClass(current) === sc else { return }
            unsafeBitCast(method_getImplementation(setter), to: Setter.self)(current, NSSelectorFromString("setContentType:"), value)
        }
        unsafeBitCast(method_getImplementation(update), to: Updater.self)(p, NSSelectorFromString("updatePlaybackStateUsingBlock:"), mutation)
        return true
    }
    var geometryInterfaces: String {
        var result = [String]()
        for owner in [adapter, proxy].compactMap({ $0 }) {
            guard var cls = object_getClass(owner) else { continue }
            if NSStringFromClass(cls).hasPrefix("NSKVONotifying_"), let base = class_getSuperclass(cls) { cls = base }
            var count: UInt32 = 0
            guard let methods = class_copyMethodList(cls, &count) else { continue }
            defer { free(methods) }
            let names = (0..<Int(count)).compactMap { index -> String? in
                let name = NSStringFromSelector(method_getName(methods[index]))
                return ["size", "frame", "layout", "style", "window"].contains(where: { name.lowercased().contains($0) }) ? name : nil
            }
            result.append("\(NSStringFromClass(cls)): \(names.sorted().joined(separator: ","))")
        }
        return result.joined(separator: " | ")
    }
    var summary: String {
        lock.lock(); let count = calls; let value = requested; lock.unlock()
        guard let p = proxy, let s = Self.object(p, "playbackState"), let cls = object_getClass(s),
              let m = Self.method(cls, "contentType", "q") else { return "contentTypeUnknown" }
        let actual = unsafeBitCast(method_getImplementation(m), to: IntGetter.self)(s, NSSelectorFromString("contentType"))
        return "contentType requested=\(value) local=\(actual) providerCalls=\(count)"
    }
    func clear() {
        _ = apply(4)
        if let a = adapter { objc_setAssociatedObject(a, &Self.key, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
        adapter = nil; proxy = nil
    }
}
#endif
