import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

extension OnFakeDrive {
    /*
     * An account whose settings are still a version 1 document: the server serves it as none,
     * and the first save (naming version 0) replaces it above its old sequence. The sequence is
     * bound into the seal, so the save has to end up sealed at the version the server stored,
     * or no device can open the account's settings again.
     */
    @Suite struct SettingsUpgradeTests {
        @Test func replacingAVersionOneDocumentLeavesSettingsThatOpen() async throws {
            let me = UUID().uuidString.lowercased()
            let session = SharedKeychain.Session(origin: "https://settings.test", token: "t", userId: me)
            let server = SettingsServer(storedVersion: 7)
            SettingsServer.current = server
            Auth.testSession = session
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [SettingsServerProtocol.self]
            Auth.testTransport = configuration
            defer { Auth.testSession = nil; Auth.testTransport = nil; SettingsServer.current = nil }
            let vault = Vault(api: DriveAPI(session: session, configuration: configuration), session: session)
            let key = try settingsKeyCreate(userId: me, accountKey: try randomBytes(length: 32)).key
            await vault.adopt(settingsKey: key)

            // Read as none (not a rollback), then saved with a share in the ledger.
            #expect(try await vault.loadedSettingsVersion() == 0)
            let savedVersion = try await vault.saveShare(node: "node-a", grantee: "someone")

            // What the server holds opens, at the version it holds, with what was saved in it.
            let stored = try #require(server.envelope)
            #expect(stored.settingsVersion > 7 && savedVersion == stored.settingsVersion)
            let reopened = try Settings.opened(userId: me, envelope: stored, settingsKey: key)
            #expect(reopened.ledger.holdsShare(node: "node-a", grantee: "someone"))
            #expect(try await vault.loadedSettingsHold(node: "node-a", grantee: "someone"))
        }
    }
}

extension Vault {
    func adopt(settingsKey key: Data) { settingsKey = key }
    func loadedSettingsVersion() async throws -> UInt64 { try await loadSettings().version }
    func loadedSettingsHold(node: String, grantee: String) async throws -> Bool { try await loadSettings().ledger.holdsShare(node: node, grantee: grantee) }
    func saveShare(node: String, grantee: String) async throws -> UInt64 {
        try await updateSettings { $0.ledger.addShare(node: node, grantee: grantee) }.version
    }
}

/* The server's settings routes as fix/audit-3 has them: a version 1 row served as none, every save stored one past the old sequence. */
final class SettingsServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: SettingsServer?
    var storedVersion: UInt64
    var envelopeVersion: UInt32 = 1
    var envelope: SettingsEnvelope?

    init(storedVersion: UInt64) { self.storedVersion = storedVersion }

    func answer(_ request: URLRequest, body: Data?) -> (Int, [String: Any]) {
        let key: [String: Any] = ["nonce": base64urlEncode(bytes: Data(count: 24)), "ciphertext": base64urlEncode(bytes: Data(count: 48))]
        if request.httpMethod == "PUT" {
            let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let expected = (json["expectedVersion"] as? NSNumber)?.uint64Value ?? 0
            let visible = envelopeVersion == 2 ? storedVersion : 0
            guard expected == visible else { return (409, ["message": "Settings changed."]) }
            storedVersion += 1
            envelopeVersion = 2
            envelope = SettingsEnvelope(version: 2, settingsVersion: storedVersion, nonce: json["nonce"] as? String ?? "", ciphertext: json["ciphertext"] as? String ?? "")
            return (200, ["settingsVersion": storedVersion])
        }
        guard let envelope, envelopeVersion == 2 else { return (200, ["settings": NSNull(), "settingsKey": key]) }
        return (200, ["settings": ["version": 2, "settingsVersion": envelope.settingsVersion, "nonce": envelope.nonce, "ciphertext": envelope.ciphertext], "settingsKey": key])
    }
}

final class SettingsServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        let (status, json) = SettingsServer.current?.answer(request, body: body) ?? (500, ["message": "No server"])
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
