import AuthenticationServices
import SwiftUI
import WebKit

@main
struct QuiskApp: App {
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ZStack {
                if model.signedIn { WebScreen() } else { SignInScreen() }
                // Splash until the first page has loaded (the voice model starts loading with it).
                if model.signedIn && !model.loaded { Splash().transition(.opacity) }
            }
            .animation(.easeOut(duration: 0.3), value: model.loaded)
            .environmentObject(model)
            .fullScreenCover(isPresented: $model.listening) { VoiceScreen().environmentObject(model) }
            // "Quisk" wake word: only while the app is open, signed in and not already dictating.
            .onChange(of: phase, initial: true) { model.updateWakeWord(active: phase == .active) }
            .onChange(of: model.listening) { model.updateWakeWord(active: phase == .active) }
            .onChange(of: model.signedIn) { model.updateWakeWord(active: phase == .active) }
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    @Published var signedIn: Bool

    init() {
        #if DEBUG
        // Simulator testing without a passkey: SIMCTL_CHILD_QUISK_TOKEN=<token> xcrun simctl launch ...
        if let token = ProcessInfo.processInfo.environment["QUISK_TOKEN"], !token.isEmpty { Token.save(token) }
        #endif
        signedIn = Token.value != nil
        NativeVoice.shared.preload()
        #if DEBUG
        // Simulator testing of the Action-button path without a microphone: QUISK_ASK=<question>.
        if let question = ProcessInfo.processInfo.environment["QUISK_ASK"], !question.isEmpty {
            // QUISK_ASK_AFTER=<seconds>: ask once the app is open (the in-place path), not at launch.
            let after = Double(ProcessInfo.processInfo.environment["QUISK_ASK_AFTER"] ?? "") ?? 0
            if after > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + after) { self.ask(question) } } else { ask(question) }
        }
        #endif
    }
    /// Set by the "Ask Quisk Aloud" action (Action button): opens the listening screen.
    @Published var listening = false
    /// The listening screen was opened by the page's talk button: the question goes back to that page (a follow-up in
    /// an open chat), not into a new chat.
    var listeningForPage = false

    /// Start or stop listening for "Quisk". Saying it opens dictation; the question is asked in the open page.
    func updateWakeWord(active: Bool) {
        let wake = WakeWord.shared
        wake.onWake = { [weak self] in
            guard let self, !self.listening else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            self.listeningForPage = true
            self.listening = true
        }
        if active && signedIn && !listening { wake.start() } else { wake.stop() }
    }

    /// A spoken question from the page's talk button, asked in the page with the answer read aloud.
    func talk(_ question: String) {
        let arg = String(data: try! JSONSerialization.data(withJSONObject: [question]), encoding: .utf8)!.dropFirst().dropLast()
        web?.evaluateJavaScript("window.quiskTalk && quiskTalk(\(arg))")
    }
    @Published var signInError: String?
    /// The web view has finished its first load (ends the splash screen).
    @Published var loaded = false
    weak var web: WKWebView?
    private var pending: URL?

    /// Ask in the chat page with talk mode on: the answer streams and is read aloud.
    func ask(_ question: String) {
        var parts = URLComponents(url: API.base, resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "q", value: question), URLQueryItem(name: "talk", value: "true")]
        #if DEBUG
        // Simulator testing of reading speed: QUISK_SPEED=1.5
        if let speed = ProcessInfo.processInfo.environment["QUISK_SPEED"] { parts.queryItems?.append(URLQueryItem(name: "speed", value: speed)) }
        #endif
        guard let url = parts.url else { return }
        guard let web, loaded else { pending = url; web?.load(URLRequest(url: url)); return }
        // Page already open: ask in place, so its voice worker (already warm) makes the phonemes from the start.
        let arg = String(data: try! JSONSerialization.data(withJSONObject: [question]), encoding: .utf8)!.dropFirst().dropLast()
        web.evaluateJavaScript("window.quiskAsk ? (quiskAsk(\(arg)), 1) : 0") { result, _ in
            if (result as? Int) != 1 { web.load(URLRequest(url: url)) }
        }
    }

    /// The URL to load first: a question asked before the web view existed, or the home page.
    func firstURL() -> URL {
        defer { pending = nil }
        return pending ?? API.base
    }

    func signOut() {
        Token.save(nil)
        signedIn = false
    }

    /// Sign in on quisk.ai in a system browser sheet, where the existing passkey works, and receive the app token.
    func signIn() {
        let session = ASWebAuthenticationSession(url: API.base.appendingPathComponent("auth/app"), callbackURLScheme: "quisk") { url, error in
            Task { @MainActor in
                if let url, let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "token" })?.value {
                    Token.save(token)
                    self.signedIn = true
                    self.signInError = nil
                } else if let error, (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                    self.signInError = error.localizedDescription
                }
            }
        }
        session.presentationContextProvider = Presenter.shared
        session.prefersEphemeralWebBrowserSession = false
        session.start()
    }
}

final class Presenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = Presenter()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
}

struct Splash: View {
    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            VStack(spacing: 14) {
                Image("Logo").resizable().frame(width: 84, height: 84).clipShape(RoundedRectangle(cornerRadius: 19))
                Text("Quisk").font(.title.weight(.semibold))
            }
        }
    }
}

struct SignInScreen: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image("Logo").resizable().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 16))
            Text("Quisk").font(.largeTitle.weight(.semibold))
            Text("Fast answers from the web.").foregroundStyle(.secondary)
            Spacer()
            Button(action: model.signIn) {
                Text("Sign in").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .tint(.primary)
            if let error = model.signInError { Text(error).font(.footnote).foregroundStyle(.red) }
            Text("Uses your quisk.ai passkey. New here? Join the waitlist on the sign-in page.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(28)
    }
}
