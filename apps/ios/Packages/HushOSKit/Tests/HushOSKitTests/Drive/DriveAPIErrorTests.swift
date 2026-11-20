import Foundation
import Testing
@testable import HushOSKit

/*
 * The server's 409 for "this item or a folder above it is in the trash" carries the code
 * `trashed`; Files treats that as gone. Any other 409 is an ordinary refusal and must not be.
 */
struct DriveAPIErrorTests {
    private func failure(host: String) async -> Error? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConflictProtocol.self]
        let api = DriveAPI(session: .init(origin: "http://\(host)", token: "t", userId: "u"), configuration: configuration)
        do {
            _ = try await api.workspace()
            return nil
        } catch {
            return error
        }
    }

    @Test func aTrashedConflictIsTrashed() async {
        guard case DriveAPIError.trashed(let message)? = await failure(host: "trashed.test") else {
            Issue.record("expected .trashed")
            return
        }
        #expect(message == "That folder is in the trash.")
    }

    @Test func aTrashedConflictWithoutAMessageIsStillTrashed() async {
        guard case DriveAPIError.trashed? = await failure(host: "trashed-bare.test") else {
            Issue.record("expected .trashed")
            return
        }
    }

    @Test func anotherConflictStaysAServerRefusal() async {
        guard case DriveAPIError.server(let status, let message)? = await failure(host: "stale.test") else {
            Issue.record("expected .server")
            return
        }
        #expect(status == 409)
        #expect(message == "Someone changed this first.")
    }

    @Test func aConflictWithoutACodeStaysAServerRefusal() async {
        guard case DriveAPIError.server(409, _)? = await failure(host: "nocode.test") else {
            Issue.record("expected .server(409, …)")
            return
        }
    }
}

/* Answers every request with a 409 whose body depends on the host asked. */
final class ConflictProtocol: URLProtocol {
    private static let bodies: [String: [String: String]] = [
        "trashed.test": ["code": "trashed", "message": "That folder is in the trash."],
        "trashed-bare.test": ["code": "trashed"],
        "stale.test": ["code": "stale_epoch", "message": "Someone changed this first."],
        "nocode.test": ["message": "Conflict"],
    ]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = Self.bodies[request.url?.host ?? ""] ?? [:]
        let response = HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
