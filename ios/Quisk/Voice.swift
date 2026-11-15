import AVFoundation
import Speech
import SwiftUI

/// Ask aloud (Action button): dictate a question, then ask it in the chat page with talk mode on, so the answer
/// streams on screen and is read aloud by the on-device voice (F2 by default, picked on the page).
@MainActor
final class Dictation: ObservableObject {
    enum Phase: Equatable { case listening, failed(String) }
    @Published var phase: Phase = .listening
    @Published var heard = ""

    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silence: Timer?
    private var giveUp: Timer?
    var onQuestion: (String) -> Void = { _ in }

    /// Audio session changes can block while the system audio server reconfigures, so they never run on the main
    /// thread. One serial queue keeps them in order (record for dictation, then playback for the answer).
    private static let audioSession = DispatchQueue(label: "ai.quisk.audio-session", qos: .userInitiated)

    private static func configure(_ change: @escaping @Sendable (AVAudioSession) throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            audioSession.async {
                do { try change(AVAudioSession.sharedInstance()); done.resume() } catch { done.resume(throwing: error) }
            }
        }
    }

    func start() {
        heard = ""
        phase = .listening
        Task {
            guard await Self.allowed() else { return fail("Allow the microphone and speech recognition for Quisk in Settings.") }
            do {
                try await Self.configure { session in
                    try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
                    try session.setActive(true, options: .notifyOthersOnDeactivation)
                }
                try listen()
            } catch {
                fail("Could not start listening.")
            }
        }
    }

    private static func allowed() async -> Bool {
        let speech = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        let mic = await AVAudioApplication.requestRecordPermission()
        return speech && mic
    }

    private func listen() throws {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .search
        self.request = request
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
        engine.prepare()
        try engine.start()
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, self.phase == .listening else { return }
                if let result {
                    self.heard = result.bestTranscription.formattedString
                    // The question ends after 1.2 s of silence once something was said.
                    self.silence?.invalidate()
                    self.silence = Timer.scheduledTimer(withTimeInterval: result.isFinal ? 0 : 1.2, repeats: false) { _ in
                        Task { @MainActor in self.finish() }
                    }
                } else if error != nil, self.heard.isEmpty {
                    self.fail("I didn't catch that. Tap the microphone to try again.")
                }
            }
        }
        giveUp = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
            Task { @MainActor in if let self, self.phase == .listening, self.heard.isEmpty { self.fail("I didn't hear a question.") } }
        }
    }

    func stop() {
        silence?.invalidate()
        giveUp?.invalidate()
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        // Hand the audio session back so the page can play the answer (off the main thread, after any pending setup).
        Self.audioSession.async { try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio) }
    }

    func finish() {
        guard phase == .listening else { return }
        stop()
        let question = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return fail("I didn't hear a question.") }
        onQuestion(question)
    }

    private func fail(_ message: String) {
        stop()
        phase = .failed(message)
    }
}

struct VoiceScreen: View {
    @EnvironmentObject var app: AppModel
    @StateObject private var dictation = Dictation()

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Spacer()
                Button("Cancel") { dictation.stop(); app.listening = false }
            }
            Spacer()
            switch dictation.phase {
            case .listening:
                Image(systemName: "waveform").font(.system(size: 56)).symbolEffect(.variableColor.iterative)
                Text(dictation.heard.isEmpty ? "What do you want to know?" : dictation.heard)
                    .font(.title2).multilineTextAlignment(.center)
                    .foregroundStyle(dictation.heard.isEmpty ? .secondary : .primary)
                if !dictation.heard.isEmpty {
                    Button("Ask") { dictation.finish() }.buttonStyle(.borderedProminent).tint(.primary)
                }
            case .failed(let message):
                Image(systemName: "exclamationmark.bubble").font(.system(size: 44)).foregroundStyle(.secondary)
                Text(message).multilineTextAlignment(.center)
                Button { dictation.start() } label: { Image(systemName: "mic.fill").font(.title2).frame(width: 64, height: 64) }
                    .background(Circle().fill(Color(.secondarySystemBackground)))
                    .foregroundStyle(.primary)
            }
            Spacer()
        }
        .padding(24)
        .onAppear {
            dictation.onQuestion = { question in
                app.listening = false
                if app.listeningForPage { app.talk(question) } else { app.ask(question) }
                app.listeningForPage = false
            }
            dictation.start()
        }
        .onDisappear { dictation.stop() }
    }
}
