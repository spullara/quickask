import SwiftUI
import WebKit

/// The full quisk.ai app, signed in with the app's token as the session cookie.
struct WebScreen: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        QuiskWebView(model: model)
            .ignoresSafeArea(.container, edges: .bottom)
    }
}

struct QuiskWebView: UIViewRepresentable {
    let model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // The page sees "QuiskApp" and preloads the on-device voice in the background.
        config.applicationNameForUserAgent = "QuiskApp/1.0"
        // The page reads answers with the voice built into the app (no model download in the web view).
        config.userContentController.addScriptMessageHandler(VoiceBridge(), contentWorld: .page, name: "quiskVoice")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .automatic
        let token = Token.value ?? ""
        let cookie = HTTPCookie(properties: [.domain: "quisk.ai", .path: "/", .name: "s", .value: token, .secure: "TRUE",
                                             .expires: Date().addingTimeInterval(365 * 86400)])
        model.web = web
        let first = model.firstURL()
        let load: @MainActor @Sendable () -> Void = { _ = web.load(URLRequest(url: first)) }
        if let cookie { config.websiteDataStore.httpCookieStore.setCookie(cookie, completionHandler: load) } else { load() }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let model: AppModel
        init(model: AppModel) { self.model = model }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in model.loaded = true }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in model.loaded = true }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            // Signing out on the web signs out the app (the web page cannot sign back in with a passkey inside the app).
            if url.host == "quisk.ai" && url.path == "/auth/logout" {
                decisionHandler(.cancel)
                Task { @MainActor in model.signOut() }
                return
            }
            // Links to other sites open in Safari.
            if url.host != "quisk.ai", ["http", "https"].contains(url.scheme ?? ""), action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        // target="_blank" links (search results, sources).
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { UIApplication.shared.open(url) }
            return nil
        }
    }
}
