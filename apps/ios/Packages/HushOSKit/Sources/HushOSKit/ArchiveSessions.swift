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
        let lock = NSLock()
        var archives: [UUID: @Sendable () -> Void] = [:]
        var calls: [UUID: RunControl] = [:]
    }
    private static let live = Live()

    static func track(archive id: UUID, close: @escaping @Sendable () -> Void) { live.lock.withLock { live.archives[id] = close } }
    static func untrack(archive id: UUID) { _ = live.lock.withLock { live.archives.removeValue(forKey: id) } }
    static func track(call id: UUID, _ control: RunControl) { live.lock.withLock { live.calls[id] = control } }
    static func untrack(call id: UUID) { _ = live.lock.withLock { live.calls.removeValue(forKey: id) } }

    /* Sign-out: every call in flight is cancelled, and every archive is closed, its password wiped. */
    public static func closeAll() {
        let (closes, controls) = live.lock.withLock { (Array(live.archives.values), Array(live.calls.values)) }
        for control in controls { control.cancel() }
        for close in closes { close() }
    }

    /* Whether anything is open or in flight: for tests. */
    public static var idle: Bool { live.lock.withLock { live.archives.isEmpty && live.calls.isEmpty } }

    /* The watchdogs' own queue, as ToolRuns' are: never the cooperative pool. */
    static let watchdogQueue = DispatchQueue(label: "com.hushos.archive-watchdog")
    /* Where archives are closed: never the main thread. */
    static let closeQueue = DispatchQueue(label: "com.hushos.archive-close", qos: .userInitiated)
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
        case .failure(let error): throw FetchError.Failed(reason: error.localizedDescription)
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
        do { try put(chunk) } catch { throw FetchError.Failed(reason: error.localizedDescription) }
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
            throw FetchError.Failed(reason: error.localizedDescription)
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
    private let session: ZipArchiveSession
    private let turns = ArchiveTurns()
    private let calls = ArchiveCalls()
    private let siblings = ArchiveSiblings()
    private let id = UUID()
    private let watchdog: Duration
    private let poll: Duration
    /* Reached by a sign-out (`ArchiveSessions.closeAll`). Every archive the app opens is; a test's own may not be, so another suite's sign-out can't close it mid-test. */
    private let registered: Bool

    init(session: ZipArchiveSession, kept: Bool = false, watchdog: Duration, poll: Duration, registered: Bool = true) {
        self.session = session
        self.kept = kept
        entries = session.entries()
        hidden = Int(session.hidden())
        self.watchdog = watchdog
        self.poll = poll
        self.registered = registered
        if registered {
            ArchiveSessions.track(archive: id) { [session, calls, siblings] in
                calls.cancelAll()
                for sibling in siblings.takeAll() { OpenArchive.closeOffMain(sibling) }
                OpenArchive.closeOffMain(session)
            }
        }
    }

    deinit {
        calls.cancelAll()
        for sibling in siblings.takeAll() { OpenArchive.closeOffMain(sibling) }
        OpenArchive.closeOffMain(session)
        if registered { ArchiveSessions.untrack(archive: id) }
    }

    /* The core's close, never on the main thread: it doesn't wait on a read, but it is still the core's work. */
    static func closeOffMain(_ session: ZipArchiveSession) {
        ArchiveSessions.closeQueue.async { session.closeArchive() }
    }

    /*
     * Opens `item`'s current version, reading its directory (every cap of section 3) on a call of
     * its own: from the copy this phone keeps when there is one (it opens offline), otherwise
     * from the store. Throws ArchiveFailure.
     */
    public static func open(_ item: Opened, vault: Vault, watchdog: Duration = .milliseconds(Int(toolWatchdogMillis())), poll: Duration = .seconds(1)) async throws -> OpenArchive {
        if let url = Offline.localCopy(of: item), let copy = try? KeptCopy(url: url) {
            return try await open(local: copy, watchdog: watchdog, poll: poll)
        }
        try await vault.holdForCopy(item)
        let current = try await currentRow(item, vault: vault)
        let opened = try await vault.openVersion(current)
        let source = archiveSource(api: vault.api, versionId: opened.versionId, workspaceId: current.node.workspaceId)
        let content = opened.content
        let session = try await call(watchdog: watchdog, poll: poll) { control in
            try ZipArchiveSession.open(source: source, content: content, control: control)
        }
        let archive = OpenArchive(session: session, watchdog: watchdog, poll: poll)
        archive.row = current
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
    public static func openKept(_ url: URL, watchdog: Duration = .milliseconds(Int(toolWatchdogMillis())), poll: Duration = .seconds(1)) async throws -> OpenArchive {
        let copy: KeptCopy
        do { copy = try KeptCopy(url: url) } catch { throw ArchiveFailure(code: nil, message: ErrorWords.generic) }
        return try await open(local: copy, watchdog: watchdog, poll: poll)
    }

    /* An archive over any source (the tests' sealed fixtures). */
    static func open(source: ObjectSource, content: Content, watchdog: Duration, poll: Duration = .seconds(1), registered: Bool = true) async throws -> OpenArchive {
        let session = try await call(watchdog: watchdog, poll: poll, registered: registered) { control in
            try ZipArchiveSession.open(source: source, content: content, control: control)
        }
        return OpenArchive(session: session, watchdog: watchdog, poll: poll, registered: registered)
    }

    /* An archive over a copy kept on the phone (or a test's bytes). */
    static func open(local: LocalSource, watchdog: Duration, poll: Duration = .seconds(1), registered: Bool = true) async throws -> OpenArchive {
        let session = try await call(watchdog: watchdog, poll: poll, registered: registered) { control in
            try ZipArchiveSession.openLocal(source: local, control: control)
        }
        return OpenArchive(session: session, kept: true, watchdog: watchdog, poll: poll, registered: registered)
    }

    /* Whether a password is held. */
    public var unlocked: Bool { session.unlocked() }

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
        let key = UUID()
        let sibling: ZipArchiveSession
        do { sibling = try session.sibling() } catch { throw ArchiveFailure.from(error, control: RunControl(watchdogMillis: 1, clock: nil), scope: .entry) }
        // The archive closed while the sibling was made: nothing would close it, so it goes now.
        guard siblings.add(key, sibling) else {
            OpenArchive.closeOffMain(sibling)
            throw ArchiveFailure.closed
        }
        defer { if let done = siblings.remove(key) { OpenArchive.closeOffMain(done) } }
        try await Self.call(watchdog: watchdog, poll: poll, scope: .entry, on: calls, registered: registered) { control in
            try sibling.download(index: entry.index, sink: sink, control: control)
        }
    }

    /*
     * Closes the archive: every call in flight on it is cancelled first, then the core wipes the
     * password and the key off the main thread. Any later call fails.
     */
    public func close() {
        calls.cancelAll()
        for sibling in siblings.takeAll() { OpenArchive.closeOffMain(sibling) }
        OpenArchive.closeOffMain(session)
        ArchiveSessions.untrack(archive: id)
    }

    private func turn<T: Sendable>(scope: ArchiveWords.Scope, _ work: @escaping @Sendable (RunControl) throws -> T) async throws -> T {
        do { try await turns.take() } catch { throw ArchiveFailure(code: nil, message: "Cancelled.") }
        defer { Task { await turns.give() } }
        return try await Self.call(watchdog: watchdog, poll: poll, scope: scope, on: calls, registered: registered, work)
    }

    /*
     * `work` on a thread of its own under a fresh RunControl, as ToolRuns.run does, without the
     * run slot: the watchdog polled every `poll`, a cancel from the task, the archive's close or a
     * sign-out ending it at once, `finish()` when the thread returns.
     */
    static func call<T: Sendable>(watchdog: Duration, poll: Duration, scope: ArchiveWords.Scope = .archive, on calls: ArchiveCalls? = nil, registered: Bool = true, _ work: @escaping @Sendable (RunControl) throws -> T) async throws -> T {
        let millis = UInt64(watchdog.components.seconds) * 1000 + UInt64(watchdog.components.attoseconds / 1_000_000_000_000_000)
        let control = RunControl(watchdogMillis: millis, clock: nil)
        let id = UUID()
        let outcome = CallOutcome<T>()
        // On an archive closed already (or closing) nothing starts: no thread, no read.
        if let calls, !calls.add(id, control) { throw ArchiveFailure.closed }
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
                let result = Result { try work(control) }.mapError { ArchiveFailure.from($0, control: control, scope: scope) as Error }
                Thread.current.threadDictionary[controlKey] = nil
                // The call's reader lets go of its chunks and its key now, before anyone is told.
                control.finish()
                outcome.finish(result)
                watcher.cancel()
                ArchiveSessions.untrack(call: id)
                calls?.remove(id)
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

/* A row of an archive's folder: a folder with how many items it holds, or a file. */
public enum ArchiveRow: Equatable, Sendable {
    case folder(name: String, count: Int)
    case file(ArchiveEntry)

    public var name: String {
        switch self {
        case .folder(let name, _): name
        case .file(let entry): entry.parts.last ?? entry.path
        }
    }
}

/*
 * The archive's folders, as the web's archive view builds them (archive-view.tsx, treeOf): every
 * folder an entry's path names, explicit or not; Mac resource entries left out; folders first,
 * then files, each by name as Files sorts them. A tree of nodes, each holding its own children,
 * so memory grows with the entries' parts and never with every prefix of a path; each folder's
 * rows are sorted once, when the tree is made.
 */
public struct ArchiveTree: Sendable {
    private final class Node: @unchecked Sendable {
        var folders: [String: Node] = [:]
        var files: [ArchiveEntry] = []
        var rows: [ArchiveRow] = []
    }

    private let top: Node

    public init(_ entries: [ArchiveEntry]) {
        let top = Node()
        for entry in entries where !entry.hidden {
            let depth = entry.directory ? entry.parts.count : entry.parts.count - 1
            guard depth >= 0 else { continue }
            var node = top
            for part in entry.parts.prefix(depth) {
                if let child = node.folders[part] { node = child } else {
                    let child = Node()
                    node.folders[part] = child
                    node = child
                }
            }
            if !entry.directory { node.files.append(entry) }
        }
        let byName: (String, String) -> Bool = { $0.localizedStandardCompare($1) == .orderedAscending }
        var pending = [top]
        while let node = pending.popLast() {
            let names = node.folders.keys.sorted(by: byName)
            let files = node.files.sorted { byName($0.parts.last ?? $0.path, $1.parts.last ?? $1.path) }
            node.rows = names.map { name in
                let child = node.folders[name]!
                return .folder(name: name, count: child.folders.count + child.files.count)
            } + files.map { .file($0) }
            pending.append(contentsOf: node.folders.values)
        }
        self.top = top
    }

    /* The rows of the folder at `path` (empty: the top), sorted when the tree was made. */
    public func rows(at path: [String]) -> [ArchiveRow] {
        var node: Node? = top
        for part in path { node = node?.folders[part] }
        return node?.rows ?? []
    }
}

public enum ArchiveEntries {
    /* Whether a file opens as an archive's list: a zip, by its type or its name. */
    public static func handles(name: String, mime: String?) -> Bool {
        let type = (mime ?? "").lowercased()
        return type == "application/zip" || type == "application/x-zip-compressed" || (name as NSString).pathExtension.lowercased() == "zip"
    }

    /* When it last changed: its Unix time when the archive kept one, else its MS-DOS date and time, as local time. */
    public static func date(_ entry: ArchiveEntry, calendar: Calendar = .current) -> Date? {
        if let millis = entry.mtimeMillis { return Date(timeIntervalSince1970: Double(millis) / 1000) }
        let date = entry.dos >> 16, time = entry.dos & 0xffff
        let month = Int((date >> 5) & 0xf), day = Int(date & 0x1f)
        guard month > 0, day > 0 else { return nil }
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
public enum ArchiveText {
    public static let lines = 200
    public static let bytes = 16 * 1024

    public static func pieces(_ data: Data) -> [String] {
        let text = String(decoding: data, as: UTF8.self)
        var out: [String] = []
        var current = ""
        var count = 0
        var size = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var rest = Substring(line)
            repeat {
                var take = rest.startIndex
                var used = 0
                while take < rest.endIndex, used + rest[take].utf8.count <= bytes {
                    used += rest[take].utf8.count
                    take = rest.index(after: take)
                }
                if take == rest.startIndex, take < rest.endIndex { take = rest.index(after: take) }
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
        }
        if !current.isEmpty || out.isEmpty { out.append(current) }
        return out
    }
}
