import Foundation
import WebKit
import OnnxRuntimeBindings

/// tiny-voca, shipped in the app: phoneme ids in, 24 kHz speech out (ONNX Runtime on the CPU). Loaded in the
/// background at launch, so the first answer does not wait for it.
final class NativeVoice: @unchecked Sendable {
    static let shared = NativeVoice()
    private let queue = DispatchQueue(label: "ai.quisk.voice", qos: .userInitiated)
    private var env: ORTEnv?
    private var session: ORTSession?

    func preload() { queue.async { _ = try? self.load() } }

    private func load() throws -> ORTSession {
        if let session { return session }
        guard let path = Bundle.main.path(forResource: "tiny-voca", ofType: "onnx") else { throw Missing() }
        let env = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(2)
        let session = try ORTSession(env: env, modelPath: path, sessionOptions: options)
        self.env = env
        self.session = session
        return session
    }

    struct Missing: Error {}

    private static func tensor<T>(_ values: [T], _ type: ORTTensorElementDataType, _ shape: [NSNumber]) throws -> ORTValue {
        let data = values.withUnsafeBufferPointer { NSMutableData(bytes: $0.baseAddress, length: $0.count * MemoryLayout<T>.stride) }
        return try ORTValue(tensorData: data, elementType: type, shape: shape)
    }

    /// Sentences as phoneme ids and stress (from /api/phonemes) -> one WAV file, with a short pause after each sentence.
    func speak(_ sentences: [(ids: [Int64], stress: [Int64])], voice: Int64) async throws -> Data {
        try await withCheckedThrowingContinuation { done in
            queue.async {
                do {
                    let session = try self.load()
                    var samples: [Float] = []
                    for s in sentences where !s.ids.isEmpty {
                        let ids = Array(s.ids.prefix(512)), stress = Array(s.stress.prefix(512))
                        let n = NSNumber(value: ids.count)
                        let out = try session.run(withInputs: [
                            "tokens": try Self.tensor(ids, .int64, [1, n]),
                            "stress": try Self.tensor(stress, .int64, [1, n]),
                            "voice": try Self.tensor([voice], .int64, [1]),
                            "speed": try Self.tensor([Float(1)], .float, [1]),
                            "pitch_shift": try Self.tensor([Float(0)], .float, [1]),
                            "pitch_range": try Self.tensor([Float(1)], .float, [1]),
                        ], outputNames: ["audio"], runOptions: nil)
                        guard let audio = try out["audio"]?.tensorData() as Data? else { continue }
                        audio.withUnsafeBytes { samples.append(contentsOf: $0.bindMemory(to: Float.self)) }
                        samples.append(contentsOf: [Float](repeating: 0, count: 6000))
                    }
                    done.resume(returning: Self.wav(samples, rate: 24000))
                } catch {
                    done.resume(throwing: error)
                }
            }
        }
    }

    private static func wav(_ samples: [Float], rate: Int) -> Data {
        var d = Data()
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + samples.count * 2)
        d.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(samples.count * 2)
        for s in samples { withUnsafeBytes(of: Int16(max(-1, min(1, s)) * 32767).littleEndian) { d.append(contentsOf: $0) } }
        return d
    }
}

/// window.webkit.messageHandlers.quiskVoice.postMessage({ph: [{ids, stress}], voice}) -> base64 WAV.
final class VoiceBridge: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let list = body["ph"] as? [Any] else {
            return replyHandler(nil, "bad message")
        }
        let voice = Int64((body["voice"] as? NSNumber)?.intValue ?? 0)
        let sentences: [(ids: [Int64], stress: [Int64])] = list.compactMap {
            guard let p = $0 as? [String: Any], let ids = p["ids"] as? [NSNumber], let stress = p["stress"] as? [NSNumber] else { return nil }
            return (ids.map { $0.int64Value }, stress.map { $0.int64Value })
        }
        Task {
            do {
                let started = Date()
                let wav = try await NativeVoice.shared.speak(sentences, voice: voice)
                #if DEBUG
                NSLog("quiskVoice: %d sentences, %.1f s audio in %.0f ms", sentences.count, Double(wav.count - 44) / 48000, Date().timeIntervalSince(started) * 1000)
                #endif
                await replyHandler(wav.base64EncodedString(), nil)
            } catch {
                await replyHandler(nil, "voice failed")
            }
        }
    }
}
