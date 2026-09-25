import BackgroundTasks
import Foundation
import HushOSKit
import Observation

/*
 * Uploads and keeps that outlive the app. iOS does not let an app run its own
 * code for long in the background, but it will carry out transfers itself, even
 * after the app is closed, if they are handed over as files to a background
 * URLSession. So an upload is sealed here first (the server's upload begun,
 * every part encrypted to disk), each part is handed to the session, and the
 * upload is finished here when the app next runs; iOS relaunches it in the
 * background for that when the last part lands. A keep is the same in reverse:
 * the session fetches the encrypted chunks, and they are decrypted here.
 *
 * What waits is kept in the app group, so it survives the app being closed:
 * one record per transfer, its parts or chunks beside it. An upload picked while
 * offline cannot be sealed yet (the server allocates its node), so it waits for
 * the app to run with a network: in the foreground, or when iOS grants the
 * background task below. Once sealed, iOS's own session waits for a network.
 */
@MainActor
@Observable
final class BackgroundTransfers {
    static let shared = BackgroundTransfers()
    static let sessionIdentifier = "com.hushos.app.transfers"
    static let taskIdentifier = "com.hushos.app.transfers.start"

    struct Record: Codable, Identifiable, Equatable {
        enum Kind: String, Codable { case upload, keep }
        enum State: String, Codable { case waiting, sending, finishing, done, failed }
        let id: UUID
        let kind: Kind
        var name: String
        var state: State = .waiting
        // An upload: where it goes, what it replaces, and once sealed, what the server gave it.
        var folderId: String?
        var mime: String?
        var replacingId: String?
        var sealed: Vault.SealedUpload?
        var etags: [Int: String] = [:]
        // A keep: the file, and once planned, its chunk ranges.
        var nodeId: String?
        var plan: KeepPlan?
        var fetched: Set<Int> = []
        /* Parts or chunks whose address expired, to be signed again before they go. */
        var expired: Set<Int> = []
        var failures = 0
        var message: String?

        var total: Int { sealed?.partCount ?? plan?.chunkCount ?? 0 }
        var landed: Int { kind == .upload ? etags.count : fetched.count }
    }

    private(set) var records: [Record] = []
    /* Bytes in flight per record and piece, for the bars; not persisted. */
    private(set) var inFlight: [UUID: [Int: Double]] = [:]
    /* Called when an upload or keep lands, so the lists redraw. */
    var onLanded: (() -> Void)?
    /* The vault the signed-in app holds; a background launch without the UI makes its own. */
    var vault: Vault?
    /* Handed over by iOS when it relaunches the app for the session; called once its events are handled. */
    var eventsHandled: (() -> Void)?

    private let root: URL
    private var session: URLSession!
    private let relay = SessionRelay()
    private var pumping = false
    private var pumpAgain = false
    private var retryScheduled = false
    private var networkToken: UUID?

    private init() {
        let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedKeychain.accessGroup)
            ?? FileManager.default.temporaryDirectory
        root = group.appendingPathComponent("transfers", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        relay.root = root
        if let data = try? Data(contentsOf: root.appendingPathComponent("records.json")),
           let saved = try? JSONDecoder().decode([Record].self, from: data) {
            records = saved.filter { $0.state != .done }
        }
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.sharedContainerIdentifier = SharedKeychain.accessGroup
        session = URLSession(configuration: configuration, delegate: relay, delegateQueue: nil)
        relay.owner = self
        // Back on a network: seal what was waiting and start what is ready.
        networkToken = NetworkWatch.shared.observe { online in
            guard online else { return }
            Task { @MainActor in await BackgroundTransfers.shared.pump() }
        }
    }

    /* Registers the background task that starts waiting transfers; before the app finishes launching. */
    static func registerTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            task.expirationHandler = { task.setTaskCompleted(success: false) }
            Task { @MainActor in
                await BackgroundTransfers.shared.pump()
                task.setTaskCompleted(success: true)
            }
        }
    }

    /* Asks iOS for background time with a network while something still waits to be sealed or planned. */
    func scheduleIfWaiting() {
        guard records.contains(where: { $0.state == .waiting || $0.state == .finishing }) else { return }
        let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        try? BGTaskScheduler.shared.submit(request)
    }

    // MARK: - Queueing

    /* Queues a file for upload into `folderId`; the file is copied into the queue, so the picker's copy can go. */
    func upload(fileURL: URL, name: String, mime: String?, folderId: String, replacingId: String?) {
        let record = Record(id: UUID(), kind: .upload, name: name, folderId: folderId, mime: mime, replacingId: replacingId)
        let directory = folder(record.id)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let content = directory.appendingPathComponent("content")
        if (try? FileManager.default.moveItem(at: fileURL, to: content)) == nil {
            try? FileManager.default.copyItem(at: fileURL, to: content)
        }
        records.append(record)
        save()
        Task { await pump() }
    }

    /* Queues a file to be kept downloaded; asking twice does not fetch it twice. */
    func keep(_ item: Opened) {
        guard !records.contains(where: { $0.kind == .keep && $0.nodeId == item.id && $0.state != .failed }) else { return }
        records.append(Record(id: UUID(), kind: .keep, name: item.name, nodeId: item.id))
        save()
        Task { await pump() }
    }

    /* Stops a transfer: its tasks go, an upload the server began is aborted, its files are removed. */
    func cancel(_ id: UUID) async {
        guard let record = records.first(where: { $0.id == id }) else { return }
        for task in await session.allTasks where task.taskDescription?.hasPrefix(id.uuidString) == true { task.cancel() }
        if let sealed = record.sealed, let vault = currentVault() { await vault.abortUpload(sealed) }
        try? FileManager.default.removeItem(at: folder(id))
        records.removeAll { $0.id == id }
        inFlight[id] = nil
        save()
    }

    /* Signing out: every transfer belongs to the account leaving, so all of them stop and their files go. */
    func cancelAll() async {
        for id in records.map(\.id) { await cancel(id) }
        vault = nil
    }

    func fraction(of record: Record) -> Double {
        guard record.total > 0 else { return 0 }
        let moving = inFlight[record.id]?.values.reduce(0, +) ?? 0
        return min(1, (Double(record.landed) + moving) / Double(record.total))
    }

    // MARK: - The work the app does between the session's transfers

    /*
     * Seals or plans what waits, hands ready pieces to the session, and finishes
     * what has landed. Safe to call any time; one pass runs at a time.
     */
    func pump() async {
        // One pass at a time; a call during a pass asks for another after it, so a finish reported mid-pass is not left waiting.
        guard !pumping else { pumpAgain = true; return }
        pumping = true
        defer {
            pumping = false
            if pumpAgain { pumpAgain = false; Task { await pump() } }
        }
        guard let vault = currentVault() else { return }
        await vault.buildCatalogue()
        let running = Set(await session.allTasks.compactMap(\.taskDescription))
        for id in records.map(\.id) {
            guard let record = records.first(where: { $0.id == id }) else { continue }
            do {
                switch (record.kind, record.state) {
                case (.upload, .waiting):
                    guard NetworkWatch.shared.online else { continue }
                    try await seal(record, vault)
                case (.keep, .waiting):
                    guard NetworkWatch.shared.online else { continue }
                    try await plan(record, vault)
                case (_, .sending):
                    try await refreshExpired(record, vault)
                    start(id, skipping: running)
                case (.upload, .finishing):
                    guard let sealed = record.sealed else { continue }
                    _ = try await vault.finishUpload(sealed, etags: record.etags)
                    land(id)
                case (.keep, .finishing):
                    guard let plan = record.plan else { continue }
                    try await vault.assembleKeep(plan, from: folder(id))
                    land(id)
                default:
                    continue
                }
            } catch {
                fail(id, error)
            }
        }
        save()
        // Something could not start for a reason that passes (the server or its storage down): look again shortly.
        if records.contains(where: { ($0.state == .waiting || $0.state == .finishing) && $0.failures > 0 }), !retryScheduled {
            retryScheduled = true
            Task {
                try? await Task.sleep(for: .seconds(30))
                retryScheduled = false
                await pump()
            }
        }
    }

    private func seal(_ record: Record, _ vault: Vault) async throws {
        let directory = folder(record.id)
        let content = directory.appendingPathComponent("content")
        var replacing: Opened?
        if let replacingId = record.replacingId { replacing = try await vault.resolve(replacingId) }
        let sealed = try await vault.sealUpload(
            fileURL: content, name: record.name, mime: record.mime, in: record.folderId!, replacing: replacing,
            thumbnail: Thumbnails.make(for: content, mime: record.mime), into: directory
        )
        // The parts hold the file now, sealed; the plaintext copy goes.
        try? FileManager.default.removeItem(at: content)
        update(record.id) { $0.sealed = sealed; $0.state = .sending }
        start(record.id, skipping: [])
    }

    private func plan(_ record: Record, _ vault: Vault) async throws {
        let item = try await vault.resolve(record.nodeId!)
        let plan = try await vault.planKeep(item)
        try? FileManager.default.createDirectory(at: folder(record.id), withIntermediateDirectories: true)
        update(record.id) { $0.plan = plan; $0.state = .sending }
        start(record.id, skipping: [])
    }

    private func refreshExpired(_ record: Record, _ vault: Vault) async throws {
        guard !record.expired.isEmpty else { return }
        if var sealed = record.sealed {
            for (part, url) in try await vault.partAddresses(for: sealed, parts: Array(record.expired)) { sealed.urls[part] = url }
            update(record.id) { $0.sealed = sealed; $0.expired = [] }
        } else if var plan = record.plan {
            plan.url = try await vault.keepAddress(plan)
            update(record.id) { $0.plan = plan; $0.expired = [] }
        }
    }

    /* Hands every piece not landed and not already with the session to it; `after` holds a retry back. */
    private func start(_ id: UUID, skipping running: Set<String>, after delay: TimeInterval = 0) {
        guard let record = records.first(where: { $0.id == id }) else { return }
        let directory = folder(id)
        for piece in 0 ..< record.total {
            let description = "\(id.uuidString)|\(piece)"
            if running.contains(description) { continue }
            let task: URLSessionTask
            if let sealed = record.sealed {
                let part = piece + 1
                guard record.etags[part] == nil, !record.expired.contains(part), let address = sealed.urls[part], let url = URL(string: address) else { continue }
                var request = URLRequest(url: url)
                request.httpMethod = "PUT"
                task = session.uploadTask(with: request, fromFile: directory.appendingPathComponent("part-\(part)"))
            } else if let plan = record.plan {
                guard !record.fetched.contains(piece), !record.expired.contains(piece), let url = URL(string: plan.url), let range = plan.ranges[piece] else { continue }
                var request = URLRequest(url: url)
                request.setValue("bytes=\(range[0])-\(range[1])", forHTTPHeaderField: "Range")
                task = session.downloadTask(with: request)
            } else { continue }
            task.taskDescription = description
            if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
            task.resume()
        }
    }

    // MARK: - What the session reports (relayed to the main actor)

    fileprivate func sent(_ description: String, fraction: Double) {
        guard let (id, piece) = Self.parse(description) else { return }
        inFlight[id, default: [:]][piece] = fraction
    }

    fileprivate func finished(_ description: String, status: Int, etag: String?, fetched: Bool, failed: Bool) {
        guard let (id, piece) = Self.parse(description), let record = records.first(where: { $0.id == id }) else { return }
        inFlight[id]?[piece] = nil
        if record.kind == .upload {
            let part = piece + 1
            if !failed, (200 ..< 300).contains(status), let etag {
                try? FileManager.default.removeItem(at: folder(id).appendingPathComponent("part-\(part)"))
                update(id) { $0.etags[part] = etag; $0.failures = 0 }
            } else {
                retry(id, piece: part, status: status)
            }
        } else if fetched {
            update(id) { $0.fetched.insert(piece); $0.failures = 0 }
        } else {
            retry(id, piece: piece, status: status)
        }
        if let current = records.first(where: { $0.id == id }), current.landed == current.total, current.state == .sending {
            update(id) { $0.state = .finishing }
            Task { await pump() }
        }
        save()
    }

    /* An expired address is signed again; anything else waits a growing while and goes again, up to a limit. */
    private func retry(_ id: UUID, piece: Int, status: Int) {
        if status == 403 {
            update(id) { $0.expired.insert(piece) }
            Task { await pump() }
            return
        }
        update(id) { $0.failures += 1 }
        guard let record = records.first(where: { $0.id == id }) else { return }
        if record.failures > 30 {
            fail(id, DriveAPIError.server(status, "The transfer kept failing."))
            return
        }
        start(id, skipping: [], after: Resumable.delay(attempt: min(record.failures, 7)))
    }

    fileprivate func sessionEventsDone() {
        eventsHandled?()
        eventsHandled = nil
    }

    // MARK: - Bookkeeping

    private func land(_ id: UUID) {
        update(id) { $0.state = .done }
        try? FileManager.default.removeItem(at: folder(id))
        onLanded?()
        // Finished rows linger so the result is seen.
        Task {
            try? await Task.sleep(for: .seconds(4))
            records.removeAll { $0.id == id && $0.state == .done }
            save()
        }
    }

    private func fail(_ id: UUID, _ error: Error) {
        // No network yet: stays where it was, for the next pass.
        if Resumable.retryable(error) { update(id) { $0.failures += 1 }; return }
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        if let sealed = records.first(where: { $0.id == id })?.sealed, let vault = currentVault() {
            Task { await vault.abortUpload(sealed) }
        }
        update(id) { $0.state = .failed; $0.message = message }
        try? FileManager.default.removeItem(at: folder(id))
    }

    private func update(_ id: UUID, _ change: (inout Record) -> Void) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        change(&records[index])
    }

    private func save() {
        if let data = try? JSONEncoder().encode(records) { try? data.write(to: root.appendingPathComponent("records.json"), options: .atomic) }
    }

    private func folder(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }

    private func currentVault() -> Vault? {
        if vault == nil { vault = Vault.fromKeychain() }
        return vault
    }

    nonisolated static func parse(_ description: String) -> (UUID, Int)? {
        let parts = description.split(separator: "|")
        guard parts.count == 2, let id = UUID(uuidString: String(parts[0])), let piece = Int(parts[1]) else { return nil }
        return (id, piece)
    }
}

/*
 * The session's delegate. It runs on the session's queue; a fetched chunk must be
 * moved out of its temporary file before the callback returns, so that is done here,
 * and everything else is handed to the main actor.
 */
private final class SessionRelay: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate, @unchecked Sendable {
    weak var owner: BackgroundTransfers?
    var root: URL?
    private let lock = NSLock()
    private var moved: Set<String> = []

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let description = task.taskDescription, totalBytesExpectedToSend > 0 else { return }
        let fraction = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        Task { @MainActor in BackgroundTransfers.shared.sent(description, fraction: fraction) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let description = downloadTask.taskDescription, totalBytesExpectedToWrite > 0 else { return }
        let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        Task { @MainActor in BackgroundTransfers.shared.sent(description, fraction: fraction) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let description = downloadTask.taskDescription, let root, let (id, piece) = BackgroundTransfers.parse(description),
              let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, status == 206 || status == 200 else { return }
        let target = root.appendingPathComponent(id.uuidString, isDirectory: true).appendingPathComponent("chunk-\(piece)")
        try? FileManager.default.removeItem(at: target)
        if (try? FileManager.default.moveItem(at: location, to: target)) != nil {
            lock.withLock { _ = moved.insert(description) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let description = task.taskDescription else { return }
        let response = task.response as? HTTPURLResponse
        let status = response?.statusCode ?? 0
        let etag = response?.value(forHTTPHeaderField: "ETag")
        let fetched = lock.withLock { moved.remove(description) != nil }
        let failed = error != nil
        Task { @MainActor in
            BackgroundTransfers.shared.finished(description, status: status, etag: etag, fetched: fetched, failed: failed)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in BackgroundTransfers.shared.sessionEventsDone() }
    }
}
