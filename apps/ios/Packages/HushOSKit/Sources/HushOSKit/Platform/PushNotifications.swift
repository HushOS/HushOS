import Foundation

/*
 * Push notifications on this iPhone (docs/devices-design.md 5; docs/push-relay-plan.md, PR 4).
 *
 * The APNs token goes to the relay the server names (push.hushos.com, `push_relay_usable` in the
 * core), which answers with a handle and a deletion secret. Only the handle goes to the server.
 * The registration is kept in the shared keychain, where the Notification Service Extension reads
 * it to check a push's tag: it is account data, forgotten on every wipe (AccountStore). A forgotten
 * or replaced handle waits in a pending-deletion record, outside the account's data, until its
 * relay confirms the deletion. A push carries an event id and the tag; the extension fetches the
 * event over the session and writes the notice in the core's words, or leaves "New activity in
 * HushOS".
 */

/* This phone's registration with the relay, for one account on one server. */
public struct PushRegistration: Codable, Sendable, Equatable {
    public let origin: String
    public let userId: String
    public let relay: String
    public let platform: String
    /* The APNs token, hex: a new one means registering again. */
    public let token: String
    public let handle: String
    /* Deletes the handle at the relay; never leaves this phone but for that. */
    public let deleteSecret: String

    public init(origin: String, userId: String, relay: String, platform: String, token: String, handle: String, deleteSecret: String) {
        self.origin = origin
        self.userId = userId
        self.relay = relay
        self.platform = platform
        self.token = token
        self.handle = handle
        self.deleteSecret = deleteSecret
    }

    /* Whether it was made for `session`'s account on its server. */
    public func belongs(to session: SharedKeychain.Session) -> Bool {
        origin == session.origin && userId.lowercased() == session.userId.lowercased()
    }
}

/* A handle waiting to be deleted at its relay, kept until the relay answers 204 or 404. */
public struct PushPendingDeletion: Codable, Sendable, Equatable {
    public let relay: String
    public let handle: String
    public let deleteSecret: String

    init(_ registration: PushRegistration) {
        relay = registration.relay
        handle = registration.handle
        deleteSecret = registration.deleteSecret
    }
}

/*
 * The names a notice may give a sharer: this account's contacts verified by words here and not
 * trusted through a family, user id to name. The app writes it as it reads the settings
 * (`Vault.loadSettings`), so the extension never opens the settings document inside its memory
 * limit. A `ThisDeviceOnly` keychain item, deleted on every wipe. Missing or out of date, the notice
 * says "Someone".
 */
public struct PushContactNames: Codable, Sendable, Equatable {
    public let origin: String
    public let userId: String
    public let names: [String: String]

    static let account = "push-contacts"

    func belongs(to session: SharedKeychain.Session) -> Bool {
        origin == session.origin && userId.lowercased() == session.userId.lowercased()
    }

    /* The names from these pins (the web's rule: verified, not through a family, and named). */
    static func of(_ pins: some Sequence<ContactPin>, session: SharedKeychain.Session) -> PushContactNames {
        var names: [String: String] = [:]
        for pin in pins where pin.trustedVia == nil && !pin.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pin.verified {
            names[pin.userId.lowercased()] = pin.name
        }
        return PushContactNames(origin: session.origin, userId: session.userId, names: names)
    }

    /* Kept for the session signed in, while this phone has notifications on for it; written only when it changed. */
    static func remember(_ pins: some Sequence<ContactPin>, session: SharedKeychain.Session) {
        PushRegistrar.shared.remember(of(pins, session: session), session: session)
    }

    static func name(of userId: String, session: SharedKeychain.Session) -> String? {
        guard let kept = SharedKeychain.read(account, as: PushContactNames.self), kept.belongs(to: session) else { return nil }
        return kept.names[userId.lowercased()]
    }
}

/*
 * Where the registration state lives: the shared keychain and the app group, or a test's memory.
 * The pending deletions are not account data: they outlive a sign-out until the relay has them.
 */
public struct PushKeep: Sendable {
    public var session: @Sendable () -> SharedKeychain.Session?
    public var read: @Sendable () -> PushRegistration?
    public var write: @Sendable (PushRegistration) -> Bool
    public var delete: @Sendable () -> Void
    public var pending: @Sendable () -> [PushPendingDeletion]
    public var setPending: @Sendable ([PushPendingDeletion]) -> Bool
    /* The checked contacts' names the extension reads (`PushContactNames`); nil deletes them. */
    public var contacts: @Sendable () -> PushContactNames?
    public var setContacts: @Sendable (PushContactNames?) -> Void

    static let registrationAccount = "push-registration"
    static let pendingAccount = "push-pending-deletions"

    static let keychain = PushKeep(
        session: { SharedKeychain.session },
        read: { SharedKeychain.read(registrationAccount, as: PushRegistration.self) },
        write: { (try? SharedKeychain.write(registrationAccount, $0)) != nil },
        delete: { SharedKeychain.delete(registrationAccount) },
        pending: { SharedKeychain.read(pendingAccount, as: [PushPendingDeletion].self) ?? [] },
        setPending: { list in
            if list.isEmpty {
                SharedKeychain.delete(pendingAccount)
                return true
            }
            return (try? SharedKeychain.write(pendingAccount, list)) != nil
        },
        contacts: { SharedKeychain.read(PushContactNames.account, as: PushContactNames.self) },
        setContacts: { names in
            if let names { try? SharedKeychain.write(PushContactNames.account, names) } else { SharedKeychain.delete(PushContactNames.account) }
        }
    )
}

/* One after another: each operation starts once the one before it has finished, its awaits included. */
actor PushTurns {
    private var last: Task<Void, Never>?

    func run<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = last
        let task = Task { () async throws -> T in
            await previous?.value
            return try await operation()
        }
        last = Task { _ = try? await task.value }
        return try await task.value
    }
}

/* Refuses every redirect: neither the relay nor the server sends one, and one that did would be sent the handle or session again. */
final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}

/*
 * Registering, turning off and forgetting, one at a time (`turns`). Forgetting is synchronous (a
 * wipe calls it) and moves `generation` under `lock`; every write of the registration is made under
 * the same lock and only while the session it began under is still signed in and nothing forgot
 * registrations since. So a registration never comes back after a sign-out.
 */
final class PushRegistrar: @unchecked Sendable {
    let keep: PushKeep
    let transport: URLSessionConfiguration
    let platform: String
    let usable: @Sendable (String?) -> String?
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private let turns = PushTurns()
    private let deletions = PushTurns()

    init(keep: PushKeep, transport: URLSessionConfiguration, platform: String, usable: @escaping @Sendable (String?) -> String?) {
        self.keep = keep
        self.transport = transport
        self.platform = platform
        self.usable = usable
    }

    static let shared = PushRegistrar(keep: .keychain, transport: .ephemeral, platform: PushNotifications.platform, usable: PushNotifications.usable)

    // MARK: Requests

    func request(_ session: SharedKeychain.Session, _ path: String, method: String = "GET", body: [String: Any]? = nil,
                 timeout: TimeInterval = 20) async throws -> (status: Int, json: [String: Any], data: Data) {
        guard let url = URL(string: session.origin + path) else { throw AuthError.message("Bad HushOS address.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        let cookieName = session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue(session.origin, forHTTPHeaderField: "Origin")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        request.timeoutInterval = timeout
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: transport).data(for: request, delegate: RefuseRedirects())
        } catch {
            if ErrorWords.isCancellation(error) { throw CancellationError() }
            throw AuthError.message(AuthError.unreachable)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw AuthError.sessionEnded(session: session.tag) }
        return (status, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:], data)
    }

    static func refusal(_ json: [String: Any]) -> PushNotifications.PushError {
        .refused(json["message"] as? String ?? "Something went wrong on HushOS. Try again in a moment.")
    }

    private func putHandle(_ handle: String, _ session: SharedKeychain.Session) async throws {
        let reply = try await request(session, "/api/notifications/registration", method: "PUT", body: ["kind": "relay", "handle": handle])
        guard reply.status == 200 else { throw Self.refusal(reply.json) }
    }

    private func relayRegister(_ relay: String, token: String) async throws -> (handle: String, secret: String) {
        guard let url = URL(string: relay + "/v1/register") else { throw PushNotifications.PushError.refused("The push relay’s address isn’t right.") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["platform": platform, "token": token])
        request.timeoutInterval = 20
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession(configuration: transport).data(for: request, delegate: RefuseRedirects())
        } catch {
            if ErrorWords.isCancellation(error) { throw CancellationError() }
            throw PushNotifications.PushError.refused("HushOS couldn’t reach its push relay. Check your connection, then try again.")
        }
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200, let handle = json["handle"] as? String, let secret = json["deleteSecret"] as? String,
              (try? base64urlDecode(value: handle))?.count == 32, (try? base64urlDecode(value: secret))?.count == 32
        else { throw PushNotifications.PushError.refused("The push relay didn’t take this iPhone. Try again later.") }
        return (handle, secret)
    }

    /* Whether the relay has let the handle go: 204, or 404 (already gone, or never known). Anything else is tried again later. */
    private func relayDelete(_ pending: PushPendingDeletion) async -> Bool {
        guard let url = URL(string: pending.relay + "/v1/register/" + pending.handle),
              let body = try? JSONSerialization.data(withJSONObject: ["deleteSecret": pending.deleteSecret]) else { return false }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 15
        guard let (_, response) = try? await URLSession(configuration: transport).data(for: request, delegate: RefuseRedirects()) else { return false }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return status == 204 || status == 404
    }

    // MARK: Pending deletions

    /* Under `lock`. */
    private func addPending(_ registration: PushRegistration) {
        var list = keep.pending()
        guard !list.contains(where: { $0.handle == registration.handle }) else { return }
        list.append(PushPendingDeletion(registration))
        _ = keep.setPending(list)
    }

    /* A handle this phone no longer uses: kept for deletion, then deleted. */
    private func retire(_ registration: PushRegistration) async {
        lock.withLock { addPending(registration) }
        await drain()
    }

    /* Every pending deletion tried once more; each one the relay confirms is let go. At every start and after each retirement. */
    func drain() async {
        _ = try? await deletions.run { [self] in
            let list = lock.withLock { keep.pending() }
            var done: Set<String> = []
            for item in list {
                if await relayDelete(item) { done.insert(item.handle) }
            }
            guard !done.isEmpty else { return }
            lock.withLock { _ = keep.setPending(keep.pending().filter { !done.contains($0.handle) }) }
        }
    }

    // MARK: Register, turn off, forget

    /* Under `lock`: the session a step began under is still the one signed in, and nothing forgot registrations since. */
    private func stands(_ session: SharedKeychain.Session, _ began: UInt64) -> Bool {
        keep.session() == session && generation == began
    }

    func register(token: Data, relay: String) async throws {
        try await turns.run { [self] in try await registerNow(token: token, relay: relay) }
    }

    /*
     * The same token at the same relay sends the kept handle again (the server may have dropped it);
     * a new token or relay registers afresh. The new registration is kept before the server is told,
     * so a stop in between leaves the handle the next start sends again. A server that refuses it
     * puts back what was kept before, but only for the same session: never after a sign-out.
     */
    private func registerNow(token: Data, relay: String) async throws {
        guard let session = keep.session() else { throw AuthError.message("Sign in first.") }
        guard let relay = usable(relay) else { throw PushNotifications.PushError.refused("This server’s notifications can’t reach this iPhone.") }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        let began = lock.withLock { generation }
        let previous = keep.read()
        if let previous, previous.belongs(to: session), previous.relay == relay, previous.token == hex, previous.platform == platform {
            try await putHandle(previous.handle, session)
            return
        }
        let made = try await relayRegister(relay, token: hex)
        let next = PushRegistration(origin: session.origin, userId: session.userId, relay: relay, platform: platform, token: hex,
                                    handle: made.handle, deleteSecret: made.secret)
        let kept = lock.withLock { stands(session, began) && keep.write(next) }
        guard kept else {
            await retire(next)
            if lock.withLock({ stands(session, began) }) {
                throw PushNotifications.PushError.refused("This iPhone couldn’t keep its notification settings. Try again.")
            }
            throw CancellationError()
        }
        do {
            try await putHandle(made.handle, session)
        } catch {
            let restored = lock.withLock { () -> Bool in
                guard stands(session, began) else { return false }
                guard let previous, previous.belongs(to: session) else {
                    keep.delete()
                    return false
                }
                return keep.write(previous)
            }
            // What was overwritten and not put back would otherwise be nobody's to delete.
            if !restored, let previous { await retire(previous) }
            await retire(next)
            throw error
        }
        if let previous { await retire(previous) }
    }

    /* "On this phone" off: the server stops pinging this device, then the handle is forgotten here and deleted at the relay. */
    func turnOff() async throws {
        try await turns.run { [self] in
            guard let session = keep.session() else { throw AuthError.message("Sign in first.") }
            let reply = try await request(session, "/api/notifications/registration", method: "DELETE", body: [:])
            guard reply.status == 200 else { throw Self.refusal(reply.json) }
            let kept = lock.withLock { () -> PushRegistration? in
                guard keep.session() == session, let kept = keep.read(), kept.belongs(to: session) else { return nil }
                keep.delete()
                keep.setContacts(nil)
                return kept
            }
            if let kept { await retire(kept) }
        }
    }

    /*
     * A server that names no relay now, or another one: the kept registration can never be reached
     * or turned off from there, so it goes (the server told first, best effort).
     */
    func settle(relay: String?) async {
        _ = try? await turns.run { [self] in
            guard let session = keep.session(), let kept = keep.read(), kept.belongs(to: session), kept.relay != relay else { return }
            _ = try? await request(session, "/api/notifications/registration", method: "DELETE", body: [:])
            let gone = lock.withLock { () -> Bool in
                guard keep.session() == session, keep.read() == kept else { return false }
                keep.delete()
                keep.setContacts(nil)
                return true
            }
            if gone { await retire(kept) }
        }
    }

    /*
     * The checked contacts' names for the extension: written under the same lock as the registration,
     * only while this session is signed in with notifications on here, so no settings read finishing
     * after a sign-out or a turn-off can write them back.
     */
    func remember(_ names: PushContactNames, session: SharedKeychain.Session) {
        lock.withLock {
            guard keep.session() == session, keep.read()?.belongs(to: session) == true, keep.contacts() != names else { return }
            keep.setContacts(names)
        }
    }

    /* Every wipe: forgotten here at once, held for deletion, and deleted at the relay in the background. */
    func forget() {
        let kept = lock.withLock { () -> PushRegistration? in
            generation &+= 1
            let kept = keep.read()
            keep.delete()
            keep.setContacts(nil)
            if let kept { addPending(kept) }
            return kept
        }
        guard kept != nil else { return }
        Task.detached { [self] in await drain() }
    }
}

public enum PushNotifications {
    /* The two kinds a person can turn off, as the server keeps them; security notices always come. */
    public struct Toggles: Codable, Sendable, Equatable {
        public var shared: Bool
        public var family: Bool
        public init(shared: Bool, family: Bool) {
            self.shared = shared
            self.family = family
        }
    }

    /* What the server says: its toggles, and the relay this phone may register with (nil: no pushes to phones). */
    public struct ServerState: Sendable, Equatable {
        public var toggles: Toggles
        public let relay: String?
    }

    public enum PushError: WordedError, Equatable {
        /* The server or relay answered something other than what was asked: its words, or ours. */
        case refused(String)

        public var errorDescription: String? {
            switch self { case .refused(let words): words }
        }
    }

    public static var registration: PushRegistration? { PushKeep.keychain.read() }

    /* The relay `relay` names when this build may use it: push.hushos.com, or a relay on this Mac in a debug build. */
    static let usable: @Sendable (String?) -> String? = { relay in
        #if DEBUG
        pushRelayUsable(relay: relay, local: .thisComputer)
        #else
        pushRelayUsable(relay: relay, local: .none)
        #endif
    }

    /*
     * The APNs environment this build's token belongs to. The provisioning profile says, where there
     * is one (a development or ad hoc build); App Store and TestFlight builds carry none and are
     * production. The simulator's tokens are the sandbox's.
     */
    public static var platform: String {
        #if targetEnvironment(simulator)
        return "apns-sandbox"
        #else
        guard let profile = AppGroup.embeddedProfile(of: Bundle.main.bundleURL) else { return "apns" }
        return AppGroup.apsEnvironment(inProfile: profile) == "development" ? "apns-sandbox" : "apns"
        #endif
    }

    /*
     * Whether this build can get pushes at all: not a sideloaded one, whose profile (made by the
     * sideloading tool) grants no `aps-environment`, and whose bundle id isn't the relay's topic.
     */
    public static var available: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        guard let profile = AppGroup.embeddedProfile(of: Bundle.main.bundleURL) else { return true }
        return AppGroup.apsEnvironment(inProfile: profile) != nil
        #endif
    }

    // MARK: - The server's settings

    private static func state(from json: [String: Any]) throws -> ServerState {
        guard let settings = json["settings"] as? [String: Any], let shared = settings["shared"] as? Bool, let family = settings["family"] as? Bool else {
            throw PushError.refused("Your notification settings couldn’t be read. Try again.")
        }
        // A server from before `relay` names none: nothing would reach this phone.
        return ServerState(toggles: Toggles(shared: shared, family: family), relay: usable(json["relay"] as? String))
    }

    /*
     * The server's settings and relay; nil when it has notifications off (501 `off`). A server
     * naming no relay now, or another one, lets go of the registration kept for the old one.
     */
    public static func serverState() async throws -> ServerState? {
        guard let session = SharedKeychain.session else { throw AuthError.message("Sign in first.") }
        let reply = try await PushRegistrar.shared.request(session, "/api/notifications/settings")
        if reply.status == 501, reply.json["code"] as? String == "off" { return nil }
        guard reply.status == 200 else { throw PushRegistrar.refusal(reply.json) }
        let state = try state(from: reply.json)
        await PushRegistrar.shared.settle(relay: state.relay)
        return state
    }

    public static func save(_ toggles: Toggles) async throws -> Toggles {
        guard let session = SharedKeychain.session else { throw AuthError.message("Sign in first.") }
        let reply = try await PushRegistrar.shared.request(session, "/api/notifications/settings", method: "PUT",
                                                           body: ["shared": toggles.shared, "family": toggles.family])
        guard reply.status == 200 else { throw PushRegistrar.refusal(reply.json) }
        return try state(from: reply.json).toggles
    }

    // MARK: - Turning it on and off

    public static func register(token: Data, relay: String) async throws {
        try await PushRegistrar.shared.register(token: token, relay: relay)
    }

    public static func turnOff() async throws {
        try await PushRegistrar.shared.turnOff()
    }

    /*
     * Every wipe of the account on this phone (sign-out, deletion, a removal, another account in):
     * forgotten here at once and deleted at the relay with its secret, retried at every start until
     * the relay confirms. The server already dropped its row with the device.
     */
    public static func forget() {
        PushRegistrar.shared.forget()
    }

    /* At every start: handles still waiting to be deleted at their relay. */
    public static func retryDeletions() async {
        await PushRegistrar.shared.drain()
    }

    // MARK: - Notices

    /* A lowercase UUID, the only id that goes into a path. */
    static func isEventId(_ id: String) -> Bool {
        id.count == 36 && id == id.lowercased() && UUID(uuidString: id) != nil
    }

    /* Event ids this phone has shown, so the catch-up never shows one twice (`state/`, wiped with the account). */
    static let seenFile = "push-seen.json"
    static let seenKept = 500

    static func markSeen(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        var seen = Unbacked.read([String].self, seenFile) ?? []
        for id in ids where !seen.contains(id) { seen.append(id) }
        Unbacked.write(Array(seen.suffix(seenKept)), seenFile)
    }

    static func seen() -> Set<String> { Set(Unbacked.read([String].self, seenFile) ?? []) }

    /* The sharer's name for a notice, from the names the app kept (PushContactNames); nobody without them. */
    static func sender(of event: PushEvent, session: SharedKeychain.Session) -> String? {
        guard event.kind == .shared, let granter = event.granterUserId else { return nil }
        return PushContactNames.name(of: granter, session: session)
    }

    /*
     * The notice for a push's payload (`id`, `tag`): the event fetched over the session and put in
     * the core's words, or the fallback whenever anything doesn't hold (a tag that isn't this
     * registration's, another account signed in, a fetch that fails, an event gone). An event read
     * is marked seen, so the app's catch-up doesn't show it again.
     */
    public static func notice(for userInfo: [AnyHashable: Any]) async -> PushNotice {
        let registrar = PushRegistrar.shared
        guard let id = userInfo["id"] as? String, isEventId(id), let tag = userInfo["tag"] as? String,
              let session = registrar.keep.session(), let kept = registrar.keep.read(), kept.belongs(to: session),
              pushTagMatches(handle: kept.handle, tag: tag)
        else { return pushNoticeFallback() }
        do {
            let reply = try await registrar.request(session, "/api/notifications/" + id, timeout: 12)
            guard reply.status == 200 else { return pushNoticeFallback() }
            let event = try pushEventRead(json: String(decoding: reply.data, as: UTF8.self), expectedId: id)
            markSeen([id])
            return pushNotice(event: event, checkedSender: sender(of: event, session: session))
        } catch {
            return pushNoticeFallback()
        }
    }

    /* A notice the catch-up found, with the event it is about. */
    public struct Pending: Sendable {
        public let id: String
        public let notice: PushNotice
    }

    /*
     * When the app opens or comes back: what the server holds for this device that no push showed
     * (`GET /api/notifications`, which also answers the device's open ping, so later events are not
     * held back as coalesced). Only while this phone has notifications on for the account. Unseen
     * events come back in the core's words, at most the last ten; every one listed is marked seen.
     */
    public static func catchUp() async -> [Pending] {
        let registrar = PushRegistrar.shared
        guard let session = registrar.keep.session(), registrar.keep.read()?.belongs(to: session) == true else { return [] }
        var events: [PushEvent] = []
        for _ in 0 ..< 5 {
            guard let reply = try? await registrar.request(session, "/api/notifications"), reply.status == 200,
                  let page = try? pushEventsRead(json: String(decoding: reply.data, as: UTF8.self)) else { break }
            events += page.events
            if !page.more { break }
        }
        let seen = seen()
        let unseen = events.filter { !seen.contains($0.id) }
        markSeen(events.map(\.id))
        return unseen.suffix(10).map { Pending(id: $0.id, notice: pushNotice(event: $0, checkedSender: sender(of: $0, session: session))) }
    }
}

extension Vault {
    /* The settings read afresh, which keeps the names notices may give sharers (PushContactNames). */
    public func rememberPushContacts() async {
        _ = try? await loadSettings()
    }
}
