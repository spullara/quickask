import Foundation

enum API {
    static let base = URL(string: "https://quisk.ai")!

    struct Answer: Decodable { let id: String; let url: String; let answer: String; let speech: String }
    struct Failure: Decodable { let error: String }

    enum Problem: LocalizedError {
        case signedOut, server(String)
        var errorDescription: String? {
            switch self {
            case .signedOut: return "Open Quisk and sign in first."
            case .server(let message): return message
            }
        }
    }

    private static func request(_ path: String, _ body: [String: String]) throws -> URLRequest {
        guard let token = Token.value else { throw Problem.signedOut }
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 30
        return req
    }

    /// Search and answer in one call. The answer is saved as a chat, so it also shows in the app's sidebar.
    static func ask(_ question: String) async throws -> Answer {
        let (data, response) = try await URLSession.shared.data(for: try request("api/ask", ["q": question]))
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            // A signed-out request gets the sign-in page back (HTML), not JSON.
            if (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("text/html") { throw Problem.signedOut }
            throw Problem.server((try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "Quisk is not answering (\(http.statusCode)).")
        }
        if let text = String(data: data.prefix(15), encoding: .utf8), text.hasPrefix("<!doctype") { throw Problem.signedOut }
        return try JSONDecoder().decode(Answer.self, from: data)
    }
}
