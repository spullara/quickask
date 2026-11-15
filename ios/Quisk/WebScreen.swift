import SwiftUI
import WebKit

/// The full quisk.ai app, signed in with the app's token as the session cookie.
struct WebScreen: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        QuiskWebView(onSignOut: model.signOut)
            .ignoresSafeArea(.container, edges: .bottom)
    }
}

struct QuiskWebView: UIViewRepresentable {
    let onSignOut: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onSignOut: onSignOut) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .automatic
        let token = Token.value ?? ""
        let cookie = HTTPCookie(properties: [.domain: "quisk.ai", .path: "/", .name: "s", .value: token, .secure: "TRUE",
                                             .expires: Date().addingTimeInterval(365 * 86400)])
        let load: @MainActor @Sendable () -> Void = { _ = web.load(URLRequest(url: API.base)) }
        if let cookie { config.websiteDataStore.httpCookieStore.setCookie(cookie, completionHandler: load) } else { load() }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let onSignOut: () -> Void
        init(onSignOut: @escaping () -> Void) { self.onSignOut = onSignOut }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            // Signing out on the web signs out the app (the web page cannot sign back in with a passkey inside the app).
            if url.host == "quisk.ai" && url.path == "/auth/logout" {
                decisionHandler(.cancel)
                Task { @MainActor in onSignOut() }
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
