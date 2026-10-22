import AVFoundation
import UIKit

@main final class PiPTestApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = PiPTestController()
        window?.makeKeyAndVisible()
        return true
    }
}

final class PiPTestController: UIViewController {
    let pip = CallPictureInPicture()
    let engine = AVAudioEngine()
    let source = CallPiPView(frame: .zero)
    let log = UILabel()
    var messages = UserDefaults.standard.stringArray(forKey: "probeEvents") ?? []
    var captureCount = 0, beforeBackground = 0
    var call = 0
    var running = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        source.frame = CGRect(x: 50, y: 100, width: 240, height: 150)
        source.attached = { [weak self] in self?.pip.attach($0) }
        view.addSubview(source)
        log.frame = CGRect(x: 20, y: 420, width: 340, height: 350)
        log.numberOfLines = 0
        log.font = .systemFont(ofSize: 13)
        log.accessibilityIdentifier = "events"
        log.text = messages.suffix(20).joined(separator: "\n")
        view.addSubview(log)
        for (index, name) in ["Start", "Float", "Compact", "End"].enumerated() {
            let button = UIButton(type: .system)
            button.setTitle(name, for: .normal)
            button.accessibilityIdentifier = name
            button.frame = CGRect(x: 20 + index * 85, y: 300, width: 80, height: 50)
            button.addAction(UIAction { [weak self] _ in self?.action(name) }, for: .touchUpInside)
            view.addSubview(button)
        }
        #if PIP_SIZE_PROBE
        for (index, name) in ["Measure", "Half", "Clear", "Wide"].enumerated() {
            let button = UIButton(type: .system)
            button.setTitle(name, for: .normal)
            button.frame = CGRect(x: 20 + index * 85, y: 355, width: 80, height: 45)
            button.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                self.record(self.pip.probeSize(name))
            }, for: .touchUpInside)
            view.addSubview(button)
        }
        #endif
        pip.event = { [weak self] _, event in self?.record(event) }
        pip.restore = { [weak self] _, done in
            self?.record("restored")
            done(self?.view.window != nil)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }
    #if PIP_SIZE_PROBE
    private var experimentStarted = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard ProcessInfo.processInfo.arguments.contains("--size-experiment"), !experimentStarted else { return }
        experimentStarted = true
        let repeatSize = ProcessInfo.processInfo.arguments.contains("--repeat-size")
        let controls = ProcessInfo.processInfo.arguments.contains("--controls-experiment")
        record(controls ? "controlsExperiment" : repeatSize ? "repeatSizeExperiment" : "sizeExperiment")
        let reference = ProcessInfo.processInfo.arguments.contains("--reference-geometry")
        record(reference ? "referenceGeometryExperiment" : "geometryUnchanged")
        let ratios = ProcessInfo.processInfo.arguments.contains("--ratio-sweep")
        if ratios { record("ratioSweepExperiment") }
        let steps: [(Double, String)] = ratios
            ? [(1, "Start"), (4, "Float"), (7, "Measure"), (9, "Square"), (12, "Measure"), (14, "Landscape"), (17, "Measure"), (19, "Portrait"), (22, "Measure"), (24, "Avatar"), (27, "Measure"), (30, "End")]
            : reference
            ? [(1, "Start"), (2, "Reference"), (4, "Float"), (8, "Measure"), (11, "ReferenceTiny"), (14, "Measure"), (17, "Avatar"), (20, "Measure"), (23, "Source"), (26, "Measure"), (30, "End")]
            : controls
            ? [(1, "Start"), (4, "Float"), (7, "Measure"), (20, "Clear"), (23, "Measure"), (38, "End")]
            : repeatSize
            ? [(1, "Start"), (4, "Float"), (7, "Measure"), (9, "End"), (12, "Start"), (15, "Float"), (18, "Measure"), (20, "End")]
            : [(1, "Start"), (4, "Float"), (7, "Measure"), (9, "Half"), (12, "Measure"), (14, "Clear"), (17, "Measure"), (19, "Wide"), (22, "Measure"), (24, "Source"), (28, "Measure"), (30, "End")]
        for (delay, step) in steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                if ["Start", "Float", "End"].contains(step) { self.action(step) }
                else { self.record(self.pip.probeSize(step)) }
            }
        }
    }
    #endif

    func record(_ event: String) {
        print("PIP_PROBE \(event)")
        messages.append(event)
        messages = Array(messages.suffix(100))
        UserDefaults.standard.set(messages, forKey: "probeEvents")
        log.text = messages.suffix(20).joined(separator: "\n")
    }
    @objc func background() { beforeBackground = captureCount }
    @objc func foreground() {
        record(captureCount > beforeBackground ? "backgroundCapturePassed" : "noBackgroundCapture")
    }
    func action(_ name: String) {
        switch name {
        case "Start":
            guard !running else { return }
            AVAudioApplication.requestRecordPermission { [weak self] granted in
                Task { @MainActor in
                    guard let self, granted else { return }
                    do {
                        let session = AVAudioSession.sharedInstance()
                        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
                        try session.setActive(true)
                        self.engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] _, _ in
                            DispatchQueue.main.async { self?.captureCount += 1 }
                        }
                        try self.engine.start()
                        self.running = true
                        self.call += 1
                        self.pip.start(String(self.call))
                        self.pip.update(String(self.call), muted: false, phase: "listening", language: "en")
                    } catch { self.record("audioFailed") }
                }
            }
        case "Float": pip.minimize(String(call)) { [weak self] in self?.record($0 ? "floatSucceeded" : "floatFailed") }
        case "Compact": source.frame.size = CGSize(width: 72, height: 48)
        case "End":
            pip.stop(String(call))
            engine.stop()
            if running { engine.inputNode.removeTap(onBus: 0) }
            running = false
            try? AVAudioSession.sharedInstance().setActive(false)
            record("ended")
        default: break
        }
    }
}
