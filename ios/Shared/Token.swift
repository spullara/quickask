import Foundation
import Security

/// The quisk.ai account token (the same signed value as the web session cookie), in a Keychain group that the app and
/// its Share extension both read.
enum Token {
    private static let service = "ai.quisk.app", account = "session"
    /// Team ID + the group in both targets' keychain-access-groups entitlement.
    private static let group = "49Z7UCNQ36.ai.quisk.shared"

    private static func base(shared: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        if shared { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    private static func read(shared: Bool) -> String? {
        var query = base(shared: shared)
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static var value: String? {
        if let token = read(shared: true) { return token }
        // Signed in before the Share extension existed: move the token into the shared group.
        guard let old = read(shared: false) else { return nil }
        save(old)
        return old
    }

    static func save(_ token: String?) {
        SecItemDelete(base(shared: false) as CFDictionary)
        SecItemDelete(base(shared: true) as CFDictionary)
        guard let token else { return }
        var add = base(shared: true)
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
