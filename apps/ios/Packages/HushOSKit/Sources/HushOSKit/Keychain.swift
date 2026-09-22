import Foundation
import Security
@_exported import HushOSCore

/*
 * What the app leaves for the extensions in the shared keychain (the app group
 * is the access group): the session, the remembered device that opens the
 * account key, and which HushOS the device talks to. The extensions read it;
 * the sign-in sheet inside Files writes it too.
 */
public enum SharedKeychain {
    public static let accessGroup = "group.com.hushos.app"
    public static let service = "com.hushos.files"
    public static let sessionAccount = "session"
    public static let deviceAccount = "device"
    public static let configAccount = "config"

    public struct Session: Codable, Sendable, Equatable {
        public let origin: String
        public let token: String
        public let userId: String
        public init(origin: String, token: String, userId: String) {
            self.origin = origin
            self.token = token
            self.userId = userId
        }
    }

    /* The bundle in the core's JSON form and the device key in base64url. */
    public struct Device: Codable, Sendable, Equatable {
        public let bundle: String
        public let deviceKey: String
        public init(memory: DeviceMemory) {
            bundle = rememberedDeviceToJson(bundle: memory.bundle)
            deviceKey = base64urlEncode(bytes: memory.deviceKey)
        }
        public func open() throws -> (bundle: RememberedDevice, key: Data) {
            (try rememberedDeviceFromJson(json: bundle), try base64urlDecode(value: deviceKey))
        }
    }

    public struct Config: Codable, Sendable, Equatable {
        public let origin: String
        public init(origin: String) { self.origin = origin }
    }

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }

    public static func read<T: Decodable>(_ account: String, as type: T.Type) -> T? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(type, from: data)
    }

    public static func write<T: Encodable>(_ account: String, _ value: T) throws {
        let data = try JSONEncoder().encode(value)
        let base = query(account)
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    public static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }

    public static var session: Session? { read(sessionAccount, as: Session.self) }
    public static var device: Device? { read(deviceAccount, as: Device.self) }
    public static var config: Config? { read(configAccount, as: Config.self) }
}
