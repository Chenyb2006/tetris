import Foundation
import CoreFoundation
import AVFoundation

// A fixed voice pool and PCM cached once at startup. Explicit enable / foreground
// messages warm the graph before game input; muted / background apps release it.
final class NativePixelAudio {
    static let presetIDs = ["click", "tick", "pop", "up", "down", "drop", "thud", "clear", "fanfare", "coin", "sparkle", "laser", "zap", "level", "alert", "soft", "bell", "digital", "rewind", "victory", "over"]
    static let eventIDs: Set<String> = ["move", "rotate", "softdrop", "harddrop", "hold", "lock", "clear", "tetris", "tspin", "combo", "perfect", "level", "pause", "resume", "start", "undo", "win", "gameover", "preview"]

    struct Snapshot {
        let ready: Bool
        let enabled: Bool
        let applicationActive: Bool
        let running: Bool
        let cachedBuffers: Int
        let activeVoices: Int
        let scheduled: Int
        let interrupted: Int
        let stopped: Int
        let volume: Float
        let activeEvents: [String]
        let lastError: String?
        let outputPresentationLatency: TimeInterval
        let outputNodeLatency: TimeInterval
        let outputSampleRate: Double
    }

    private final class Voice {
        let player = AVAudioPlayerNode()
        var active = false
        var generation: UInt64 = 0
        var order: UInt64 = 0
        var event = "preview"
    }

    private let queue = DispatchQueue(label: "com.chenyangbin.pixelstack.audio", qos: .userInteractive)
    private let engine = AVAudioEngine()
    private let voices = (0..<8).map { _ in Voice() }
    private var buffers: [String: AVAudioPCMBuffer] = [:]
    private var configurationObserver: NSObjectProtocol?
    private var ready = false
    private var enabled: Bool
    private var applicationActive = true
    private var volume: Float = 0.6
    private var order: UInt64 = 0
    private var scheduled = 0
    private var interrupted = 0
    private var stopped = 0
    private var lastError: String?
    private let offline: Bool
    var onAvailabilityChange: ((Bool) -> Void)?

    init(soundDirectory: URL?, offline: Bool = false, initiallyEnabled: Bool = true) {
        self.offline = offline
        self.enabled = initiallyEnabled
        queue.sync {
            do {
                guard let directory = soundDirectory else { throw AudioError.missingSounds }
                try loadBuffers(directory)
                for voice in voices { engine.attach(voice.player) }
                if offline {
                    try engine.enableManualRenderingMode(.offline, format: buffers[Self.presetIDs[0]]!.format, maximumFrameCount: 512)
                }
                if initiallyEnabled { try startGraph() }
                ready = true
            } catch {
                lastError = String(describing: error)
                ready = false
            }
        }
        if !offline {
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
                guard let self = self else { return }
                self.queue.async { [weak self] in self?.restartAfterConfigurationChange() }
            }
        }
    }

    deinit {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        engine.stop()
    }

    var isReady: Bool { queue.sync { ready } }

    // A native gate makes late web focus messages harmless after app deactivation.
    func setApplicationActive(_ value: Bool) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.applicationActive = value
            self.updateActivity()
        }
    }

    // Validation runs before queuing, including NSNumber's Boolean bridge.
    // Audio graph changes and input commands share one ordered control queue.
    @discardableResult
    func handle(_ body: Any) -> Bool {
        guard let message = body as? [String: Any], let command = message["command"] as? String else { return false }
        switch command {
        case "play":
            guard let preset = message["preset"] as? String, Self.presetIDs.contains(preset),
                  let level = validVolume(message["volume"]) else { return false }
            let event: String
            if message["event"] == nil || message["event"] is NSNull { event = "preview" }
            else if let value = message["event"] as? String, Self.eventIDs.contains(value) { event = value }
            else { return false }
            let issuedAt = DispatchTime.now().uptimeNanoseconds
            queue.async { [weak self] in self?.play(preset: preset, event: event, volume: level, issuedAt: issuedAt) }
        case "stop":
            guard let event = message["event"] as? String, Self.eventIDs.contains(event) else { return false }
            queue.async { [weak self] in self?.stop(event: event) }
        case "configure":
            guard let level = validVolume(message["volume"]) else { return false }
            var requestedEnabled: Bool?
            if let input = message["enabled"] {
                guard let value = input as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
                requestedEnabled = value.boolValue
            }
            let enabled = requestedEnabled
            queue.async { [weak self] in self?.configure(level, enabled: enabled) }
        case "warm":
            queue.async { [weak self] in _ = self?.ensureRunning() }
        default:
            return false
        }
        return true
    }

    func snapshot() -> Snapshot {
        queue.sync {
            Snapshot(ready: ready, enabled: enabled, applicationActive: applicationActive, running: engine.isRunning, cachedBuffers: buffers.count, activeVoices: voices.filter { $0.active }.count,
                     scheduled: scheduled, interrupted: interrupted, stopped: stopped,
                     volume: engine.mainMixerNode.outputVolume, activeEvents: voices.filter { $0.active }.map { $0.event }, lastError: lastError,
                     outputPresentationLatency: offline ? 0 : engine.outputNode.presentationLatency,
                     outputNodeLatency: offline ? 0 : engine.outputNode.latency,
                     outputSampleRate: offline ? engine.manualRenderingFormat.sampleRate : engine.outputNode.inputFormat(forBus: 0).sampleRate)
        }
    }

    // The smoke harness uses manual rendering: no speaker or microphone access.
    func renderSilently(frames: AVAudioFrameCount = 512) throws -> AVAudioPCMBuffer {
        try queue.sync {
            guard offline, ready,
                  let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: frames) else { throw AudioError.notOffline }
            let status = try engine.renderOffline(frames, to: buffer)
            guard status == .success else { throw AudioError.renderFailed }
            return buffer
        }
    }

    private enum AudioError: Error { case missingSounds, invalidSound(String), noOutput, notOffline, renderFailed }

    private func validVolume(_ input: Any?) -> Float? {
        guard let value = input as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let number = value.doubleValue
        guard number.isFinite, number >= 0, number <= 100 else { return nil }
        return Float(number / 100)
    }

    private func loadBuffers(_ directory: URL) throws {
        var format: AVAudioFormat?
        for id in Self.presetIDs {
            let file = try AVAudioFile(forReading: directory.appendingPathComponent(id + ".wav"))
            let current = file.processingFormat
            guard file.length > 0, file.length <= 192_000, current.channelCount == 1,
                  current.sampleRate == 48_000, current.commonFormat == .pcmFormatFloat32,
                  format == nil || (format!.sampleRate == current.sampleRate && format!.channelCount == current.channelCount),
                  let buffer = AVAudioPCMBuffer(pcmFormat: current, frameCapacity: AVAudioFrameCount(file.length)) else { throw AudioError.invalidSound(id) }
            try file.read(into: buffer)
            guard buffer.frameLength == AVAudioFrameCount(file.length) else { throw AudioError.invalidSound(id) }
            buffers[id] = buffer
            format = current
        }
    }

    private func startGraph() throws {
        guard let format = buffers[Self.presetIDs[0]]?.format else { throw AudioError.missingSounds }
        if !offline {
            let output = engine.outputNode.inputFormat(forBus: 0)
            guard output.sampleRate > 0, output.channelCount > 0 else { throw AudioError.noOutput }
        }
        for voice in voices {
            voice.generation &+= 1
            voice.active = false
            voice.player.stop()
            engine.disconnectNodeOutput(voice.player)
            engine.connect(voice.player, to: engine.mainMixerNode, format: format)
        }
        engine.mainMixerNode.outputVolume = volume * 0.23
        engine.prepare()
        try engine.start()
        // Empty player timelines already run before the first key arrives.
        for voice in voices { voice.player.play() }
    }

    private func availability(_ value: Bool, force: Bool = false) {
        guard force || ready != value else { return }
        ready = value
        DispatchQueue.main.async { [weak self] in self?.onAvailabilityChange?(value) }
    }

    private func ensureRunning() -> Bool {
        guard enabled && applicationActive && volume > 0 else { return false }
        guard buffers.count == Self.presetIDs.count else { availability(false, force: true); return false }
        if ready && engine.isRunning { return true }
        do {
            engine.stop()
            try startGraph()
            lastError = nil
            availability(true)
            return true
        } catch {
            lastError = String(describing: error)
            availability(false, force: true)
            return false
        }
    }

    private func restartAfterConfigurationChange() {
        // macOS can stop the graph when the output route/sample rate changes.
        // Keep decoded PCM, rebuild mixer connections, and warm the timelines.
        engine.stop()
        if enabled && applicationActive && volume > 0 { _ = ensureRunning() }
    }

    private func suspendGraph() {
        for voice in voices {
            voice.generation &+= 1
            if voice.active { stopped += 1 }
            voice.active = false
            voice.player.stop()
        }
        engine.stop()
    }

    private func configure(_ value: Float, enabled requestedEnabled: Bool? = nil) {
        volume = value
        if let requestedEnabled = requestedEnabled { enabled = requestedEnabled }
        engine.mainMixerNode.outputVolume = value * 0.23
        updateActivity()
    }

    private func updateActivity() {
        if enabled && applicationActive && volume > 0 { _ = ensureRunning() }
        else if engine.isRunning || voices.contains(where: { $0.active }) { suspendGraph() }
    }

    private func play(preset: String, event: String, volume value: Float, issuedAt: UInt64) {
        volume = value
        engine.mainMixerNode.outputVolume = value * 0.23
        // Route recovery may take longer than an input cue remains useful.
        // Drop stale keys instead of replaying them after hardware wakes up.
        let stale = { DispatchTime.now().uptimeNanoseconds - issuedAt > 60_000_000 }
        guard value > 0, enabled, applicationActive, !stale(), ensureRunning(), !stale(), let buffer = buffers[preset] else { return }
        let voice = voices.first { !$0.active } ?? voices.min { $0.order < $1.order }!
        if voice.active { interrupted += 1; voice.player.stop() }
        voice.generation &+= 1
        let generation = voice.generation
        order &+= 1
        voice.order = order
        voice.event = event
        voice.active = true
        scheduled += 1
        // Never append a new key's sound behind an old sound on a busy node.
        voice.player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionCallbackType: .dataPlayedBack) { [weak self, weak voice] _ in
            guard let self = self, let voice = voice else { return }
            self.queue.async { [weak voice] in
                guard let voice = voice, voice.generation == generation else { return }
                voice.active = false
            }
        }
        if !voice.player.isPlaying { voice.player.play() }
    }

    private func stop(event: String) {
        for voice in voices where voice.active && voice.event == event {
            voice.generation &+= 1
            voice.active = false
            stopped += 1
            voice.player.stop()
            if engine.isRunning { voice.player.play() }
        }
    }
}
