import AppIntents

/// Siri, Shortcuts and the Action button. Siri asks for the question and speaks the answer in its own voice.
struct AskQuiskIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Quisk"
    static let description = IntentDescription("Ask a question. Quisk searches the web and reads the answer.")

    @Parameter(title: "Question", requestValueDialog: IntentDialog("What do you want to know?"))
    var question: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        do {
            let answer = try await API.ask(question)
            return .result(value: answer.speech, dialog: IntentDialog(stringLiteral: answer.speech))
        } catch {
            return .result(value: "", dialog: IntentDialog(stringLiteral: error.localizedDescription))
        }
    }
}

/// Opens Quisk listening for the question, then reads the answer in the Quisk voice. Best on the Action button.
struct AskAloudIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Quisk Aloud"
    static let description = IntentDescription("Opens Quisk listening for your question, then reads the answer aloud.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppModel.shared.listening = true
        return .result()
    }
}

struct QuiskShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskAloudIntent(), phrases: ["Ask \(.applicationName) aloud", "Talk to \(.applicationName)"],
                    shortTitle: "Ask Aloud", systemImageName: "waveform")
        AppShortcut(intent: AskQuiskIntent(), phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question"],
                    shortTitle: "Ask Quisk", systemImageName: "magnifyingglass")
    }
}
