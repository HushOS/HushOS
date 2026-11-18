import Foundation
import HushOSCore
import UniformTypeIdentifiers

/*
 * A zip open in the viewer (docs/file-tools-design.md, section 1 (a) and section 6): the core's
 * ZipArchiveSession, which lists the archive from its central directory and reads the entries asked
 * for, by range, through a VersionReader of their own. Browsing is a viewer, not a run: it never
 * takes ToolRuns' one-run slot, but each call keeps the harness's rules. It runs on a thread of its
 * own (the core blocks) under a fresh RunControl, the watchdog polled each second, cancelled with
 * the calling task, and `finish()`ed when the thread returns, which wipes that call's reader.
 * Calls take turns before they start, so one waiting behind a long download never counts against
 * its own watchdog. A password the person typed lives in the core's session, in memory, until the
 * archive is closed: on leaving the viewer, and on sign-out (`ArchiveSessions.closeAll`).
 */

/* Why an archive or an entry wasn't read, in the person's words; `code` is the core's refusal, nil for a failure underneath. */
public struct ArchiveFailure: Error, Equatable, LocalizedError {
    public let code: String?
    public let message: String
    public var errorDescription: String? { message }

    /* A call on an archive that closed, in the core's words for it. */
    static let closed = ArchiveFailure(code: nil, message: "The archive was closed.")

    static func from(_ error: Error, control: RunControl, scope: ArchiveWords.Scope = .archive) -> ArchiveFailure {
        if control.isCancelled() { return ArchiveFailure(code: nil, message: "Cancelled.") }
        if control.timedOut() { return ArchiveFailure(code: nil, message: toolFailedMessage()) }
        if case ArchiveError.Refused(let code) = error { return ArchiveFailure(code: code, message: ArchiveWords.refusal(code, scope: scope)) }
        if case ArchiveError.Failed(let reason) = error { return ArchiveFailure(code: nil, message: reason) }
        return error as? ArchiveFailure ?? ArchiveFailure(code: nil, message: toolFailedMessage())
    }
}

/* Every open archive and every call in flight, reachable without an actor: a sign-out closes them from anywhere. */
public enum ArchiveSessions {
    private final class Live: @unchecked Sendable {
        var archives: [UUID: @Sendable () -> Void] = [:]
        var calls: [UUID: RunControl] = [:]
        /* The account each archive and call belongs to (`account`; "" for the app's). */
        var accounts: [UUID: String] = [:]
        /* Moved by every sign-out of an account: an archive opened across one is never registered (PaddingDrains' rule). */
        var generations: [String: UInt64] = [:]
        /* The family workspace each family file's archive was opened from (lowercase). */
        var families: [UUID: String] = [:]
        /* The workspace each other archive (a share's, the account's own, a kept copy's) was opened from (lowercase). */
        var shares: [UUID: String] = [:]
        /* The node of each archive that has no workspace (a kept copy recorded before its workspace was): found by it alone. */
        var nodes: [UUID: String] = [:]
        /* Workspaces proven family folders this session (route 25): nothing opened another way serves from them. */
        var proven: Set<String> = []
        /* Nodes those proofs and let-gos purged: a zip known by one alone (no workspace), however late it registers, never serves. */
        var purged: Set<String> = []
        /* Family folders let go of this session (a refusal, a fork, not a member): nothing opened from one serves. */
        var letGo: Set<String> = []
    }

    /*
     * The registry's one lock: the copies' lock (TemporaryCopies.forgetLock), which a family's forget
     * moves its generation under, a session ends under (`endAccount`), and every gated write takes.
     * Each registry operation checks an archive's scope (its session and family generation, its
     * workspace and node) and acts in the same step: admitted (`admit`), a piece written
     * (`whileStanding`), a proof or let-go acted on (`proveFamilies`, `closeFamily`) wholly before an
     * invalidation or wholly after it. Never taken again inside: NSLock doesn't nest.
     */
    private static var lock: NSLock { TemporaryCopies.forgetLock }

    /* Posted on the main queue when a family's archive is closed because its family was let go of: `archive` is its `identity`. */
    public static let familyClosed = Notification.Name("HushOSArchiveFamilyClosed")

    /* What an archive is held to: its session and family generation (`gate`), and where it came from. */
    struct Scope: Sendable {
        var gate: FamilyCopyGate?
        /* Lowercase; nil for a kept copy recorded before its workspace was. */
        var workspace: String?
        var node: String?
        /* Opened through its family's ledger (held to the family's generation), not a share or the account's own keys. */
        var family: Bool
    }

    /* Under the lock: nil while `scope` stands, else why not. */
    private static func refusalLocked(_ scope: Scope) -> ArchiveFailure? {
        if let gate = scope.gate {
            do { try gate.checkLocked() } catch {
                if let family = error as? FamilyFailure { return ArchiveFailure(code: nil, message: family.message) }
                return ArchiveFailure.closed
            }
        }
        if let workspace = scope.workspace {
            // Opened another way: from a proof or a let-go of its folder on, it serves only through the family's ledger.
            if !scope.family, live.proven.contains(workspace) || live.letGo.contains(workspace) { return ArchiveFailure(code: nil, message: FamilyWords.openAgain) }
        } else if let node = scope.node, live.purged.contains(node) {
            return ArchiveFailure(code: nil, message: FamilyWords.openAgain)
        }
        return nil
    }

    /*
     * Marks `archive` with where it came from, once its scope is checked, in one step under the lock a
     * forget, a proof and a session's end take: one before this is seen here (and refused, nothing
     * marked), one after finds the archive by its workspace (or, with none, its node) and closes it.
     */
    static func admit(archive id: UUID, _ scope: Scope) -> ArchiveFailure? {
        lock.withLock {
            if let refused = refusalLocked(scope) { return refused }
            guard live.archives[id] != nil else { return nil }
            if let workspace = scope.workspace {
                if scope.family { live.families[id] = workspace } else { live.shares[id] = workspace }
            } else if let node = scope.node {
                live.nodes[id] = node
            }
            return nil
        }
    }

    /* Whether `scope` stands now (a call's start and end, `serves`). */
    static func refusal(_ scope: Scope) -> ArchiveFailure? { lock.withLock { refusalLocked(scope) } }

    /*
     * `body` (a downloaded piece written out) while the archive stands: checked under the registry's
     * lock, written under the archive's own (`writing`), never the registry's, so a write to a slow
     * provider holds up no forget, sign-out or screen. A forget, a proof or a sign-out takes the archive
     * out of the registry under the registry's lock first: a piece not yet checked is refused; one
     * already being written finishes, and the download's failure removes its file, that piece with it
     * (`OpenArchive.settled` waits it out first, off the main thread). `registered`: an archive a
     * sign-out reaches, which must still be in the registry.
     */
    static func whileStanding<T>(archive id: UUID, registered: Bool, _ scope: Scope, writing: NSLock, _ body: () throws -> T) throws -> T {
        try writing.withLock {
            try lock.withLock {
                if let refused = refusalLocked(scope) { throw refused }
                if registered, live.archives[id] == nil { throw ArchiveFailure.closed }
            }
            return try body()
        }
    }

    /*
     * Route 25 proved these workspaces family folders (`Vault.noteFamilyWorkspaces`): an archive a
     * share opened from one holds that share's content key, and closes now, idle or not, its
     * downloads with it; its screen is told as for a family let go of. From here they serve only
     * through the family's ledger. Bound to `session` (the vault's): an ended session's late proof
     * marks and closes nothing.
     */
    static func proveFamilies(_ workspaces: [String], nodes: Set<String> = [], session: CopySession? = nil) {
        let proven = Set(workspaces.map { $0.lowercased() })
        let gone = Set(nodes.map { $0.lowercased() })
        let closes = lock.withLock { () -> [(UUID, @Sendable () -> Void)] in
            if let session, !session.open { return [] }
            live.proven.formUnion(proven)
            live.purged.formUnion(gone)
            // By workspace; by node only an archive with no workspace (a node of a known workspace is that
            // workspace's: another's id that collides with it closes nothing).
            let ids = Set(live.shares.filter { proven.contains($0.value) }.map(\.key))
                .union(live.nodes.filter { gone.contains($0.value) }.map(\.key))
            return ids.compactMap { id -> (UUID, @Sendable () -> Void)? in
                live.shares[id] = nil
                live.nodes[id] = nil
                return live.archives.removeValue(forKey: id).map { (id, $0) }
            }
        }
        for (id, close) in closes {
            close()
            DispatchQueue.main.async { NotificationCenter.default.post(name: familyClosed, object: nil, userInfo: ["archive": id]) }
        }
    }

    /*
     * Family folders let go of (`TemporaryCopies.forgetFamily`, `Vault.forgetWorkspaces`): their
     * archives close now, idle or not, their listing and password gone, and their screens are told.
     * A call on one would refuse anyway (its scope); this is for the one nothing is asking of. Bound
     * to `session`: an ended session's late let-go closes nothing, and fills nothing the next
     * session's zips are held to.
     */
    static func closeFamily(_ workspaces: [String], nodes: Set<String> = [], session: CopySession? = nil) {
        let forgotten = Set(workspaces.map { $0.lowercased() })
        let purged = Set(nodes.map { $0.lowercased() })
        // Its family's files, and any of the same folder opened another way (a share, a copy kept on
        // this phone): the vault dropped that folder's keys and copies, so none of them serves on.
        let closes = lock.withLock { () -> [(UUID, @Sendable () -> Void)] in
            if let session, !session.open { return [] }
            live.letGo.formUnion(forgotten)
            // The nodes its vault forgot too: a kept zip with no workspace is found by its node, and one
            // still opening is refused as it is admitted.
            live.purged.formUnion(purged)
            let ids = Set(live.families.filter { forgotten.contains($0.value) }.map(\.key))
                .union(live.shares.filter { forgotten.contains($0.value) }.map(\.key))
                .union(live.nodes.filter { purged.contains($0.value) }.map(\.key))
            return ids.compactMap { id -> (UUID, @Sendable () -> Void)? in
                live.families[id] = nil
                live.shares[id] = nil
                live.nodes[id] = nil
                return live.archives.removeValue(forKey: id).map { (id, $0) }
            }
        }
        for (id, close) in closes {
            close()
            DispatchQueue.main.async { NotificationCenter.default.post(name: familyClosed, object: nil, userInfo: ["archive": id]) }
        }
    }
    private static let live = Live()

    /*
     * Whose archives a sign-out closes: the app has one account (""). A test signs its own out
     * under a name of its own, so another suite's sign-out, running beside it, never closes its
     * archives mid-test, nor its never theirs.
     */
    @TaskLocal static var account = ""

    /* Taken before an archive starts opening, and given back when it registers. */
    static var generation: UInt64 { lock.withLock { live.generations[account, default: 0] } }

    /*
     * Registers an archive opened since `born`; false, and nothing registered, when a sign-out came
     * between: its open call had ended, so the sign-out had nothing of it to close.
     */
    static func track(archive id: UUID, born: UInt64, close: @escaping @Sendable () -> Void) -> Bool {
        let account = account
        return lock.withLock {
            guard live.generations[account, default: 0] == born else { return false }
            live.archives[id] = close
            live.accounts[id] = account
            return true
        }
    }
    static func untrack(archive id: UUID) {
        lock.withLock {
            live.archives[id] = nil
            live.families[id] = nil
            live.shares[id] = nil
            live.nodes[id] = nil
            live.accounts[id] = nil
        }
    }
    static func track(call id: UUID, _ control: RunControl) {
        let account = account
        lock.withLock {
            live.calls[id] = control
            live.accounts[id] = account
        }
    }
    static func untrack(call id: UUID) {
        lock.withLock {
            live.calls[id] = nil
            live.accounts[id] = nil
        }
    }

    /* Sign-out: every call in flight is cancelled, and every archive is closed, its password wiped. */
    public static func closeAll() {
        let account = account
        let (closes, controls) = lock.withLock {
            live.generations[account, default: 0] &+= 1
            // The next session proves its own family folders.
            if account.isEmpty {
                live.proven = []
                live.purged = []
                live.letGo = []
            }
            let mine = { (id: UUID) in live.accounts[id, default: ""] == account }
            return (live.archives.filter { mine($0.key) }.map(\.value), live.calls.filter { mine($0.key) }.map(\.value))
        }
        for control in controls { control.cancel() }
        for close in closes { close() }
    }

    /* Whether anything is open or in flight: for tests. */
    public static var idle: Bool { lock.withLock { live.archives.isEmpty && live.calls.isEmpty } }

    /* The watchdogs' own queue, as ToolRuns' are: never the cooperative pool. */
    static let watchdogQueue = DispatchQueue(label: "com.hushos.archive-watchdog")
    /* Where archives are closed: never the main thread. */
    /*
     * Concurrent: a core close may wait for a call still in it (a sibling's piece being written to a slow
     * provider), and must hold up no other archive's close. A flush (tests) is a barrier.
     */
    static let closeQueue = DispatchQueue(label: "com.hushos.archive-close", qos: .userInitiated, attributes: .concurrent)
}

/* Turns, first come first served; a task cancelled while it waits leaves its place. */
actor ArchiveTurns {
    private var busy = false
    private var waiting: [(id: UUID, go: CheckedContinuation<Void, Error>)] = []

    func take() async throws {
        guard busy else { busy = true; return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (go: CheckedContinuation<Void, Error>) in waiting.append((id, go)) }
        } onCancel: {
            Task { await self.drop(id) }
        }
    }

    func give() {
        if waiting.isEmpty { busy = false } else { waiting.removeFirst().go.resume() }
    }

    private func drop(_ id: UUID) {
        guard let at = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: at).go.resume(throwing: CancellationError())
    }
}

/* Settles once, from whichever comes first: the work, a cancel, the watchdog. */
private final class CallOutcome<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var waiter: CheckedContinuation<Result<T, Error>, Never>?

    func finish(_ value: Result<T, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let waiter = self.waiter
        self.waiter = nil
        lock.unlock()
        waiter?.resume(returning: value)
    }

    func value() async -> Result<T, Error> {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(returning: result) } else { waiter = continuation; lock.unlock() }
        }
    }
}

/* The key the call's thread keeps its control under, for the source to find. */
private let controlKey = "com.hushos.archive.control"
/*
 * A 401 met by a read on the call's thread: the core only carries a reason across, so the session
 * it was for (its tag) is kept here, and the call throws it in place of the core's failure.
 */
private let refusedKey = "com.hushos.archive.refused"

/*
 * The object store for an open archive. The core calls `fetch` on the thread of whichever call is
 * reading (each sets its control in the thread's dictionary first), so a fetch is given up the
 * moment that call ends. Padding a call still owed when it ended goes to PaddingDrains.
 */
final class ArchiveSource: ObjectSource, @unchecked Sendable {
    private let fetchRange: @Sendable (ByteRange) async throws -> Data
    private let drain: @Sendable ([ByteRange]) -> Void

    init(drainLater: @escaping @Sendable ([ByteRange]) -> Void, _ fetch: @escaping @Sendable (ByteRange) async throws -> Data) {
        drain = drainLater
        fetchRange = fetch
    }

    func fetch(range: ByteRange, drain: Bool) throws -> Data {
        let control = Thread.current.threadDictionary[controlKey] as? RunControl
        let box = ArchiveFetchBox()
        let done = DispatchSemaphore(value: 0)
        let fetchRange = self.fetchRange
        let task = Task.detached {
            do { box.result = .success(try await fetchRange(range)) } catch { box.result = .failure(error) }
            done.signal()
        }
        while done.wait(timeout: .now() + .milliseconds(50)) == .timedOut {
            if control?.isEnded() == true {
                task.cancel()
                throw FetchError.Failed(reason: "Cancelled.")
            }
        }
        switch box.result! {
        case .success(let data): return data
        case .failure(let error):
            if endsSession(error) { Thread.current.threadDictionary[refusedKey] = error }
            // In HushOS's words, never the system's (a URL, a path): the 401 is kept apart above.
            throw FetchError.Failed(reason: ErrorWords.say(error, otherwise: ArchiveWords.unreadable) ?? "Cancelled.")
        }
    }

    func drainLater(ranges: [ByteRange]) {
        drain(ranges)
    }
}

private final class ArchiveFetchBox: @unchecked Sendable {
    var result: Result<Data, Error>?
}

/* Where an entry being downloaded goes: each piece handed on as it comes, on the call's thread. */
public final class ArchiveSink: EntrySink, @unchecked Sendable {
    private let put: @Sendable (Data) throws -> Void
    public init(_ put: @escaping @Sendable (Data) throws -> Void) { self.put = put }
    public func write(chunk: Data) throws {
        do { try put(chunk) } catch { throw FetchError.Failed(reason: ErrorWords.say(error, otherwise: ArchiveWords.notSaved) ?? "Cancelled.") }
    }
}

/*
 * A copy of a zip this phone keeps (Offline), read by range into memory on the call's thread: a
 * kept zip opens without a connection, and no other copy of its plaintext is made.
 */
final class KeptCopy: LocalSource, @unchecked Sendable {
    private let handle: FileHandle
    private let length: UInt64
    private let lock = NSLock()

    init(url: URL) throws {
        handle = try FileHandle(forReadingFrom: url)
        length = try handle.seekToEnd()
    }

    deinit { try? handle.close() }

    func size() -> UInt64 { length }

    func readAt(offset: UInt64, length: UInt64) throws -> Data {
        do {
            return try lock.withLock {
                try handle.seek(toOffset: offset)
                return try handle.read(upToCount: Int(length)) ?? Data()
            }
        } catch {
            throw FetchError.Failed(reason: ArchiveWords.keptUnreadable)
        }
    }
}

/*
 * The calls in flight on one archive, so closing it cancels them first. Once closed it takes no
 * more: a call that starts while (or after) the archive closes is cancelled as it is added, so
 * none runs on past the close.
 */
final class ArchiveCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var controls: [UUID: RunControl] = [:]
    private var closed = false
    /* False (and the control cancelled) once the archive closed. */
    @discardableResult func add(_ id: UUID, _ control: RunControl) -> Bool {
        let taken = lock.withLock { () -> Bool in
            guard !closed else { return false }
            controls[id] = control
            return true
        }
        if !taken { control.cancel() }
        return taken
    }
    func remove(_ id: UUID) { _ = lock.withLock { controls.removeValue(forKey: id) } }
    func cancelAll() {
        let all = lock.withLock { () -> [RunControl] in
            closed = true
            return Array(controls.values)
        }
        for control in all { control.cancel() }
    }
    var count: Int { lock.withLock { controls.count } }
    var isClosed: Bool { lock.withLock { closed } }
}

/*
 * The archive's siblings open for downloads: closed with it, by its close or a sign-out. Once the
 * archive closed it keeps none: a sibling made while it closes is refused here, and its maker
 * closes it at once.
 */
final class ArchiveSiblings: @unchecked Sendable {
    private let lock = NSLock()
    private var open: [UUID: ZipArchiveSession] = [:]
    private var closed = false
    /* False once the archive closed: the caller closes `session` itself. */
    func add(_ id: UUID, _ session: ZipArchiveSession) -> Bool {
        lock.withLock {
            guard !closed else { return false }
            open[id] = session
            return true
        }
    }
    func remove(_ id: UUID) -> ZipArchiveSession? { lock.withLock { open.removeValue(forKey: id) } }
    func takeAll() -> [ZipArchiveSession] {
        lock.withLock {
            closed = true
            defer { open.removeAll() }
            return Array(open.values)
        }
    }
    var count: Int { lock.withLock { open.count } }
}

/* One zip open in the viewer. */
public final class OpenArchive: @unchecked Sendable {
    public let entries: [ArchiveEntry]
    public let hidden: Int
    /* Opened from the copy this phone keeps, not the network. */
    public let kept: Bool
    /* The row it was opened from: for a family's file, the vault's current row, which may be newer than the one tapped. */
    public private(set) var row: Opened?
    /*
     * For a Drive file: kept to the session, and a family's file to its family folder, as they stood
     * before the open began (FamilyCopyGate, taken first). Every call asks before it starts and
     * before it hands anything back, a download before each piece, and the archive closes at the
     * first refusal: a family's removal or fork leaves no listing, password or bytes behind.
     */
    var gate: FamilyCopyGate? {
        get { scope.gate }
        set { scope.gate = newValue }
    }
    /* Its gate, and where it came from (`mark`): what the registry holds it to (ArchiveSessions.Scope). */
    private(set) var scope = ArchiveSessions.Scope(gate: nil, workspace: nil, node: nil, family: false)
    private let session: ZipArchiveSession
    private let turns = ArchiveTurns()
    private let calls = ArchiveCalls()
    private let siblings = ArchiveSiblings()
    private let id = UUID()
    /* Held while a downloaded piece is written out: the archive's own lock, never the registry's (`ArchiveSessions.whileStanding`). */
    private let writing = NSLock()
    /* Who this archive is, in `ArchiveSessions.familyClosed`. */
    public var identity: UUID { id }
    private let watchdog: Duration
    private let poll: Duration
    /* Reached by a sign-out (`ArchiveSessions.closeAll`). Every archive the app opens is; a test's own may not be, so another suite's sign-out can't close it mid-test. */
    private let registered: Bool

    /* `born`: the sign-out generation taken before the open began. A sign-out since closes it here and throws. */
    init(session: ZipArchiveSession, born: UInt64, kept: Bool = false, watchdog: Duration, poll: Duration, registered: Bool = true) throws {
        self.session = session
        self.kept = kept
        entries = session.entries()
        hidden = Int(session.hidden())
        self.watchdog = watchdog
        self.poll = poll
        self.registered = registered
        if registered {
            let tracked = ArchiveSessions.track(archive: id, born: born) { [session, calls, siblings] in
                calls.cancelAll()
                for sibling in siblings.takeAll() { OpenArchive.closeOffMain(sibling) }
                OpenArchive.closeOffMain(session)
            }
            // Signed out while it opened: closed now (deinit does it), never shown.
            guard tracked else { throw CancellationError() }
        }
    }

    deinit {
        calls.cancelAll()
        for sibling in siblings.takeAll() { OpenArchive.closeOffMain(sibling) }
        OpenArchive.closeOffMain(session)
        if registered { ArchiveSessions.untrack(archive: id) }
    }

    /* The list's folders, handed over once: the core keeps none after (ArchiveTree holds them). */
    public func takeFolders() -> ArchiveFolders { session.takeFolders() }

    /* The core's close, never on the main thread: it may wait for a call still in it (a piece being written). */
    static func closeOffMain(_ session: ZipArchiveSession) {
        ArchiveSessions.closeQueue.async { session.closeArchive() }
    }

    /*
     * Opens `item`'s current version, reading its directory (every cap of section 3) on a call of
     * its own: from the copy this phone keeps when there is one (it opens offline), otherwise
     * from the store. Throws ArchiveFailure.
     */
    public static func open(_ item: Opened, vault: Vault, watchdog: Duration = .milliseconds(Int(toolWatchdogMillis())), poll: Duration = .seconds(1)) async throws -> OpenArchive {
        let born = ArchiveSessions.generation
        let family = await vault.isFamilyWorkspace(item.node.workspaceId)
        let gate = vault.copyGate(familyWorkspace: family ? item.node.workspaceId : nil)
        if let url = Offline.localCopy(of: item), let copy = try? KeptCopy(url: url) {
            let archive = try await open(local: copy, born: born, watchdog: watchdog, poll: poll)
            archive.gate = gate
            try archive.mark(item.node.workspaceId, node: item.id, family: family)
            try archive.stands()
            return archive
        }
        try await vault.holdForCopy(item)
        let current = try await currentRow(item, vault: vault)
        let opened = try await vault.openVersion(current)
        let source = archiveSource(api: vault.api, versionId: opened.versionId, workspaceId: current.node.workspaceId)
        let content = opened.content
        let session = try await call(watchdog: watchdog, poll: poll) { control in
            try ZipArchiveSession.open(source: source, content: content, control: control)
        }
        let archive = try OpenArchive(session: session, born: born, watchdog: watchdog, poll: poll)
        archive.row = current
        archive.gate = gate
        // Marked, then the gate asked: a forget (or a proof) before the mark is seen there, one after it closes the archive.
        try archive.mark(current.node.workspaceId, node: current.id, family: family)
        try archive.stands()
        return archive
    }

    /*
     * The file as it is now, not as the tapped row drew it: a family folder has no change feed, so
     * its folder is listed again first (another member may have replaced the zip, or its keys
     * moved), then the vault's row of the same workspace is taken unless it is older. Any other
     * file opens as tapped.
     */
    static func currentRow(_ item: Opened, vault: Vault) async throws -> Opened {
        guard await vault.isFamilyWorkspace(item.node.workspaceId) else { return item }
        if let parent = item.node.parentId { _ = try await vault.listChildren(of: parent, in: item.node.workspaceId) }
        guard let held = await vault.item(item.ref), !held.node.isOlder(than: item.node) else { return item }
        return held
    }

    /* A zip this phone keeps with only its offline record (kept from a share this session hasn't opened): its copy, read by range. */
    /*
     * A zip kept on this phone, by its offline record alone: marked with the workspace and node the
     * record names, so a proof that the workspace is a family's (which purges the kept copy) closes
     * it, its copy's handle with it.
     */
    public static func openKept(_ url: URL, workspace: String? = nil, node: String? = nil, watchdog: Duration = .milliseconds(Int(toolWatchdogMillis())), poll: Duration = .seconds(1)) async throws -> OpenArchive {
        // The sign-out generation first, before the copy's file is opened: a sign-out from here on is seen as the
        // archive registers, never the old account's file registered under the next one's generation.
        let born = ArchiveSessions.generation
        let copy: KeptCopy
        do { copy = try KeptCopy(url: url) } catch { throw ArchiveFailure(code: nil, message: ErrorWords.generic) }
        let archive = try await open(local: copy, born: born, watchdog: watchdog, poll: poll)
        try archive.mark(workspace, node: node, family: false)
        try archive.stands()
        return archive
    }

    /* An archive over any source (the tests' sealed fixtures). */
    static func open(source: ObjectSource, content: Content, watchdog: Duration, poll: Duration = .seconds(1), registered: Bool = true) async throws -> OpenArchive {
        let born = ArchiveSessions.generation
        let session = try await call(watchdog: watchdog, poll: poll, registered: registered) { control in
            try ZipArchiveSession.open(source: source, content: content, control: control)
        }
        return try OpenArchive(session: session, born: born, watchdog: watchdog, poll: poll, registered: registered)
    }

    /* An archive over a copy kept on the phone (or a test's bytes). */
    /* `born`: the generation the caller took before it opened anything of the copy (its file); taken here otherwise. */
    static func open(local: LocalSource, born: UInt64? = nil, watchdog: Duration, poll: Duration = .seconds(1), registered: Bool = true) async throws -> OpenArchive {
        let born = born ?? ArchiveSessions.generation
        let session = try await call(watchdog: watchdog, poll: poll, registered: registered) { control in
            try ZipArchiveSession.openLocal(source: local, control: control)
        }
        return try OpenArchive(session: session, born: born, kept: true, watchdog: watchdog, poll: poll, registered: registered)
    }

    /* Whether a password is held. */
    public var unlocked: Bool { session.unlocked() }

    /*
     * Marked with the workspace it came from: a family's, closed when the family is let go of; any
     * other, closed when that workspace is proven a family's (and refused here if it already is).
     */
    func mark(_ workspace: String?, node: String? = nil, family: Bool) throws {
        scope.workspace = workspace?.lowercased()
        scope.node = node?.lowercased()
        scope.family = family && workspace != nil
        if let refused = ArchiveSessions.admit(archive: id, scope) {
            close()
            throw refused
        }
    }

    /*
     * Whether it may still be shown: not closed (a family let go of, a workspace proven a family's,
     * a sign-out) and still allowed. A screen asks before it publishes what it built off the main
     * thread, since a close meanwhile came while it had nothing to drop.
     */
    public var serves: Bool {
        guard !calls.isClosed else { return false }
        return (try? stands()) != nil
    }

    /* Calls in flight, and siblings open for downloads: for tests. */
    var running: Int { calls.count }
    var downloading: Int { siblings.count }

    /*
     * Whether `password` opens the archive's locked entries; held, in the core, if it does. With
     * `entry` (one whose own password the held one didn't open), that entry is tried first.
     */
    public func unlock(_ password: String, entry: ArchiveEntry? = nil) async throws -> Bool {
        try await turn(scope: .archive) { [session] control in try session.unlock(password: password, index: entry?.index, control: control) }
    }

    /* The entry's bytes, at most `limit` declared, checked to the end: kept in memory, never written to a file. */
    public func preview(_ entry: ArchiveEntry, limit: UInt64) async throws -> Data {
        try await turn(scope: .entry) { [session] control in try session.preview(index: entry.index, limit: limit, control: control) }
    }

    /*
     * The entry into `sink` a MiB at a time, held to its declared size, on a sibling of the
     * archive (the same listing and password, a reader of its own), so previews never wait
     * behind a download. The sibling is closed when the download ends, when the archive closes,
     * and on sign-out; never on the main thread.
     */
    public func download(_ entry: ArchiveEntry, into sink: ArchiveSink) async throws {
        try stands()
        let key = UUID()
        let sibling: ZipArchiveSession
        do { sibling = try session.sibling() } catch { throw ArchiveFailure.from(error, control: RunControl(watchdogMillis: 1, clock: nil), scope: .entry) }
        // The archive closed while the sibling was made: nothing would close it, so it goes now.
        guard siblings.add(key, sibling) else {
            OpenArchive.closeOffMain(sibling)
            throw ArchiveFailure.closed
        }
        defer { if let done = siblings.remove(key) { OpenArchive.closeOffMain(done) } }
        // Asked of every piece too: a family let go of mid-download writes nothing more.
        // Checked and written in one step under the registry's lock: no forget, proof or sign-out lands between.
        let held: EntrySink = ArchiveSink { [id, registered, scope, writing] chunk in
            try ArchiveSessions.whileStanding(archive: id, registered: registered, scope, writing: writing) { try sink.write(chunk: chunk) }
        }
        do {
            try await Self.call(watchdog: watchdog, poll: poll, scope: .entry, on: calls, registered: registered) { control in
                try sibling.download(index: entry.index, sink: held, control: control)
            }
        } catch {
            try stands()
            throw error
        }
        try stands()
    }

    /*
     * Closes the archive: every call in flight on it is cancelled first, then the core wipes the
     * password and the key off the main thread. Any later call fails.
     */
    /*
     * Returns once no piece is being written out (a call's thread may still be in one after a cancel):
     * waited for off the main thread, so a download's cleanup removes its file after its last piece, never
     * before it. Nothing waits on a write from the main thread.
     */
    public func settled() async {
        let writing = self.writing
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            ArchiveSessions.closeQueue.async {
                writing.lock()
                writing.unlock()
                done.resume()
            }
        }
    }

    public func close() {
        calls.cancelAll()
        for sibling in siblings.takeAll() { OpenArchive.closeOffMain(sibling) }
        OpenArchive.closeOffMain(session)
        ArchiveSessions.untrack(archive: id)
    }

    private func turn<T: Sendable>(scope: ArchiveWords.Scope, _ work: @escaping @Sendable (RunControl) throws -> T) async throws -> T {
        try stands()
        do { try await turns.take() } catch { throw ArchiveFailure(code: nil, message: "Cancelled.") }
        let value: T
        // The turn goes back when the call's thread ends, not when the caller hears: a cancel or a
        // watchdog answers at once, while the core may still hold its session's lock, and the next
        // call's watchdog must not run while it waits for that lock.
        let turns = self.turns
        do {
            value = try await Self.call(watchdog: watchdog, poll: poll, scope: scope, on: calls, registered: registered, threadEnded: { Task { await turns.give() } }, work)
        } catch {
            // Failed because the family went: said as that.
            try stands()
            throw error
        }
        try stands()
        return value
    }

    /*
     * Throws, and closes the archive, once its session or its family folder was let go of since the
     * open began (`gate`), or, opened another way, once its workspace was proven a family's.
     */
    func stands() throws {
        guard let refused = ArchiveSessions.refusal(scope) else { return }
        close()
        throw refused
    }

    /*
     * `work` on a thread of its own under a fresh RunControl, as ToolRuns.run does, without the
     * run slot: the watchdog polled every `poll`, a cancel from the task, the archive's close or a
     * sign-out ending it at once, `finish()` when the thread returns.
     */
    static func call<T: Sendable>(watchdog: Duration, poll: Duration, scope: ArchiveWords.Scope = .archive, on calls: ArchiveCalls? = nil, registered: Bool = true, threadEnded: (@Sendable () -> Void)? = nil, _ work: @escaping @Sendable (RunControl) throws -> T) async throws -> T {
        let millis = UInt64(watchdog.components.seconds) * 1000 + UInt64(watchdog.components.attoseconds / 1_000_000_000_000_000)
        let control = RunControl(watchdogMillis: millis, clock: nil)
        let id = UUID()
        let outcome = CallOutcome<T>()
        // On an archive closed already (or closing) nothing starts: no thread, no read.
        if let calls, !calls.add(id, control) {
            threadEnded?()
            throw ArchiveFailure.closed
        }
        if registered { ArchiveSessions.track(call: id, control) }
        let result = await withTaskCancellationHandler {
            if Task.isCancelled { control.cancel() }
            let watcher = DispatchSource.makeTimerSource(queue: ArchiveSessions.watchdogQueue)
            let interval = DispatchTimeInterval.milliseconds(Int(poll.components.seconds) * 1000 + Int(poll.components.attoseconds / 1_000_000_000_000_000))
            watcher.schedule(deadline: .now() + interval, repeating: interval)
            watcher.setEventHandler {
                if control.checkWatchdog() { outcome.finish(.failure(ArchiveFailure(code: nil, message: toolFailedMessage()))) }
                if control.isCancelled() { outcome.finish(.failure(ArchiveFailure(code: nil, message: "Cancelled."))) }
            }
            watcher.resume()
            let thread = Thread {
                Thread.current.threadDictionary[controlKey] = control
                let result = Result { try work(control) }.mapError { error -> Error in
                    // A 401 is said as itself, its session's tag kept, for the app's session check.
                    if let refused = Thread.current.threadDictionary[refusedKey] as? Error { return refused }
                    return ArchiveFailure.from(error, control: control, scope: scope)
                }
                Thread.current.threadDictionary[controlKey] = nil
                Thread.current.threadDictionary[refusedKey] = nil
                // The call's reader lets go of its chunks and its key now, before anyone is told.
                control.finish()
                outcome.finish(result)
                watcher.cancel()
                ArchiveSessions.untrack(call: id)
                calls?.remove(id)
                threadEnded?()
            }
            thread.stackSize = 8 << 20
            thread.start()
            return await outcome.value()
        } onCancel: {
            control.cancel()
            outcome.finish(.failure(ArchiveFailure(code: nil, message: "Cancelled.")))
        }
        switch result {
        case .success(let value): return value
        case .failure(let error):
            control.cancel()
            throw error
        }
    }

    /* The store's ranges for one version, as ToolReaders gives a run's reader them, for the archive's life. */
    private static func archiveSource(api: DriveAPI, versionId: String, workspaceId: String) -> ArchiveSource {
        let drains = PaddingDrains.shared
        let born = drains.generation
        let address = ArchiveAddress {
            guard let url = URL(string: try await api.versionURL(versionId, workspaceId: workspaceId).url) else {
                throw DriveAPIError.server(500, "Bad object URL")
            }
            return url
        }
        let drainOnce: @Sendable (ByteRange) async throws -> Void = { range in
            do {
                _ = try await api.range(try await address.current(), range)
            } catch DriveAPIError.server(403, _) {
                try await address.refresh()
                _ = try await api.range(try await address.current(), range)
            }
        }
        return ArchiveSource(drainLater: { ranges in
            drains.enqueue(ranges, born: born, metered: NetworkWatch.shared.metered, fetch: drainOnce)
        }) { range in
            try await Resumable.run(onExpired: { try await address.refresh() }) {
                try await api.range(try await address.current(), range)
            }
        }
    }
}

/* The version's address, asked for when first needed and renewed when it expires. */
private actor ArchiveAddress {
    private var url: URL?
    private let fresh: @Sendable () async throws -> URL
    init(_ fresh: @escaping @Sendable () async throws -> URL) { self.fresh = fresh }
    func current() async throws -> URL {
        if let url { return url }
        let made = try await fresh()
        url = made
        return made
    }
    func refresh() async throws { url = try await fresh() }
}

// MARK: - What the list shows

/* A row of an archive's folder: a folder (its number in the list's folders) with how many items it holds, or a file. */
public enum ArchiveRow: Equatable, Sendable {
    case folder(id: UInt32, name: String, count: Int)
    case file(ArchiveEntry)

    public var name: String {
        switch self {
        case .folder(_, let name, _): name
        case .file(let entry): entry.name
        }
    }
}

/*
 * The archive's list as folders (the web's rowsOf in archive-view.tsx), from the core's
 * ArchiveFolders: each folder's parent and name in one array and one run of bytes, never an object
 * a folder, so a listing of millions of folders costs a few bytes each. A folder's rows (its
 * folders, then its files, each by name as Files sorts them) are made the first time they are
 * asked for, off the main actor (a folder of 100,000 files takes seconds to sort), and kept:
 * `made(in:)` hands back the ones already made without waiting on a sort under way. Mac resource
 * entries are left out.
 */
public final class ArchiveTree: @unchecked Sendable {
    private let parents: [UInt32]
    private let names: [UInt8]
    /* Where each folder's name starts in `names`; the next one's start, less its `/`, is where it ends. */
    private let starts: [Int]
    /* What each folder holds, folders and files. */
    private let counts: [Int32]
    private let files: [ArchiveEntry]
    private let lock = NSLock()
    private var made: [UInt32: [ArchiveRow]] = [:]

    public init(_ entries: [ArchiveEntry], folders: ArchiveFolders) {
        let count = max(folders.parents.count / 4, 1)
        var parents = [UInt32](repeating: 0, count: count)
        folders.parents.withUnsafeBytes { raw in
            for k in 0 ..< folders.parents.count / 4 {
                parents[k] = UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 4 * k, as: UInt32.self))
            }
        }
        let names = Array(folders.names.utf8)
        var starts = [Int](repeating: 0, count: count + 1)
        var at = 0
        for k in 1 ..< count {
            starts[k] = at
            while at < names.count, names[at] != 0x2F { at += 1 }
            at = min(at + 1, names.count)
        }
        starts[count] = at
        let files = entries.filter { !$0.hidden && !$0.directory && Int($0.folder) < count }
        var counts = [Int32](repeating: 0, count: count)
        for k in 1 ..< count where Int(parents[k]) < count { counts[Int(parents[k])] += 1 }
        for file in files { counts[Int(file.folder)] += 1 }
        self.parents = parents
        self.names = names
        self.starts = starts
        self.counts = counts
        self.files = files
    }

    /* Folder `id`'s name ("" for the top). */
    public func name(of id: UInt32) -> String {
        let k = Int(id)
        guard k > 0, k < parents.count, starts[k + 1] > starts[k] else { return "" }
        return String(decoding: names[starts[k] ..< starts[k + 1] - 1], as: UTF8.self)
    }

    /* The rows of folder `id` (0: the top), empty for one the list doesn't hold. */
    public func rows(in id: UInt32) -> [ArchiveRow] {
        if let rows = made(in: id) { return rows }
        guard Int(id) < parents.count else { return [] }
        let byName: (String, String) -> Bool = { $0.localizedStandardCompare($1) == .orderedAscending }
        var inside: [(id: UInt32, name: String)] = []
        for k in 1 ..< parents.count where parents[k] == id { inside.append((UInt32(k), name(of: UInt32(k)))) }
        let folderRows: [ArchiveRow] = inside.sorted { byName($0.name, $1.name) }.map { .folder(id: $0.id, name: $0.name, count: Int(counts[Int($0.id)])) }
        let fileRows: [ArchiveRow] = files.filter { $0.folder == id }.sorted { byName($0.name, $1.name) }.map { .file($0) }
        let rows = folderRows + fileRows
        lock.lock()
        defer { lock.unlock() }
        if let first = made[id] { return first }
        made[id] = rows
        return rows
    }

    /* Folder `id`'s rows when they are made already, else nil: never sorts. */
    public func made(in id: UInt32) -> [ArchiveRow]? {
        lock.lock()
        defer { lock.unlock() }
        return made[id]
    }
}

public enum ArchiveEntries {
    /* Whether a file opens as an archive's list: a zip, by its type or its name. */
    public static func handles(name: String, mime: String?) -> Bool {
        let type = (mime ?? "").lowercased()
        return type == "application/zip" || type == "application/x-zip-compressed" || (name as NSString).pathExtension.lowercased() == "zip"
    }

    /*
     * When it last changed: its Unix time when the archive kept one, else its MS-DOS date and time,
     * as local time. The DOS fields are Gregorian whatever calendar the phone shows (a Buddhist
     * one would read 2026 as its own year, 1483 in ours): only the formatting uses the person's.
     */
    public static func date(_ entry: ArchiveEntry, timeZone: TimeZone = .current) -> Date? {
        if let millis = entry.mtimeMillis { return Date(timeIntervalSince1970: Double(millis) / 1000) }
        let date = entry.dos >> 16, time = entry.dos & 0xffff
        let month = Int((date >> 5) & 0xf), day = Int(date & 0x1f)
        guard month > 0, day > 0 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(
            year: Int((date >> 9) & 0x7f) + 1980, month: month, day: day,
            hour: Int(time >> 11), minute: Int((time >> 5) & 0x3f), second: Int(time & 0x1f) * 2
        ))
    }

    /* What a phone shows an entry as from memory: an image, a PDF, Markdown, text, or nothing. */
    public enum Kind: String, Sendable { case image, pdf, markdown, text, none }

    public static func kind(of name: String) -> Kind {
        let ext = (name as NSString).pathExtension.lowercased()
        if MarkdownDocument.handles(name: name, mime: nil) { return .markdown }
        if ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "bmp", "tif", "tiff", "ico"].contains(ext) { return .image }
        if ext == "pdf" { return .pdf }
        if let type = UTType(filenameExtension: ext), type.conforms(to: .text) || type.conforms(to: .sourceCode) { return .text }
        if ["txt", "log", "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini", "env", "sh", "js", "ts", "tsx", "css", "html", "py", "rs", "go", "swift", "kt", "java", "c", "h", "sql"].contains(ext) { return .text }
        return .none
    }

    /* Where the large-file card shows for an entry on this device: the core's rule, by the device's memory. */
    public static func limits(_ kind: Kind, memory: UInt64 = ProcessInfo.processInfo.physicalMemory) -> PreviewLimits {
        let core = switch kind {
        case .image: "image"
        case .pdf: "pdf"
        case .markdown, .text: "text"
        case .none: "other"
        }
        return zipEntryPreviewLimits(kind: core, memoryBytes: memory)
    }

    /* The large-file card's state for an entry of `size`. */
    public enum Stage: Equatable, Sendable { case fine, offer, ceiling }

    public static func stage(size: UInt64, limits: PreviewLimits) -> Stage {
        if size > limits.ceiling { return .ceiling }
        if let threshold = limits.threshold, size > threshold { return .offer }
        return .fine
    }
}

/* Text cut where a line ends, at most 200 lines or 16 KB a piece; a line longer than that is cut between characters. */
/*
 * The name a download takes when its own is taken in the folder: "name (n).ext". A save name is
 * already at most 255 bytes of UTF-8 (a file name's limit), so the base is cut, between Unicode
 * scalars, to leave room for the suffix and the extension (of at most 32 bytes, as the core keeps
 * one) on every attempt.
 */
public enum ArchiveSaveName {
    public static let maxBytes = 255

    /*
     * A file of its own for a download in `folder`, created exclusively: `name`, else "name (2)"
     * and on, the next number on each collision, so a file already there (or one another download
     * just made) is never opened, written or deleted. The URL and a handle open for writing; the
     * caller deletes only that URL, and only if the download fails.
     */
    public static func reserve(in folder: URL, name: String, tries: Int = 10_000) throws -> (URL, FileHandle) {
        for n in 1 ... max(1, tries) {
            let candidate = folder.appendingPathComponent(n == 1 ? name : numbered(name, n))
            let fd = candidate.withUnsafeFileSystemRepresentation { path in
                path.map { open($0, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o644) } ?? -1
            }
            if fd >= 0 { return (candidate, FileHandle(fileDescriptor: fd, closeOnDealloc: true)) }
            if errno != EEXIST { throw CocoaError(.fileWriteNoPermission) }
        }
        throw CocoaError(.fileWriteFileExists)
    }

    public static func numbered(_ name: String, _ n: Int) -> String {
        let dot = name.lastIndex(of: ".")
        var base = name, ext = ""
        if let dot, dot != name.startIndex, name.utf8.distance(from: dot, to: name.utf8.endIndex) <= 32 {
            base = String(name[..<dot])
            ext = String(name[dot...])
        }
        let tail = " (\(n))" + ext
        let room = max(0, maxBytes - tail.utf8.count)
        var kept = String.UnicodeScalarView(), used = 0
        for scalar in base.unicodeScalars {
            let width = UTF8.width(scalar)
            if used + width > room { break }
            used += width
            kept.append(scalar)
        }
        return String(kept) + tail
    }
}

public enum ArchiveText {
    public static let lines = 200
    public static let bytes = 16 * 1024

    public static func pieces(_ data: Data) -> [String] {
        let text = String(decoding: data, as: UTF8.self)
        var out: [String] = []
        var current = ""
        var count = 0
        var size = 0
        // Line by line as the text is scanned, never every line made at once (8 MiB of newlines would be millions).
        // A Windows line end, \r\n, is one Character to Swift, never equal to "\n": both end a line.
        var lineStart = text.startIndex
        while true {
            let lineEnd = text[lineStart...].firstIndex(where: { $0 == "\n" || $0 == "\r\n" }) ?? text.endIndex
            var rest = text[lineStart ..< lineEnd]
            repeat {
                var take = rest.startIndex
                var used = 0
                while take < rest.endIndex, used + rest[take].utf8.count <= bytes {
                    used += rest[take].utf8.count
                    take = rest.index(after: take)
                }
                if take == rest.startIndex, take < rest.endIndex {
                    // One character larger than a piece (a letter under half a million accents): cut
                    // between its Unicode scalars, so no piece, and no Text, is ever larger than the cap.
                    let scalars = rest.unicodeScalars
                    var scalar = scalars.startIndex
                    var used = 0
                    while scalar < scalars.endIndex, used + UTF8.width(scalars[scalar]) <= bytes {
                        used += UTF8.width(scalars[scalar])
                        scalar = scalars.index(after: scalar)
                    }
                    take = scalar
                }
                let part = rest[..<take]
                rest = rest[take...]
                if count == lines || size + part.utf8.count > bytes, !current.isEmpty {
                    out.append(current)
                    current = ""
                    count = 0
                    size = 0
                }
                current += count == 0 ? String(part) : "\n" + part
                count += 1
                size += part.utf8.count + 1
            } while !rest.isEmpty
            if lineEnd == text.endIndex { break }
            lineStart = text.index(after: lineEnd)
        }
        if !current.isEmpty || out.isEmpty { out.append(current) }
        return out
    }
}
