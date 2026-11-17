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
        // The page's talk button: dictate with the phone's speech recognition, then answer aloud in the page.
        config.userContentController.add(ListenBridge(model: model), name: "quiskListen")
        // The page says when it starts and stops reading aloud, so the wake word ignores Quisk's own voice.
        config.userContentController.add(SpeakingBridge(), name: "quiskSpeaking")
        #if DEBUG
        // Debug builds: the page's console warnings and errors go to the Xcode console, and Safari can inspect the page.
        config.userContentController.add(LogBridge(), name: "quiskLog")
        config.userContentController.addUserScript(WKUserScript(source: """
            for (const k of ['warn','error']) { const f = console[k]; console[k] = (...a) => { try { webkit.messageHandlers.quiskLog.postMessage(k + ': ' + a.map(String).join(' ')) } catch {} f.apply(console, a) } }
            addEventListener('error', e => console.error(e.message));
            addEventListener('unhandledrejection', e => console.error('unhandled', e.reason));
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        // No swipe back: chats open in place, so an accidental edge swipe went back to an older chat and the next
        // spoken question landed there. The page has its own New chat button and chat list.
        web.allowsBackForwardNavigationGestures = false
        #if DEBUG
        web.isInspectable = true
        #endif
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

final class ListenBridge: NSObject, WKScriptMessageHandler {
    let model: AppModel
    init(model: AppModel) { self.model = model }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        model.listeningForPage = true
        model.listening = true
    }
}

#if DEBUG
final class LogBridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("quiskPage %@", String(describing: message.body))
    }
}
#endif

final class SpeakingBridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let on = ((message.body as? [String: Any])?["on"] as? Bool) ?? false
        Task { @MainActor in WakeWord.shared.setPaused(on) }
    }
}
