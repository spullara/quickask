import AVFoundation
import OnnxRuntimeBindings

/// Listens for "Quisk" while the app is open, entirely on the device: openWakeWord's mel spectrogram and speech
/// embedding models, then Quisk's own classifier (trained in wakeword/). Every 80 ms of audio gives one score.
@MainActor
final class WakeWord {
    static let shared = WakeWord()
    /// A wake needs `streak` scores in a row above `threshold` (see wakeword/report-v2.json; tested live with listen.py).
    static let threshold: Float = 0.8
    static let streak = 2

    var onWake: () -> Void = {}
    /// Settings → Quisk → Listen for "Quisk" (on by default).
    var enabled: Bool { UserDefaults.standard.object(forKey: "wakeWord") as? Bool ?? true }

    private var engine: AVAudioEngine?
    private var change: NSObjectProtocol?
    private var watchdog: Timer?
    private let detector = Detector()
    private var running = false
    private var paused = false
    private var lastWake = Date.distantPast
    private var run = 0
    /// Each start gets a number, so a slow start that was stopped (or restarted) in the meantime does nothing.
    private var generation = 0

    func start() {
        guard enabled, !running else { return }
        running = true
        generation += 1
        let mine = generation
        Task {
            guard await AVAudioApplication.requestRecordPermission() else { if mine == generation { running = false }; return }
            do {
                try await AudioSession.configure(AudioSession.playAndListen)
                guard running, mine == generation else { return }
                try listen()
            } catch {
                if mine == generation { running = false }
            }
        }
    }

    func stop() {
        running = false
        if let change { NotificationCenter.default.removeObserver(change) }
        change = nil
        watchdog?.invalidate()
        watchdog = nil
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        detector.reset()
    }

    /// While an answer is read aloud: ignore the mic, so Quisk does not hear itself.
    func setPaused(_ on: Bool) {
        paused = on
        run = 0
        if on { detector.reset() }
        // Playing an answer can change the audio session, which silently stops the mic. Listen again from scratch
        // once the answer ends, so follow-ups can start with "Quisk" too.
        else if running { restart() }
    }

    /// A new engine each time: an engine keeps the mic format from when it was made, and dictation or a new route
    /// (AirPods, the car) changes it. A tap with an old format raises "format mismatch" and ends the app.
    private func listen() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let from = input.inputFormat(forBus: 0)
        guard from.sampleRate > 0, from.channelCount > 0,
              let to = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: from, to: to) else { throw NSError(domain: "wakeword", code: 2) }
        let detector = self.detector
        input.installTap(onBus: 0, bufferSize: 4096, format: from) { [weak self] buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / from.sampleRate) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: capacity) else { return }
            var fed = false
            converter.convert(to: out, error: nil) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            guard let ch = out.floatChannelData?[0], out.frameLength > 0 else { return }
            let samples = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength))).map { $0 * 32767 }
            detector.feed(samples) { scores in
                Task { @MainActor in self?.heard(scores) }
            }
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        // The route changed under the engine: listen again with the new format.
        change = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.restart() }
        }
        // Anything else that stops the mic (another app, a call, a session change): no audio for 3 s means listen again.
        detector.heardAudio()
        watchdog = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.running, self.engine != nil, self.detector.silentFor > 3 else { return }
                self.restart()
            }
        }
    }

    private func restart() {
        guard running else { return }
        stop()
        start()
    }

    private func heard(_ scores: [Float]) {
        guard running, !paused else { return }
        for score in scores {
            run = score > Self.threshold ? run + 1 : 0
            guard run >= Self.streak, Date().timeIntervalSince(lastWake) > 2 else { continue }
            run = 0
            lastWake = Date()
            detector.reset()
            onWake()
            return
        }
    }
}

/// The openWakeWord streaming pipeline, ported from openwakeword/utils.py (AudioFeatures._streaming_features).
private final class Detector: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.quisk.wakeword", qos: .userInitiated)
    private var env: ORTEnv?
    private var mel, embed, classify: ORTSession?
    private var pending: [Float] = [], tail: [Float] = [], frames: [[Float]] = [], features: [[Float]] = []

    func reset() { queue.async { self.pending = []; self.tail = []; self.frames = []; self.features = [] } }

    private let lock = NSLock()
    private var lastAudio = Date()
    func heardAudio() { lock.withLock { lastAudio = Date() } }
    /// Seconds since the mic last delivered audio.
    var silentFor: TimeInterval { lock.withLock { Date().timeIntervalSince(lastAudio) } }

    private func load() throws {
        guard mel == nil else { return }
        let env = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(1)
        func session(_ name: String) throws -> ORTSession {
            guard let path = Bundle.main.path(forResource: name, ofType: "onnx") else { throw NSError(domain: "wakeword", code: 1) }
            return try ORTSession(env: env, modelPath: path, sessionOptions: options)
        }
        (self.env, mel, embed, classify) = (env, try session("melspectrogram"), try session("embedding_model"), try session("quisk"))
    }

    private static func floats(_ value: ORTValue?) throws -> [Float] {
        guard let data = try value?.tensorData() as Data? else { return [] }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    private static func tensor(_ values: [Float], _ shape: [Int]) throws -> ORTValue {
        let data = values.withUnsafeBufferPointer { NSMutableData(bytes: $0.baseAddress, length: $0.count * 4) }
        return try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
    }

    /// 16 kHz samples scaled like 16-bit PCM. Calls back with the score of each new 80 ms step, in order.
    func feed(_ samples: [Float], score: @escaping ([Float]) -> Void) {
        heardAudio()
        queue.async {
            do {
                try self.load()
                self.pending += samples
                var scores: [Float] = []
                while self.pending.count >= 1280 {
                    let chunk = Array(self.pending.prefix(1280))
                    self.pending.removeFirst(1280)
                    // Mel frames for this chunk with 480 samples of context (8 frames per 80 ms).
                    let window = self.tail + chunk
                    self.tail = Array(window.suffix(480))
                    let m = try Self.floats(try self.mel!.run(withInputs: ["input": try Self.tensor(window, [1, window.count])],
                                                               outputNames: ["output"], runOptions: nil)["output"])
                    for i in stride(from: 0, to: m.count / 32 * 32, by: 32) { self.frames.append(m[i..<i + 32].map { $0 / 10 + 2 }) }
                    if self.frames.count > 120 { self.frames.removeFirst(self.frames.count - 120) }
                    guard self.frames.count >= 76 else { continue }
                    let e = try Self.floats(try self.embed!.run(withInputs: ["input_1": try Self.tensor(self.frames.suffix(76).flatMap { $0 }, [1, 76, 32, 1])],
                                                                 outputNames: ["conv2d_19"], runOptions: nil)["conv2d_19"])
                    self.features.append(e)
                    if self.features.count > 16 { self.features.removeFirst() }
                    guard self.features.count == 16 else { continue }
                    let s = try Self.floats(try self.classify!.run(withInputs: ["embeddings": try Self.tensor(self.features.flatMap { $0 }, [1, 16, 96])],
                                                                    outputNames: ["score"], runOptions: nil)["score"])
                    scores.append(s.first ?? 0)
                }
                if !scores.isEmpty { score(scores) }
            } catch {}
        }
    }
}
