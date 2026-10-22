import AVFoundation
import Flutter
import UIKit

@MainActor private final class CallPiPViewFactory: NSObject, @preconcurrency FlutterPlatformViewFactory {
    private let pip: CallPictureInPicture
    init(pip: CallPictureInPicture) { self.pip = pip }
    func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
        CallPiPPlatformView(frame: frame, pip: pip)
    }
}

@MainActor private final class CallPiPPlatformView: NSObject, @preconcurrency FlutterPlatformView {
    private let source: CallPiPView
    init(frame: CGRect, pip: CallPictureInPicture) {
        source = CallPiPView(frame: frame)
        super.init()
        source.attached = { [weak pip] view in pip?.attach(view) }
    }
    func view() -> UIView { source }
}

@MainActor public final class NovaAudioPlugin: NSObject, FlutterPlugin {
    private let control: FlutterMethodChannel
    private let companion: FlutterMethodChannel
    private var backgroundCall = false
    private let pip = CallPictureInPicture()
    private let pcm: FlutterBasicMessageChannel
    private let audio = VoiceAudio()
    private var aoq: AOQAudio?
    private var generation: Int?
    private var handoff = CaptureHandoff()
    private var observers: [NSObjectProtocol] = []

    public nonisolated static func register(with registrar: FlutterPluginRegistrar) {
        MainActor.assumeIsolated { registerOnMain(with: registrar) }
    }
    private static func registerOnMain(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: "nova/audio", binaryMessenger: registrar.messenger())
        let pcm = FlutterBasicMessageChannel(name: "nova/audio/pcm", binaryMessenger: registrar.messenger(), codec: FlutterBinaryCodec.sharedInstance())
        let companion = FlutterMethodChannel(name: "nova/voice_companion", binaryMessenger: registrar.messenger())
        let instance = NovaAudioPlugin(control: channel, pcm: pcm, companion: companion)
        registrar.register(CallPiPViewFactory(pip: instance.pip), withId: "nova/voice_pip_source")
        companion.setMethodCallHandler { [weak instance] call, result in
            guard let instance else { result(FlutterError(code: "unavailable", message: "Audio engine unavailable", details: nil)); return }
            MainActor.assumeIsolated { instance.handleCompanion(call, result: result) }
        }
        registrar.addMethodCallDelegate(instance, channel: channel)
    }
    private init(control: FlutterMethodChannel, pcm: FlutterBasicMessageChannel, companion: FlutterMethodChannel) {
        self.control = control; self.pcm = pcm; self.companion = companion
        super.init()
        pip.event = { [weak self] id, action in
            self?.companion.invokeMethod("action", arguments: ["callId": id, "action": action])
        }
        pip.restore = { [weak self] id, completion in
            guard let self else { completion(false); return }
            self.companion.invokeMethod("restore", arguments: ["callId": id]) { value in
                completion((value as? Bool) == true)
            }
        }
        audio.onPCM = { [weak self] data in self?.deliver(data) }
        audio.onLevel = { [weak self] level in self?.event("level", ["level": level]) }
        audio.onControl = { [weak self] value in self?.event("control", ["control": value]) }
        audio.onStopped = { [weak self] reason in self?.fail(reason) }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in guard let self, !self.backgroundCall, (self.audio.running || self.aoq != nil) else { return }; self.fail("Application backgrounded") }
        })
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    private func event(_ kind: String, _ fields: [String: Any] = [:]) {
        guard let generation else { return }
        var value = fields; value["kind"] = kind; value["generation"] = generation
        control.invokeMethod("event", arguments: value)
    }
    private func fail(_ reason: String) {
        if let id = pip.lifetime.id {
            pip.stop(id)
            if backgroundCall { companion.invokeMethod("action", arguments: ["callId": id, "action": "end"]) }
        }
        backgroundCall = false
        aoq?.stop(); aoq = nil; audio.disconnect(); handoff.reset(); event("stopped", ["reason": reason]); generation = nil
    }
    private func handleCompanion(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        guard let id = args["callId"] as? String, !id.isEmpty, id.count <= 128 else {
            result(FlutterError(code: "invalid_call", message: "Missing call identity", details: nil)); return
        }
        switch call.method {
        case "start":
            guard UIApplication.shared.applicationState == .active,
                  AVAudioApplication.shared.recordPermission == .granted,
                  (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?.contains("audio") == true else {
                result(FlutterError(code: "background_unavailable", message: "Start a call in the foreground with microphone permission", details: nil)); return
            }
            backgroundCall = true; pip.start(id); result(nil)
        case "update":
            pip.update(id, muted: args["muted"] as? Bool ?? false,
                       phase: args["status"] as? String ?? "listening",
                       language: args["language"] as? String ?? "zh")
            result(nil)
        case "minimize": pip.minimize(id) { result($0) }
        case "stop":
            if pip.lifetime.id == id { backgroundCall = false; pip.stop(id) }
            result(nil)
        default: result(FlutterMethodNotImplemented)
        }
    }
    public nonisolated func detachFromEngine(for registrar: FlutterPluginRegistrar) {
        MainActor.assumeIsolated {
            if let id = pip.lifetime.id { pip.stop(id) }
            backgroundCall = false
            aoq?.stop(); aoq = nil; audio.disconnect()
            companion.setMethodCallHandler(nil)
        }
    }
    private func deliver(_ data: Data) {
        guard let current = generation else { return }
        guard let ticket = handoff.offer(nowMS: Wire.renderMS) else {
            if handoff.overloaded(nowMS: Wire.renderMS) { fail("Audio handoff stalled") }
            return
        }
        var prefix = Int64(current).bigEndian
        var packet = withUnsafeBytes(of: &prefix) { Data($0) }; packet.append(data)
        pcm.sendMessage(packet) { [weak self] _ in
            Task { @MainActor in guard let self, self.generation == current else { return }; self.handoff.acknowledge(ticket) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in
            guard let self, self.generation == current, self.handoff.overloaded(nowMS: Wire.renderMS) else { return }
            self.fail("Audio handoff stalled")
        }
    }
    public nonisolated func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        MainActor.assumeIsolated { handleOnMain(call, result: result) }
    }
    private func handleOnMain(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        if call.method == "capabilities" { result(["relay": true, "aoq": AOQAudio.available, "aec": "apple_voice_processing"]); return }
        if call.method == "requestMicrophone" {
            AVAudioApplication.requestRecordPermission { granted in DispatchQueue.main.async { result(granted) } }; return
        }
        do {
            let args = call.arguments as? [String: Any] ?? [:]
            if call.method == "startAoq" {
                guard UIApplication.shared.applicationState == .active, AVAudioApplication.shared.recordPermission == .granted,
                      let payload = args["payload"] as? [String: Any] else { throw WireError("AOQ start requires active microphone permission") }
                aoq?.stop(); audio.disconnect(); handoff.reset()
                let id = try Wire.integer(args["generation"]); generation = id
                let adapter = AOQAudio(); aoq = adapter
                adapter.onLevel = { [weak self] level in guard let self, self.generation == id else { return }; self.event("level", ["level": level]) }
                adapter.onReady = { [weak self] in guard let self, self.generation == id else { return }; self.event("aoq_ready") }
                adapter.onFailure = { [weak self] reason in guard let self, self.generation == id else { return }; self.fail(reason) }
                adapter.onCaption = { [weak self] role, text in guard let self, self.generation == id else { return }; self.event("aoq_caption", ["role":role,"text":text]) }
                adapter.onEvent = { [weak self] event in guard let self, self.generation == id else { return }; self.event("aoq_event", ["event":event]) }
                try adapter.start(payload, runtime: args["runtime"] as? Bool ?? false); result(nil); return
            }
            if call.method == "startRelay" {
                guard UIApplication.shared.applicationState == .active,
                      let capture = args["capture"] as? Bool,
                      let threshold = args["threshold"] as? Double, threshold.isFinite, threshold >= 0, threshold <= 1 else { throw WireError("Invalid capture request") }
                aoq?.stop(); aoq = nil; audio.disconnect(); handoff.reset(); generation = try Wire.integer(args["generation"])
                try audio.start(threshold: Float(threshold), capture: capture); result(nil); return
            }
            if call.method == "disconnect" { aoq?.stop(); aoq = nil; audio.disconnect(); handoff.reset(); generation = nil; result(nil); return }
            guard let current = generation, (args["generation"] as? Int) == current else { result(nil); return }
            switch call.method {
            case "aoqCommand":
                guard let event = args["event"] as? [String: Any], let aoq else { throw WireError("AOQ not running") }; try aoq.command(event)
            case "aoqClear": try aoq?.interruptPlayback()
            case "enqueue":
                guard let bytes = args["frame"] as? FlutterStandardTypedData else { throw WireError("Missing audio frame") }
                try audio.receive(Wire.audio(bytes.data))
            case "terminal": audio.terminal(try Wire.identity(args))
            case "clear": audio.clear(try Wire.identity(args))
            case "mute":
                guard let muted = args["muted"] as? Bool else { throw WireError("Invalid mute") }; if let aoq { try aoq.mute(muted) } else { try audio.mute(muted) }
            case "speaker":
                guard let enabled = args["enabled"] as? Bool else { throw WireError("Invalid speaker route") }; if let aoq { try aoq.speaker(enabled) } else { try audio.speaker(enabled) }
            case "stop": aoq?.stop(); aoq = nil; audio.stop(); handoff.reset(); generation = nil
            default: result(FlutterMethodNotImplemented); return
            }
            result(nil)
        } catch {
            aoq?.stop(); aoq = nil; audio.disconnect(); handoff.reset(); generation = nil
            result(FlutterError(code: "audio_failed", message: error.localizedDescription, details: nil))
        }
    }
}
