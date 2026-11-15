import AVFoundation
import Speech
import SwiftUI

/// Ask aloud: listen for a question, answer it, and read the answer in the Quisk voice (Gemini TTS).
@MainActor
final class VoiceModel: ObservableObject {
    enum Phase: Equatable { case listening, thinking, speaking, done, failed(String) }
    @Published var phase: Phase = .listening
    @Published var heard = ""
    @Published var answer = ""
    @Published var chatURL: URL?

    private let recognizer = SFSpeechRecognizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silence: Timer?
    private var player: AVAudioPlayer?
    private let fallback = AVSpeechSynthesizer()

    func start() {
        heard = ""; answer = ""; chatURL = nil; phase = .listening
        Task {
            guard await Self.allowed() else { return fail("Allow the microphone and speech recognition for Quisk in Settings.") }
            do { try listen() } catch { fail("Could not start listening.") }
        }
    }

    private static func allowed() async -> Bool {
        let speech = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        let mic = await AVAudioApplication.requestRecordPermission()
        return speech && mic
    }

    private func listen() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
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
                        Task { @MainActor in self.finishListening() }
                    }
                } else if error != nil, self.heard.isEmpty {
                    self.fail("I didn't catch that. Tap the microphone to try again.")
                }
            }
        }
        // Give up after 10 s of nothing.
        Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
            Task { @MainActor in if let self, self.phase == .listening, self.heard.isEmpty { self.fail("I didn't hear a question.") } }
        }
    }

    private func stopListening() {
        silence?.invalidate()
        if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) }
        request?.endAudio()
        task?.cancel()
        request = nil; task = nil
    }

    func finishListening() {
        guard phase == .listening else { return }
        stopListening()
        let question = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return fail("I didn't hear a question.") }
        phase = .thinking
        Task {
            do {
                let result = try await API.ask(question)
                answer = result.speech
                chatURL = URL(string: result.url)
                try speak(try await API.speech(result.speech, voice: nil))
            } catch let error as API.Problem {
                fail(error.localizedDescription)
            } catch {
                // No audio: read it with the system voice instead.
                if !answer.isEmpty { speakWithSystemVoice(answer) } else { fail("Quisk is not answering. Try again.") }
            }
        }
    }

    private func speak(_ wav: Data) throws {
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        let player = try AVAudioPlayer(data: wav)
        player.delegate = Finisher.shared
        Finisher.shared.done = { [weak self] in Task { @MainActor in if self?.phase == .speaking { self?.phase = .done } } }
        self.player = player
        phase = .speaking
        player.play()
    }

    private func speakWithSystemVoice(_ text: String) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        phase = .speaking
        fallback.speak(AVSpeechUtterance(string: text))
    }

    func stop() {
        stopListening()
        player?.stop()
        fallback.stopSpeaking(at: .immediate)
        if phase == .speaking || phase == .listening { phase = .done }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func fail(_ message: String) {
        stopListening()
        phase = .failed(message)
    }
}

final class Finisher: NSObject, AVAudioPlayerDelegate {
    static let shared = Finisher()
    var done: (() -> Void)?
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { done?() }
}

struct VoiceScreen: View {
    @EnvironmentObject var app: AppModel
    @StateObject private var voice = VoiceModel()

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Spacer()
                Button("Done") { voice.stop(); app.listening = false }.font(.body.weight(.semibold))
            }
            Spacer()
            switch voice.phase {
            case .listening:
                Image(systemName: "waveform").font(.system(size: 56)).symbolEffect(.variableColor.iterative)
                Text(voice.heard.isEmpty ? "Listening…" : voice.heard).font(.title2).multilineTextAlignment(.center)
                if !voice.heard.isEmpty { Button("Ask") { voice.finishListening() }.buttonStyle(.borderedProminent).tint(.primary) }
            case .thinking:
                ProgressView().controlSize(.large)
                Text(voice.heard).font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center)
            case .speaking, .done:
                Text(voice.heard).font(.headline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                ScrollView { Text(voice.answer).font(.title3).frame(maxWidth: .infinity, alignment: .leading) }
            case .failed(let message):
                Image(systemName: "exclamationmark.bubble").font(.system(size: 44)).foregroundStyle(.secondary)
                Text(message).multilineTextAlignment(.center)
            }
            Spacer()
            HStack(spacing: 28) {
                if voice.phase == .speaking {
                    Button { voice.stop() } label: { Image(systemName: "stop.fill").font(.title2).frame(width: 64, height: 64) }
                        .background(Circle().fill(Color(.secondarySystemBackground)))
                } else if voice.phase != .listening && voice.phase != .thinking {
                    Button { voice.start() } label: { Image(systemName: "mic.fill").font(.title2).frame(width: 64, height: 64) }
                        .background(Circle().fill(Color(.secondarySystemBackground)))
                }
            }
            .foregroundStyle(.primary)
        }
        .padding(24)
        .onAppear { voice.start() }
        .onDisappear { voice.stop() }
    }
}
