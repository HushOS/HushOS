import Foundation
import Testing
@testable import HushOSKit

/*
 * A relay and a server in one stub, answering from what the test says and recording every request
 * (method, path, JSON body). It answers at once on the loading thread; nothing is held.
 */
final class PushStubProtocol: URLProtocol {
    struct Seen: Equatable {
        let method: String
        let url: String
        let body: [String: String]
    }

    nonisolated(unsafe) static var answer: (_ method: String, _ url: String) -> (Int, String) = { _, _ in (500, "{}") }
    nonisolated(unsafe) static var seen: [Seen] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
        }
        let body = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        let method = request.httpMethod ?? "GET"
        let url = request.url!.absoluteString
        let (status, text) = Self.lock.withLock {
            Self.seen.append(Seen(method: method, url: url, body: body))
            return Self.answer
        }(method, url)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/* The keychain's part, in memory: the session signed in, the registration and the pending deletions. */
final class PushMemory: @unchecked Sendable {
    private let lock = NSLock()
    var session: SharedKeychain.Session?
    var registration: PushRegistration?
    var pending: [PushPendingDeletion] = []

    init(session: SharedKeychain.Session?, registration: PushRegistration? = nil) {
        self.session = session
        self.registration = registration
    }

    func set(_ change: (PushMemory) -> Void) { lock.withLock { change(self) } }

    var keep: PushKeep {
        PushKeep(
            session: { [self] in lock.withLock { session } },
            read: { [self] in lock.withLock { registration } },
            write: { [self] next in lock.withLock { registration = next }; return true },
            delete: { [self] in lock.withLock { registration = nil } },
            pending: { [self] in lock.withLock { pending } },
            setPending: { [self] list in lock.withLock { pending = list }; return true }
        )
    }
}

/*
 * Registering with the relay holds the deletion secret: each test fails on a handle that outlives
 * a sign-out, one that is never deleted, or one deleted with the wrong secret.
 */
@Suite(.serialized) struct PushRegistrarTests {
    static let server = "https://drive.test"
    static let relay = "https://relay.test"
    let maya = SharedKeychain.Session(origin: server, token: "maya-token", userId: "u-maya")
    let other = SharedKeychain.Session(origin: server, token: "sam-token", userId: "u-sam")

    // 32 bytes each, base64url: what the relay hands out.
    let oldHandle = String(repeating: "A", count: 42) + "E"
    let oldSecret = String(repeating: "B", count: 42) + "E"
    let newHandle = String(repeating: "C", count: 42) + "E"
    let newSecret = String(repeating: "D", count: 42) + "E"
    let token = Data(repeating: 0xAB, count: 32)

    func previous(token: String = String(repeating: "cd", count: 32)) -> PushRegistration {
        PushRegistration(origin: Self.server, userId: "u-maya", relay: Self.relay, platform: "apns-sandbox", token: token,
                         handle: oldHandle, deleteSecret: oldSecret)
    }

    func registrar(_ memory: PushMemory) -> PushRegistrar {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PushStubProtocol.self]
        return PushRegistrar(keep: memory.keep, transport: configuration, platform: "apns-sandbox", usable: { $0 })
    }

    /* The relay registers and deletes; the server answers its PUT with `put`; `onPut` runs as the PUT arrives. */
    func answering(put: Int, onPut: @escaping () -> Void = {}) {
        PushStubProtocol.lock.withLock {
            PushStubProtocol.seen = []
            PushStubProtocol.answer = { [newHandle, newSecret] method, url in
                switch (method, url) {
                case ("POST", Self.relay + "/v1/register"):
                    return (200, #"{"handle":"\#(newHandle)","deleteSecret":"\#(newSecret)"}"#)
                case ("PUT", Self.server + "/api/notifications/registration"):
                    onPut()
                    return (put, put == 200 ? #"{"registered":true}"# : #"{"message":"No"}"#)
                case ("DELETE", _) where url.hasPrefix(Self.relay + "/v1/register/"):
                    return (204, "")
                default:
                    return (500, "{}")
                }
            }
        }
    }

    var seen: [PushStubProtocol.Seen] { PushStubProtocol.lock.withLock { PushStubProtocol.seen } }

    func deletions() -> [String: String] {
        Dictionary(seen.filter { $0.method == "DELETE" }.map { ($0.url.replacingOccurrences(of: Self.relay + "/v1/register/", with: ""), $0.body["deleteSecret"] ?? "") },
                   uniquingKeysWith: { first, _ in first })
    }

    @Test func aServerThatRefusesTheHandlePutsBackWhatWasKeptAndDeletesTheNewOne() async throws {
        let memory = PushMemory(session: maya, registration: previous())
        answering(put: 500)
        let registrar = registrar(memory)
        await #expect(throws: (any Error).self) { try await registrar.register(token: token, relay: Self.relay) }
        await registrar.drain()
        #expect(memory.keep.read() == previous(), "the registration kept before was not put back")
        #expect(deletions() == [newHandle: newSecret], "the new handle was not deleted with its own secret, or the kept one was deleted")
        #expect(memory.keep.pending().isEmpty)
    }

    @Test func aSignOutWhileTheServerAnswersNeverBringsTheRegistrationBack() async throws {
        let memory = PushMemory(session: maya, registration: previous())
        let registrar = registrar(memory)
        // Signed out as the PUT arrives: the wipe forgets what is kept (the new handle by then), then the server refuses.
        answering(put: 500) {
            registrar.forget()
            memory.set { $0.session = nil }
        }
        await #expect(throws: (any Error).self) { try await registrar.register(token: token, relay: Self.relay) }
        await registrar.drain()
        #expect(memory.keep.read() == nil, "a registration came back after the sign-out")
        #expect(deletions() == [newHandle: newSecret, oldHandle: oldSecret], "a handle was left with nobody to delete it")
        #expect(memory.keep.pending().isEmpty)
    }

    @Test func anotherAccountSignedInMeanwhileGetsNothingOfTheFirsts() async throws {
        let memory = PushMemory(session: maya, registration: previous())
        let registrar = registrar(memory)
        answering(put: 500) {
            registrar.forget()
            memory.set { $0.session = other }
        }
        await #expect(throws: (any Error).self) { try await registrar.register(token: token, relay: Self.relay) }
        await registrar.drain()
        #expect(memory.keep.read() == nil, "Maya's registration was written under Sam's session")
        #expect(Set(deletions().keys) == [newHandle, oldHandle])
    }

    @Test func theSameTokenAtTheSameRelaySendsTheKeptHandleAgainAndRegistersNothing() async throws {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        let memory = PushMemory(session: maya, registration: previous(token: hex))
        answering(put: 200)
        try await registrar(memory).register(token: token, relay: Self.relay)
        #expect(seen.map(\.method) == ["PUT"], "the relay was asked for another handle for the same token")
        #expect(seen.first?.body["handle"] == oldHandle)
        #expect(memory.keep.read() == previous(token: hex))
    }

    @Test func aNewTokenRegistersAfreshAndDeletesTheOldHandleWithItsSecret() async throws {
        let memory = PushMemory(session: maya, registration: previous())
        answering(put: 200)
        let registrar = registrar(memory)
        try await registrar.register(token: token, relay: Self.relay)
        await registrar.drain()
        #expect(memory.keep.read()?.handle == newHandle)
        #expect(memory.keep.read()?.deleteSecret == newSecret)
        #expect(seen.first { $0.method == "PUT" }?.body["handle"] == newHandle, "the server was given something other than the new handle")
        #expect(deletions() == [oldHandle: oldSecret])
    }

    @Test func aDeletionTheRelayDidntConfirmIsKeptAndTriedAgain() async throws {
        let memory = PushMemory(session: maya, registration: previous())
        PushStubProtocol.lock.withLock {
            PushStubProtocol.seen = []
            PushStubProtocol.answer = { _, _ in (503, "{}") }
        }
        let registrar = registrar(memory)
        registrar.forget()
        await registrar.drain()
        #expect(memory.keep.read() == nil)
        #expect(memory.keep.pending().map(\.handle) == [oldHandle], "a deletion the relay never confirmed was let go")
        // Next start: the relay answers. 404 counts too: the handle is gone either way.
        PushStubProtocol.lock.withLock { PushStubProtocol.answer = { _, _ in (404, #"{"code":"not-found"}"#) } }
        await registrar.drain()
        #expect(memory.keep.pending().isEmpty)
        #expect(deletions() == [oldHandle: oldSecret])
    }
}

/* Which APNs a build's token is for, from its provisioning profile's entitlements. */
@Suite struct ApsEnvironmentTests {
    func profile(_ entitlements: String) -> Data {
        // A profile is a CMS envelope with the plist in the clear: some bytes, the plist, some bytes.
        Data([0x30, 0x82, 0x01, 0x00]) + Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>
        """.utf8) + Data([0xA0, 0x00, 0xFF])
    }

    @Test func aDevelopmentProfileIsTheSandbox() {
        #expect(AppGroup.apsEnvironment(inProfile: profile("<key>aps-environment</key><string>development</string>")) == "development")
    }

    @Test func anAdHocOrDistributionProfileIsProduction() {
        #expect(AppGroup.apsEnvironment(inProfile: profile("<key>aps-environment</key><string>production</string>")) == "production")
    }

    @Test func aProfileWithoutPushGrantsNone() {
        // A sideloading tool's profile: an app group, no push. The app then hides its notifications.
        #expect(AppGroup.apsEnvironment(inProfile: profile("<key>com.apple.security.application-groups</key><array><string>group.x</string></array>")) == nil)
        #expect(AppGroup.apsEnvironment(inProfile: Data("not a profile".utf8)) == nil)
    }
}
