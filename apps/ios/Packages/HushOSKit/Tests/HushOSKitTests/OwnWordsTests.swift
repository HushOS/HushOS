import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

extension OnFakeDrive {
    /*
     * Your twelve words, as the sheet reads them. Words from keys the account replaced on another
     * device would have the person read out the wrong words to someone checking them; a session
     * the server ended that reads as an ordinary message would leave the sheet up and the
     * sign-out unsaid.
     */
    @Suite struct OwnWordsTests {
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

        func words(_ envelope: IdentityEnvelope) throws -> String {
            try ContactPin.of(servedOf(envelope), userId: me, email: "me@example.com", name: "Me", pinnedAt: "2026-10-15T00:00:00Z").fingerprint
        }

        @Test func aSessionTheServerEndedIsSessionEndedNotAMessage() async throws {
            defer { done() }
            let server = IdentityServer(stored: v2)
            let device = await vault(server)
            #expect(try await device.currentOwnFingerprint() == words(v2))
            server.sessionGone = true
            await #expect(throws: AuthError.sessionEnded) { _ = try await Auth.identity() }
            do {
                _ = try await device.currentOwnFingerprint()
                Issue.record("words were shown without a session")
            } catch {
                #expect(endsSession(error))
            }
        }

        @Test func afterKeysAreReplacedOnAnotherDeviceTheWordsAreTheNewOnes() async throws {
            defer { done() }
            let server = IdentityServer(stored: v2)
            let device = await vault(server)
            let before = try await device.currentOwnFingerprint()
            #expect(before == (try words(v2)))
            // Another device replaced the keys: the server serves a newer identity.
            let replaced = try identityCreate(userId: me, accountKey: root, keyVersion: 4)
            server.stored = replaced
            // The vault still holds the old one, as it does until a signed write re-checks it.
            #expect(try await device.ownFingerprint() == before)
            let after = try await device.currentOwnFingerprint()
            #expect(after == (try words(replaced)))
            #expect(after != before)
        }

        @Test func theSameIdentityServedAgainIsKeptNotOpenedAgain() async throws {
            defer { done() }
            let server = IdentityServer(stored: v2)
            let device = await vault(server)
            _ = try await device.currentOwnFingerprint()
            let generation = await device.identityGeneration
            _ = try await device.currentOwnFingerprint()
            #expect(await device.identityGeneration == generation)
        }
    }
}
