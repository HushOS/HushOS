import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/* The version 1 form of an identity: the same keys without ML-DSA or the keys statement, as accounts held before the release. */
func versionOne(_ envelope: IdentityEnvelope) -> IdentityEnvelope {
    var old = envelope
    old.version = 1
    old.mlDsa = nil
    old.keysSignature = nil
    old.kem?.signature = nil
    return old
}

extension OnFakeDrive {
    /*
     * The first unlock after the post-quantum release (docs/identity-pq-design.md 2): a version 1
     * identity is upgraded in place before anything signs with it, keeping its three keys and key
     * version; a device that loses the race adopts the winner's; and once a device has opened
     * version 2 it refuses the version 1 form rather than mint a second ML-DSA key.
     */
    @Suite struct IdentityUpgradeTests {
        let me = UUID().uuidString.lowercased()
        let root: Data
        let v2: IdentityEnvelope

        init() throws {
            root = try randomBytes(length: 32)
            v2 = try identityCreate(userId: me, accountKey: root, keyVersion: 3)
        }

        func vault(_ server: IdentityServer) async -> Vault {
            let session = SharedKeychain.Session(origin: "https://identity.test", token: "t", userId: me)
            IdentityServer.current = server
            Auth.testSession = session
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [IdentityServerProtocol.self]
            Auth.testTransport = configuration
            let vault = Vault(api: DriveAPI(session: session, configuration: configuration), session: session)
            await vault.adopt(accountKey: root)
            return vault
        }

        func done() { Auth.testSession = nil; Auth.testTransport = nil; IdentityServer.current = nil }

        @Test func aVersionOneIdentityIsUpgradedInPlaceOnceBeforeAnythingSigns() async throws {
            defer { done() }
            let old = versionOne(v2)
            let server = IdentityServer(stored: old)
            let vault = await vault(server)
            // Two callers at once (Drive opening, a write signing): one upgrade, not two ML-DSA keys.
            async let first = vault.identityKeys()
            async let second = vault.identityKeys()
            let (a, b) = try await (first, second)
            #expect(server.upgrades.count == 1)
            let sent = try #require(server.upgrades.first)
            // The same X25519, Ed25519 and ML-KEM keys and key version: only ML-DSA and the statement are new.
            #expect(sent.version == 2 && sent.keyVersion == old.keyVersion)
            #expect(sent.encryptionPublicKey == old.encryptionPublicKey && sent.signingPublicKey == old.signingPublicKey)
            #expect(sent.kem?.publicKey == old.kem?.publicKey)
            #expect(try #require(server.bodies.first)["identity"].flatMap { ($0 as? [String: Any])?["kem"] as? [String: Any] }?["signature"] == nil,
                    "a version 2 envelope carries no Ed25519 KEM binding")
            // What it opened is what the server stored, and it signs with both keys.
            #expect(a.identityVersion == 2 && a.mlDsaPublicKey == sent.mlDsa?.publicKey && a == b)
            #expect(identityVerifyKeys(userId: me, identity: try publicIdentity(envelope: server.stored)))
        }

        @Test func aDeviceThatLosesTheRaceOpensTheWinnersIdentity() async throws {
            defer { done() }
            let old = versionOne(v2)
            // Another device upgraded between this one's read and its upload.
            let winner = try identityUpgrade(userId: me, accountKey: root, envelope: old)
            let server = IdentityServer(stored: old)
            server.winner = winner
            let vault = await vault(server)
            let keys = try await vault.identityKeys()
            #expect(server.upgrades.count == 1)
            #expect(keys.mlDsaPublicKey == winner.mlDsa?.publicKey)
            #expect(keys.mlDsaPublicKey != server.upgrades.first?.mlDsa?.publicKey)
        }

        @Test func theVersionOneFormServedAfterTheUpgradeIsRefusedAndNotUpgradedAgain() async throws {
            defer { done() }
            _ = try await vault(IdentityServer(stored: v2)).identityKeys()
            // The same device later; the server hands back the version 1 form of the same keys.
            let server = IdentityServer(stored: versionOne(v2))
            let again = await vault(server)
            await #expect(throws: AuthError.message(IdentityMarks.downgraded)) { _ = try await again.identityKeys() }
            #expect(server.upgrades.isEmpty)
        }

        @Test func ownWordsAreOverTheFourKeysAndMatchWhatAContactPins() async throws {
            defer { done() }
            let vault = await vault(IdentityServer(stored: versionOne(v2)))
            let own = try await vault.ownFingerprint()
            let stored = try #require(IdentityServer.current?.stored)
            let pin = try ContactPin.of(servedOf(stored), userId: me, email: "me@example.com", name: "Me", pinnedAt: "2026-10-15T00:00:00Z")
            #expect(own == pin.fingerprint)
        }
    }
}

/* `GET /api/auth/identity` and `POST /api/auth/identity/upgrade` as the server has them. */
final class IdentityServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: IdentityServer?
    var stored: IdentityEnvelope
    /* Another device's upgrade, stored the moment this device uploads its own. */
    var winner: IdentityEnvelope?
    var upgrades: [IdentityEnvelope] = []
    var bodies: [[String: Any]] = []
    private let lock = NSLock()

    init(stored: IdentityEnvelope) { self.stored = stored }

    func answer(_ request: URLRequest, body: Data?) -> (Int, [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        let path = request.url?.path ?? ""
        if path == "/api/auth/identity", request.httpMethod == "GET" { return (200, ["identity": Auth.json(stored)]) }
        if path == "/api/auth/identity/upgrade", request.httpMethod == "POST" {
            let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            bodies.append(json)
            let sent = Auth.identityEnvelope(from: json["identity"] as? [String: Any] ?? [:])
            upgrades.append(sent)
            if let winner { stored = winner }
            guard stored.version == 1 else { return (409, ["message": "Your keys were upgraded on another device.", "identity": Auth.json(stored)]) }
            guard sent.version == 2, sent.keyVersion == stored.keyVersion, sent.encryptionPublicKey == stored.encryptionPublicKey,
                  sent.signingPublicKey == stored.signingPublicKey, sent.kem?.publicKey == stored.kem?.publicKey
            else { return (400, ["message": "Not the same keys."]) }
            stored = sent
            return (200, ["identity": Auth.json(stored)])
        }
        return (404, ["message": "Not here."])
    }
}

final class IdentityServerProtocol: URLProtocol {
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
        let (status, json) = IdentityServer.current?.answer(request, body: body) ?? (500, ["message": "No server"])
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: json)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
