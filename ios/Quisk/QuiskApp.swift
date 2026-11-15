import AuthenticationServices
import SwiftUI

@main
struct QuiskApp: App {
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if model.signedIn { WebScreen() } else { SignInScreen() }
            }
            .environmentObject(model)
            .fullScreenCover(isPresented: $model.listening) { VoiceScreen().environmentObject(model) }
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
    }
    /// Set by the "Ask Quisk Aloud" action (Action button): opens the listening screen.
    @Published var listening = false
    @Published var signInError: String?

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
