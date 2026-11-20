import Foundation
import Testing
@testable import HushOSKit

/* Every request answered 401: the server no longer knows the session it was sent under. */
final class RefusingProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"message":"Sign in"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/*
 * A 401 says "signed out" only for the session in use. The same account signed in again (a new
 * session) while a write of the old one was out: that write's late 401 is the old session's, and
 * must neither sign the new one out nor lead to its being deleted. Fails if a refusal doesn't say
 * which session it was for, or if one for an old session ends the new one.
 */
@Suite struct SessionEndTests {
    let old = SharedKeychain.Session(origin: "https://drive.test", token: "old-token", userId: "u1")
    let new = SharedKeychain.Session(origin: "https://drive.test", token: "new-token", userId: "u1")

    func refusal(under session: SharedKeychain.Session) async -> Error? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RefusingProtocol.self]
        do {
            _ = try await DriveAPI(session: session, configuration: configuration).workspace()
            return nil
        } catch {
            return error
        }
    }

    @Test func aLate401FromTheOldSessionLeavesTheNewOneSignedIn() async throws {
        let error = try #require(await refusal(under: old))
        #expect(endsSession(error), "a 401 is still a refusal")
        #expect(!endsSession(error, current: new), "an old session's late 401 ended the new one")
        #expect(endsSession(error, current: old))
    }

    @Test func aRefusalOfTheSessionInUseEndsIt() async throws {
        let error = try #require(await refusal(under: new))
        #expect(endsSession(error, current: new))
    }

    @Test func aRefusalThatDoesntSayWhoseIsTakenAsTheSessionInUse() {
        #expect(endsSession(DriveAPIError.notAuthenticated(), current: new))
        #expect(endsSession(AuthError.sessionEnded(), current: new))
        #expect(!endsSession(AuthError.sessionEnded(session: old.tag), current: new))
        #expect(!endsSession(DriveAPIError.transport("offline"), current: new))
    }

    /* The tag names the session, never its secret, and two sessions of one account differ. */
    @Test func aSessionsTagIsNotItsTokenAndTellsSessionsApart() {
        #expect(old.tag != new.tag)
        #expect(!old.tag.contains("old-token"))
        #expect(old.tag == SharedKeychain.Session(origin: old.origin, token: old.token, userId: old.userId).tag)
    }
}
