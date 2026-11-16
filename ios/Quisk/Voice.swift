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
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silence: Timer?
    private var giveUp: Timer?
    var onQuestion: (String) -> Void = { _ in }

    func start() {
        heard = ""
        phase = .listening
        Task {
            guard await Self.allowed() else { return fail("Allow the microphone and speech recognition for Quisk in Settings.") }
            do {
                try await AudioSession.configure { session in
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
        // A new engine each time, so the tap uses the mic format of the session set up just now (see WakeWord).
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "dictation", code: 1) }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        engine.prepare()
        try engine.start()
        self.engine = engine
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
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        engine = nil
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        // Hand the audio session back for the answer, keeping the mic usable for the wake word.
        AudioSession.later(AudioSession.playAndListen)
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
                // Close once the page shows the question; at most 1 s later if the page does not answer.
                var closed = false
                let close = { if !closed { closed = true; app.listening = false } }
                if app.listeningForPage { app.talk(question, shown: close) } else { app.ask(question, shown: close) }
                app.listeningForPage = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: close)
            }
            dictation.start()
        }
        .onDisappear { dictation.stop() }
    }
}
