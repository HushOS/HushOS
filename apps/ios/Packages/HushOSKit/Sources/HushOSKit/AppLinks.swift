import Foundation
import HushOSCore

/*
 * Where a link opens in the app: the paths the web declares for the apps in
 * /.well-known/apple-app-site-association (apps/web/src/lib/app-links.server.ts),
 * plus the custom scheme with the same paths and the older hushos://node/<id>.
 * One pure function, so the rules that keep a link's secret and refuse another
 * server's links are tested once and used by every entry point.
 */
public enum AppLink: Equatable, Sendable {
    case home
    /* A folder (nil for the top), and a file in it to open in the viewer. */
    case files(folder: String?, preview: String?)
    case shared(byMe: Bool)
    case trash
    /* A share link, rebuilt on the signed-in server with its key: what LinkVault opens. */
    case share(url: String)
    /* A share link whose key (after the #) was cut off: "This link is incomplete". */
    case incompleteShare
    /* hushos://node/<id>: a file or folder, whichever it turns out to be. */
    case node(id: String)
    /* The emailed link that starts a password reset: /recover/complete#verify=<token>. */
    case recover(token: String)
}

public enum AppLinkRefusal: Error, Equatable, Sendable {
    /* A link to another HushOS server than the one signed in to. */
    case otherServer(host: String)
    /* A page that stays on the web (billing, the operator console, the website). */
    case webOnly
    /* An id or a share link that isn't well formed. */
    case malformed
    /* Not a HushOS link at all. */
    case unsupported
}

public enum AppLinks {
    /*
     * `server` is the signed-in origin (e.g. https://hushos.com). https links must name its
     * host and port; hushos:// links carry no host and always mean the signed-in server.
     */
    public static func parse(_ url: URL, server: String) -> Result<AppLink, AppLinkRefusal> {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let origin = URLComponents(string: server), let serverHost = origin.host?.lowercased() else { return .failure(.unsupported) }
        let path: [String]
        switch scheme {
        case "hushos":
            // hushos://app/drive?folder=… reads as host "app" and path "/drive".
            path = ([components.host ?? ""] + components.path.split(separator: "/").map(String.init)).filter { !$0.isEmpty }
        case "https", "http":
            let host = components.host?.lowercased() ?? ""
            guard host == serverHost, port(components) == port(origin) else { return .failure(.otherServer(host: host)) }
            path = components.path.split(separator: "/").map(String.init)
        default:
            return .failure(.unsupported)
        }
        let query = Dictionary((components.queryItems ?? []).compactMap { item in item.value.map { (item.name, $0) } }, uniquingKeysWith: { first, _ in first })

        switch path.first {
        case "recover":
            // The emailed reset link; its one-time token rides in the fragment and never reaches a server log.
            guard path == ["recover", "complete"] else { return .failure(.webOnly) }
            let fragment = URLComponents(string: "?" + (components.fragment ?? ""))?.queryItems ?? []
            guard let token = fragment.first(where: { $0.name == "verify" })?.value, isToken(token) else { return .failure(.malformed) }
            return .success(.recover(token: token))
        case "node":
            guard path.count == 2, isId(path[1]) else { return .failure(.malformed) }
            return .success(.node(id: path[1].lowercased()))
        case "s":
            guard path.count == 2 else { return .failure(.malformed) }
            let token = path[1]
            // The key never reaches a server; without it the link opens nothing.
            guard let secret = components.fragment, !secret.isEmpty else {
                return isToken(token) ? .success(.incompleteShare) : .failure(.malformed)
            }
            let base = server.hasSuffix("/") ? String(server.dropLast()) : server
            let rebuilt = "\(base)/s/\(token)#\(secret)"
            guard (try? linkParse(url: rebuilt)) != nil else { return .failure(.malformed) }
            return .success(.share(url: rebuilt))
        case "app":
            let page = path.dropFirst()
            switch page.first {
            case nil:
                return .success(.home)
            case "drive":
                guard page.count == 1 else { return .failure(.webOnly) }
                let folder = query["folder"], preview = query["preview"]
                if let folder, !isId(folder) { return .failure(.malformed) }
                if let preview, !isId(preview) { return .failure(.malformed) }
                return .success(.files(folder: folder?.lowercased(), preview: preview?.lowercased()))
            case "shared":
                guard page.count == 1 else { return .failure(.webOnly) }
                return .success(.shared(byMe: query["view"] == "by-me"))
            case "trash":
                guard page.count == 1 else { return .failure(.webOnly) }
                return .success(.trash)
            default:
                // /app/admin, /app/billing and every other page stay on the web.
                return .failure(.webOnly)
            }
        default:
            return .failure(.webOnly)
        }
    }

    static func port(_ components: URLComponents) -> Int? {
        if let port = components.port { return port }
        switch components.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    /* Node ids are UUIDs; anything else (a path, a query, a script) is refused before it reaches a lookup. */
    static func isId(_ value: String) -> Bool { UUID(uuidString: value) != nil }

    /* A link token is 32 bytes of base64url: 43 characters. */
    static func isToken(_ value: String) -> Bool {
        value.count == 43 && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}
