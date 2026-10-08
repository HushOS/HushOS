import Foundation
import Testing
@testable import HushOSKit

/*
 * Links that open the app. A share link carries its key after the #; losing it, or
 * opening another server's link against this one, or letting a crafted id through,
 * would each be noticed by someone.
 */
struct AppLinksTests {
    let server = "https://hushos.com"
    let token = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    let secret = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
    let folder = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    let file = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

    func parse(_ link: String, server: String? = nil) -> Result<AppLink, AppLinkRefusal> {
        AppLinks.parse(URL(string: link)!, server: server ?? self.server)
    }

    @Test func aShareLinkKeepsItsKeyExactly() {
        #expect(parse("https://hushos.com/s/\(token)#\(secret)") == .success(.share(url: "https://hushos.com/s/\(token)#\(secret)")))
    }

    @Test func aShareLinkWithoutItsKeyIsIncompleteNotOpened() {
        #expect(parse("https://hushos.com/s/\(token)") == .success(.incompleteShare))
        #expect(parse("https://hushos.com/s/\(token)#") == .success(.incompleteShare))
    }

    @Test func aShareLinkWithACutOrForgedKeyIsRefused() {
        #expect(parse("https://hushos.com/s/\(token)#\(secret.dropLast(5))") == .failure(.malformed))
        #expect(parse("https://hushos.com/s/short#\(secret)") == .failure(.malformed))
    }

    @Test func folderAndFileInTheViewer() {
        #expect(parse("https://hushos.com/app/drive") == .success(.files(folder: nil, preview: nil)))
        #expect(parse("https://hushos.com/app/drive?folder=\(folder)") == .success(.files(folder: folder, preview: nil)))
        #expect(parse("https://hushos.com/app/drive?folder=\(folder)&preview=\(file)") == .success(.files(folder: folder, preview: file)))
    }

    @Test func homeSharedAndTrash() {
        #expect(parse("https://hushos.com/app") == .success(.home))
        #expect(parse("https://hushos.com/app/shared") == .success(.shared(byMe: false)))
        #expect(parse("https://hushos.com/app/shared?view=by-me") == .success(.shared(byMe: true)))
        #expect(parse("https://hushos.com/app/trash") == .success(.trash))
    }

    @Test func billingAdminAndTheWebsiteStayOnTheWeb() {
        #expect(parse("https://hushos.com/app/billing") == .failure(.webOnly))
        #expect(parse("https://hushos.com/app/billing/plans") == .failure(.webOnly))
        #expect(parse("https://hushos.com/app/admin/reports") == .failure(.webOnly))
        #expect(parse("https://hushos.com/pricing") == .failure(.webOnly))
    }

    @Test func anotherServersLinkIsNotOpenedHere() {
        #expect(parse("https://evil.example/s/\(token)#\(secret)") == .failure(.otherServer(host: "evil.example")))
        #expect(parse("https://hushos.com.evil.example/app/drive") == .failure(.otherServer(host: "hushos.com.evil.example")))
        // Same host, another port: another server.
        #expect(parse("https://hushos.com:8443/app") == .failure(.otherServer(host: "hushos.com")))
        #expect(parse("http://localhost:5174/app", server: "http://localhost:5173") == .failure(.otherServer(host: "localhost")))
    }

    @Test func theCustomSchemeReachesTheSamePlacesOnTheSignedInServer() {
        #expect(parse("hushos://s/\(token)#\(secret)") == .success(.share(url: "https://hushos.com/s/\(token)#\(secret)")))
        #expect(parse("hushos://s/\(token)#\(secret)", server: "http://localhost:5173/") == .success(.share(url: "http://localhost:5173/s/\(token)#\(secret)")))
        #expect(parse("hushos://app/drive?folder=\(folder)") == .success(.files(folder: folder, preview: nil)))
        #expect(parse("hushos://app/shared?view=by-me") == .success(.shared(byMe: true)))
        #expect(parse("hushos://app") == .success(.home))
        #expect(parse("hushos://node/\(file)") == .success(.node(id: file)))
        #expect(parse("hushos://app/billing") == .failure(.webOnly))
    }

    @Test func idsThatAreNotIdsAreRefused() {
        #expect(parse("https://hushos.com/app/drive?folder=../../admin") == .failure(.malformed))
        #expect(parse("https://hushos.com/app/drive?folder=\(folder)&preview=<script>") == .failure(.malformed))
        #expect(parse("hushos://node/not-an-id") == .failure(.malformed))
        #expect(parse("hushos://node/\(file)/extra") == .failure(.malformed))
    }

    @Test func otherSchemesAreNotLinks() {
        #expect(parse("ftp://hushos.com/app") == .failure(.unsupported))
        #expect(parse("javascript:alert(1)") == .failure(.unsupported))
    }
}
