import Foundation
import Testing
@testable import HushOSKit

/*
 * The session check at launch: the server answers every session with 200, so a 200 decides it
 * (its body: DevicesTests), and anything else came from something in the way (an outage, a
 * deploy, a proxy) and is thrown, as when HushOS can't be reached, so the app keeps the stored
 * session as if offline. Before, any answer but 200 read as `.ended` and signed everyone out.
 */
@Suite struct SessionCheckTests {
    /* Answers with the status named in the host (`status-503.test`) and an empty body. */
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

    @Test func anyAnswerButTwoHundredIsNotASignOut() async throws {
        for status in [500, 502, 503, 504, 408, 429, 401, 403, 404, 421] {
            await #expect(throws: Auth.SessionUnavailable(status: status)) { try await check(status) }
        }
    }
}
