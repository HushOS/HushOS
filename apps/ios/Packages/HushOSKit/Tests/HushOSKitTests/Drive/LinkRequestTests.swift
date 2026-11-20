import Foundation
import Testing
@testable import HushOSKit

/*
 * A link's token names the link to the server and nobody else: it travels in the
 * `x-link-token` header, never in the path a reverse proxy writes to its access log. Each
 * visitor route is asked once; the request that left the app must carry the token in the
 * header and nowhere in the URL.
 */
@Suite(.serialized) struct LinkRequestTests {
    let token = "Tk_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    let node = UUID().uuidString.lowercased()
    let version = UUID().uuidString.lowercased()

    func api() -> PublicAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RecordingProtocol.self]
        return PublicAPI(origin: "https://drive.test", configuration: configuration)
    }

    /* Runs `call` (its reply fails to decode, which doesn't matter) and returns the one request it sent. */
    func sent(_ call: (PublicAPI) async throws -> Void) async -> URLRequest? {
        RecordingProtocol.reset()
        _ = try? await call(api())
        return RecordingProtocol.requests.first
    }

    func expectTokenOnlyInHeader(_ request: URLRequest?, path: String) throws {
        let request = try #require(request)
        let url = try #require(request.url)
        #expect(url.path == "/api/drive" + path)
        #expect(!url.absoluteString.contains(token))
        #expect(request.value(forHTTPHeaderField: "x-link-token") == token)
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
    }

    @Test func openingALinkSendsItsTokenInTheHeaderNotThePath() async throws {
        try expectTokenOnlyInHeader(await sent { _ = try await $0.openLink(token: token) }, path: "/links/open")
    }

    @Test func listingAFolderInALinkSendsItsTokenInTheHeaderNotThePath() async throws {
        try expectTokenOnlyInHeader(await sent { _ = try await $0.linkChildren(token: token, nodeId: node, after: nil) }, path: "/links/nodes/\(node)/children")
    }

    @Test func fetchingAFileInALinkSendsItsTokenInTheHeaderNotThePath() async throws {
        try expectTokenOnlyInHeader(await sent { _ = try await $0.linkVersionURL(token: token, versionId: version) }, path: "/links/versions/\(version)/url")
    }

    @Test func thumbnailsInALinkSendTheTokenInTheHeaderNotThePath() async throws {
        let request = await sent { _ = try await $0.linkThumbnails(token: token, versionIds: [version]) }
        try expectTokenOnlyInHeader(request, path: "/links/thumbnails")
        #expect(request?.url?.query == "versions=\(version)")
    }

    /* The old path form answers 410: said as the server says it, not as a missing link. */
    @Test func anOldServerAnswerIsReportedAsItsOwnMessage() async throws {
        RecordingProtocol.reset(status: 410, body: #"{"message":"Update HushOS to open links"}"#)
        let error = await #expect(throws: DriveAPIError.self) { _ = try await api().openLink(token: token) }
        guard case .server(410, let message)? = error else { Issue.record("Not the server's 410: \(String(describing: error))"); return }
        #expect(message == "Update HushOS to open links")
    }
}

/* Keeps every request it is handed and answers each with one fixed reply. */
final class RecordingProtocol: URLProtocol {
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = "{}"
    static let lock = NSLock()

    static func reset(status: Int = 200, body: String = "{}") {
        lock.withLock {
            requests = []
            self.status = status
            self.body = body
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body) = Self.lock.withLock {
            Self.requests.append(request)
            return (Self.status, Self.body)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
