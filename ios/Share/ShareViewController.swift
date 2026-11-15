import UIKit
import UniformTypeIdentifiers
import WebKit

/// "Quisk" in the share sheet: asks "Tell me more about this" about the shared link or text, and shows the answer as it
/// streams. The chat is saved to the account, so it is also in the app's history.
final class ShareViewController: UIViewController {
    private let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private let note = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let bar = UINavigationBar()
        let item = UINavigationItem(title: "Quisk")
        item.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        bar.items = [item]
        note.textAlignment = .center
        note.numberOfLines = 0
        note.textColor = .secondaryLabel
        for v in [bar, web, note] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor), bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.topAnchor.constraint(equalTo: bar.bottomAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            note.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            note.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32), note.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])
        guard let token = Token.value else { return show("Open Quisk and sign in first.") }
        Task {
            guard let shared = await sharedContent() else { return show("Quisk can't read this item. Share a link or text.") }
            ask("Tell me more about this: \(shared)", token: token)
        }
    }

    private func show(_ message: String) {
        note.text = message
        web.isHidden = true
    }

    /// The shared link, or else the shared text (shortened).
    private func sharedContent() async -> String? {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, url.scheme?.hasPrefix("http") == true {
                return url.absoluteString
            }
        }
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return String(trimmed.prefix(500)) }
            }
        }
        return nil
    }

    private func ask(_ question: String, token: String) {
        var parts = URLComponents(string: "https://quisk.ai/")!
        parts.queryItems = [URLQueryItem(name: "q", value: question)]
        guard let url = parts.url,
              let cookie = HTTPCookie(properties: [.domain: "quisk.ai", .path: "/", .name: "s", .value: token, .secure: "TRUE",
                                                   .expires: Date().addingTimeInterval(365 * 86400)]) else { return }
        web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [web] in _ = web.load(URLRequest(url: url)) }
    }
}
