import Foundation
import Testing
@testable import HushOSKit

/*
 * What a person reads when something fails. A request cancelled because its screen went away
 * must say nothing (Android showed "The coroutine was canceled because it left the composition";
 * here a tab switched mid-load marked every file "Couldn't check"), a real outage must still say
 * so, and no error's own text (a path, a type name, a library's sentence) may reach the screen.
 */
@Suite(.serialized)
struct ErrorWordsTests {
    private static let marker = "secret-marker-7f3a"

    private func api(_ protocolClass: AnyClass, host: String = "words.test") -> DriveAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return DriveAPI(session: .init(origin: "http://\(host)", token: "t", userId: "u"), configuration: configuration)
    }

    @Test func aRequestCancelledMidFlightIsACancellationAndSaysNothing() async throws {
        let api = api(HangingProtocol.self)
        let request = Task { try await api.workspace() }
        try await Task.sleep(for: .milliseconds(200))
        request.cancel()
        let result = await request.result
        guard case .failure(let error) = result else { Issue.record("a hanging request answered"); return }
        #expect(error is CancellationError, "a cancelled request came back as \(type(of: error)), which the screens show as no network")
        #expect(ErrorWords.isCancellation(error))
        #expect(ErrorWords.say(error) == nil)
        // Nobody refused anything: a family sync cancelled half-way forgets nothing.
        #expect(FamilySync.unanswered(error))
    }

    @Test func aRealOutageIsStillNoAnswer() async {
        do {
            _ = try await api(OfflineProtocol.self).workspace()
            Issue.record("an unreachable server answered")
        } catch {
            guard case DriveAPIError.transport = error else { Issue.record("an outage came back as \(type(of: error))"); return }
            #expect(!ErrorWords.isCancellation(error))
            #expect(ErrorWords.say(error) == AuthError.unreachable)
        }
    }

    @Test func aRefusalWithoutAMessageIsSaidInPlainWords() async {
        do {
            _ = try await api(BadGatewayProtocol.self).workspace()
            Issue.record("a 502 answered")
        } catch {
            let words = ErrorWords.say(error)
            #expect(words == DriveAPIError.noReply)
            #expect(words?.contains("Request failed") == false)
        }
    }

    @Test func noCancellationIsEverSaid() {
        for error: Error in [CancellationError(), CocoaError(.userCancelled)] {
            #expect(ErrorWords.say(error) == nil, "\(error) was put on screen")
        }
        // A URL request cancelled with the task waiting for it: the screen went away.
        for error: Error in [URLError(.cancelled), NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)] {
            #expect(ErrorWords.isCancellation(error, taskCancelled: true), "\(error) under a cancelled task was taken for a failure")
        }
    }

    /*
     * URLSession says "cancelled" too when the system ends a request or a session is torn down.
     * With the task still running that is no answer: retried by the queue, said to the person,
     * never swallowed as if the screen had gone away (a failed upload would look finished).
     */
    @Test func aRequestTheSystemCancelledIsNoAnswerAndIsRetried() async throws {
        let api = api(SystemCancelProtocol.self)
        do {
            _ = try await api.workspace()
            Issue.record("a cancelled request answered")
        } catch {
            guard case DriveAPIError.transport = error else { Issue.record("came back as \(type(of: error)), which nothing retries or reports"); return }
            #expect(!ErrorWords.isCancellation(error))
            #expect(Resumable.retryable(error))
            #expect(ErrorWords.say(error) == AuthError.unreachable)
        }
        for error: Error in [URLError(.cancelled), NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)] {
            #expect(!ErrorWords.isCancellation(error, taskCancelled: false))
            #expect(ErrorWords.say(error) == AuthError.unreachable)
        }
        // The queue's loop tries again, and the second try lands.
        var tries = 0
        let landed = try await Resumable.run(online: { true }, sleep: { _ in }) { () async throws -> Int in
            tries += 1
            if tries == 1 { _ = try await api.workspace() }
            return tries
        }
        #expect(landed == 2)
    }

    @Test func aFamilyReadIsCancelledOnlyWhenItsTaskIs() async throws {
        let hanging = GroupsAPI(drive: api(HangingProtocol.self))
        let request = Task { try await hanging.listGroups() }
        try await Task.sleep(for: .milliseconds(200))
        request.cancel()
        guard case .failure(let error) = await request.result else { Issue.record("a hanging read answered"); return }
        #expect(error is CancellationError, "a cancelled family read came back as \(type(of: error))")
        do {
            _ = try await GroupsAPI(drive: api(SystemCancelProtocol.self)).listGroups()
            Issue.record("a cancelled read answered")
        } catch {
            #expect((error as? GroupsAPIError)?.status == 0, "a read the system cancelled came back as \(type(of: error)), not no answer")
        }
    }

    @Test func anErrorsOwnTextNeverReachesTheScreen() {
        struct Library: LocalizedError { var errorDescription: String? { "Library failed at \(ErrorWordsTests.marker)" } }
        struct Plain: Error, CustomStringConvertible { var description: String { ErrorWordsTests.marker } }
        let raw: [Error] = [
            NSError(domain: "com.example", code: 7, userInfo: [NSLocalizedDescriptionKey: "Failed: \(Self.marker)"]),
            CocoaError(.fileReadNoSuchFile, userInfo: [NSFilePathErrorKey: "/private/var/mobile/\(Self.marker).pdf"]),
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: Self.marker)),
            Library(),
            Plain(),
        ]
        for error in raw {
            let words = ErrorWords.say(error, otherwise: "Couldn’t save it. Try again.")
            #expect(words == "Couldn’t save it. Try again.", "\(type(of: error)) said \(words ?? "nothing")")
        }
        #expect(ErrorWords.say(URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: Self.marker])) == AuthError.unreachable)
    }

    @Test func hushOSsOwnWordsAreKept() {
        #expect(ErrorWords.say(DriveAPIError.server(402, "x")) == DriveAPIError.noRoom)
        #expect(ErrorWords.say(AuthError.wrongPassword) == AuthError.wrongPassword.errorDescription)
        #expect(ErrorWords.say(ContactError.unpinned) == ContactError.unpinned.errorDescription)
        #expect(ErrorWords.say(DriveAPIError.transport(Self.marker)) == AuthError.unreachable)
    }

    @Test func aTrustLoadThatFailsSaysPlainWords() async {
        struct Raw: Error, CustomStringConvertible { var description: String { ErrorWordsTests.marker } }
        let state = await TrustState.load { throw Raw() }
        guard case .failed(let words) = state else { Issue.record("a throwing load was taken as loaded"); return }
        #expect(!words.contains(Self.marker))
        #expect(!words.contains("Raw"))
    }

    @Test func aRecoveryFailureNeverSaysTheErrorsType() {
        struct Raw: Error, CustomStringConvertible { var description: String { "Raw(message: \"\(ErrorWordsTests.marker)\")" } }
        let words = Recovery.message(Raw())
        #expect(!words.contains(Self.marker))
        #expect(words == "Please try again.")
    }
}

/* Never answers: the request waits until it is cancelled. */
final class HangingProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {}
    override func stopLoading() {}
}

/* The system ends the request ("cancelled") while the task waiting for it is still running. */
final class SystemCancelProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}

/* No network at all. */
final class OfflineProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}

/* A proxy's 502 page: HTML, no JSON message. */
final class BadGatewayProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 502, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/html"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("<html>Bad gateway</html>".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
