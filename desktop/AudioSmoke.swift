import Foundation
import AVFoundation

// Compile with PixelAudio.swift. By default this renders to memory only.
// --device starts an empty graph and prints output latency without playing.
@main
enum PixelAudioSmoke {
    static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }

    static func main() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let path = args.first, !path.hasPrefix("--") else {
            fputs("Usage: AudioSmoke /path/to/sounds [--device]\n", stderr)
            exit(2)
        }
        let deviceOnly = args.contains("--device")
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        let audio = NativePixelAudio(soundDirectory: directory, offline: !deviceOnly)
        var state = audio.snapshot()
        require(state.ready, "Audio must prepare: \(state.lastError ?? "unknown")")
        require(state.cachedBuffers == 21, "All PCM files must be cached once")
        if deviceOnly {
            let values: [String: Any] = ["ready": state.ready, "cachedBuffers": state.cachedBuffers,
                "sampleRate": state.outputSampleRate, "outputPresentationLatencyMs": state.outputPresentationLatency * 1000,
                "outputNodeLatencyMs": state.outputNodeLatency * 1000, "scheduled": state.scheduled,
                "note": "Silent output graph; presentation latency is an OS estimate, not a measured Bluetooth end-to-end latency."]
            let data = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
            print(String(data: data, encoding: .utf8)!)
            return
        }

        for bad: [String: Any] in [
            ["command": "play", "preset": "../click", "event": "move", "volume": 60],
            ["command": "play", "preset": "click", "event": "bogus", "volume": 60],
            ["command": "play", "preset": "click", "event": "move", "volume": true],
            ["command": "play", "preset": "click", "event": "move", "volume": Double.nan],
            ["command": "configure", "volume": 101],
            ["command": "stop", "event": "bogus"], ["command": "untrusted"]
        ] { require(!audio.handle(bad), "Invalid message was accepted: \(bad)") }
        require(audio.snapshot().scheduled == 0, "Invalid input must not schedule sound")
        require(audio.handle(["command": "configure", "volume": 20]), "configure")
        require(abs(audio.snapshot().volume - 0.046) < 0.00001, "Volume must use the .23 headroom gain")
        require(audio.handle(["command": "warm"]), "warm")

        for index in 0..<8 {
            require(audio.handle(["command": "play", "preset": "victory", "event": index < 4 ? "softdrop" : "rotate", "volume": 50]), "play")
        }
        state = audio.snapshot()
        require(state.activeVoices == 8 && state.scheduled == 8, "Independent voices must start together")
        require(audio.handle(["command": "play", "preset": "click", "event": "hold", "volume": 50]), "replacement play")
        state = audio.snapshot()
        require(state.activeVoices == 8 && state.interrupted == 1 && state.scheduled == 9, "A busy pool must replace the oldest voice, not queue")
        require(state.activeEvents.contains("hold"), "The new event must occupy a voice immediately")
        let rendered = try audio.renderSilently()
        let channel = rendered.floatChannelData![0]
        var peak: Float = 0
        for index in 0..<Int(rendered.frameLength) { peak = max(peak, abs(channel[index])) }
        require(peak > 0 && peak < 1, "Cached PCM must render in the first quantum with headroom")

        require(audio.handle(["command": "stop", "event": "softdrop"]), "stop softdrop")
        state = audio.snapshot()
        require(!state.activeEvents.contains("softdrop"), "Contact must cancel all soft-drop tails")
        require(state.activeEvents.contains("rotate") && state.activeEvents.contains("hold"), "Other events must continue")
        let before = state.scheduled
        require(audio.handle(["command": "play", "preset": "tick", "event": "softdrop", "volume": 50]), "new descent")
        require(audio.snapshot().scheduled == before + 1, "A real descent after contact must sound immediately")
        require(audio.handle(["command": "play", "preset": "click", "event": "move", "volume": 0]), "muted play")
        require(audio.snapshot().scheduled == before + 1, "Muted input must not schedule a voice")

        for event in NativePixelAudio.eventIDs { audio.handle(["command": "stop", "event": event]) }
        state = audio.snapshot()
        require(state.activeVoices == 0, "All stopped voices must be released")
        require(state.cachedBuffers == 21, "Playback must not recreate decoded buffers")
        for _ in 0..<4 { _ = try audio.renderSilently() }
        require(audio.snapshot().activeVoices == 0, "Old completion callbacks must not revive voices")

        let sleeping = NativePixelAudio(soundDirectory: directory, offline: true, initiallyEnabled: false)
        state = sleeping.snapshot()
        require(state.ready && !state.enabled && !state.running && state.cachedBuffers == 21, "Disabled startup must cache PCM without running a graph")
        for bad: Any in ["true", 1, NSNull()] {
            require(!sleeping.handle(["command": "configure", "volume": 60, "enabled": bad]), "Enabled must be a real Boolean")
        }
        require(sleeping.handle(["command": "warm"]), "disabled warm")
        require(sleeping.handle(["command": "play", "preset": "click", "event": "move", "volume": 60]), "disabled play")
        require(!sleeping.snapshot().running && sleeping.snapshot().scheduled == 0, "Muted input cannot wake hardware or queue a cue")
        require(sleeping.handle(["command": "configure", "volume": 60, "enabled": true]), "enable")
        require(sleeping.snapshot().running, "Explicit enable must warm before input")
        require(sleeping.handle(["command": "play", "preset": "victory", "event": "harddrop", "volume": 60]), "enabled play")
        let first = try sleeping.renderSilently()
        require((0..<Int(first.frameLength)).contains(where: { abs(first.floatChannelData![0][$0]) > 0.0001 }), "First cue after enable must render in the first quantum")
        sleeping.setApplicationActive(false)
        state = sleeping.snapshot()
        require(!state.running && state.activeVoices == 0 && state.ready && state.cachedBuffers == 21, "Background must release the graph and tails while retaining PCM")
        let scheduledBeforeBackground = state.scheduled
        require(sleeping.handle(["command": "configure", "volume": 60, "enabled": true]), "late web focus")
        require(sleeping.handle(["command": "warm"]), "late web warm")
        require(sleeping.handle(["command": "play", "preset": "click", "event": "move", "volume": 60]), "late background key")
        state = sleeping.snapshot()
        require(!state.running && state.scheduled == scheduledBeforeBackground, "Native background gate must reject late web enable / input")
        sleeping.setApplicationActive(true)
        require(sleeping.snapshot().running, "Foreground entry must prewarm")
        require(sleeping.handle(["command": "play", "preset": "bell", "event": "rotate", "volume": 60]), "foreground play")
        let afterWake = try sleeping.renderSilently()
        require((0..<Int(afterWake.frameLength)).contains(where: { abs(afterWake.floatChannelData![0][$0]) > 0.0001 }), "First foreground cue must render immediately")
        require(sleeping.handle(["command": "configure", "volume": 0, "enabled": true]), "volume zero")
        require(!sleeping.snapshot().running && sleeping.snapshot().activeVoices == 0, "Zero volume must release the graph")
        require(sleeping.handle(["command": "configure", "volume": 60, "enabled": false]), "mute")
        sleeping.setApplicationActive(false)
        sleeping.setApplicationActive(true)
        require(!sleeping.snapshot().running, "Foreground must not override disabled sound")
        for _ in 0..<12 {
            sleeping.handle(["command": "configure", "volume": 60, "enabled": true])
            sleeping.setApplicationActive(false)
            sleeping.handle(["command": "configure", "volume": 60, "enabled": false])
            sleeping.setApplicationActive(true)
        }
        sleeping.handle(["command": "configure", "volume": 60, "enabled": true])
        state = sleeping.snapshot()
        require(state.running && state.activeVoices == 0 && state.cachedBuffers == 21, "Rapid lifecycle changes must preserve caches and discard old tails")
        sleeping.handle(["command": "play", "preset": "tick", "event": "softdrop", "volume": 60])
        let afterRapidChanges = try sleeping.renderSilently()
        require((0..<Int(afterRapidChanges.frameLength)).contains(where: { abs(afterRapidChanges.floatChannelData![0][$0]) > 0.0001 }), "Rapid changes cannot leave the next cue cold or queued")
        print("Native audio smoke passed: 21 PCM caches, first-quantum playback, bounded voices, event stop, invalid input, mute / background lifecycle, late-message gates, rapid wake, silent offline rendering.")
    }
}
