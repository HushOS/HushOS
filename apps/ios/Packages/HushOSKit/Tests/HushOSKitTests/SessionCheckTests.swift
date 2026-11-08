import Foundation
import Testing
@testable import HushOSKit

/*
 * The session check at launch: an answer about the session (200, or a refusal such as 401)
 * decides it, but an error on the server's own side (5xx, 408, 429) is thrown, as when HushOS
 * can't be reached, so the app keeps the stored session as if offline. Before, any answer but
 * 200 read as `.ended` and signed everyone out during an outage or a deploy.
 */
@Suite struct SessionCheckTests {
    /* Answers with the status named in the host (`status-503.test`) and an empty body. (A 200's body: DevicesTests.) */
    final class Answering: URLProtocol {
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            let host = request.url?.host() ?? ""
            let status = Int(host.split(separator: ".").first?.split(separator: "-").last ?? "") ?? 0
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    func check(_ status: Int) async throws -> Auth.SessionCheck {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Answering.self]
        return try await Auth.checkSession(
            SharedKeychain.Session(origin: "https://status-\(status).test", token: "t", userId: "u"),
            transport: configuration
        )
    }

    @Test func aServerErrorIsNotASignOut() async throws {
        for status in [500, 502, 503, 504, 408, 429] {
            await #expect(throws: Auth.SessionUnavailable(status: status)) { try await check(status) }
        }
    }

    @Test func anAnswerAboutTheSessionStillDecidesIt() async throws {
        #expect(try await check(401) == .ended)
        #expect(try await check(403) == .ended)
    }
}
