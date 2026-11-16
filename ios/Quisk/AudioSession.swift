import AVFoundation

/// Audio session changes can block while the system audio server reconfigures, so they never run on the main thread.
/// One serial queue keeps them in order across dictation, the wake word and playback.
enum AudioSession {
    static let queue = DispatchQueue(label: "ai.quisk.audio-session", qos: .userInitiated)

    static func configure(_ change: @escaping @Sendable (AVAudioSession) throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            queue.async {
                do { try change(AVAudioSession.sharedInstance()); done.resume() } catch { done.resume(throwing: error) }
            }
        }
    }

    static func later(_ change: @escaping @Sendable (AVAudioSession) throws -> Void) {
        queue.async { try? change(AVAudioSession.sharedInstance()) }
    }
}
