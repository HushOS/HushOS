import HushOSKit
import SwiftUI
import UIKit

/*
 * Transfers (DESIGN.md): one vocabulary for the bar, the sheet
 * and the Live Activity, the same as the web's and Android's. Each row says where
 * it is in words, errors with what to do; cancel asks first; Retry failed and
 * Clear finished act on the lot. Key rotation is not a transfer any more.
 */

/* What a row says when something went wrong, and why. */
enum TransferWords {
    static let network = "Couldn’t reach HushOS. Check your connection, then retry."
    static let keep = "Couldn’t update the copy on this phone. Retry, or keep it again later."
    static let repeated = "This kept failing. Retry, or remove it from the list."
    static let signedOut = "Sign in again to finish this."
    static let gone = "The file isn’t there any more. Pick it again."
    static let noRoom = "Not enough room for this file."

    static func reason(_ error: Error) -> String {
        switch error {
        case DriveAPIError.transport: return network
        case DriveAPIError.notAuthenticated: return signedOut
        case DriveAPIError.server(402, _): return noRoom
        case let cocoa as CocoaError where cocoa.code == .fileNoSuchFile || cocoa.code == .fileReadNoSuchFile: return gone
        default: return (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    static func keepReason(_ error: Error) -> String {
        if case DriveAPIError.transport = error { return network }
        if case DriveAPIError.notAuthenticated = error { return signedOut }
        return keep
    }
}

/* One row, from either source: the background queue (uploads into one's own drive, kept files) or this session. */
struct TransferRowModel: Identifiable, Equatable {
    enum Direction { case up, down, keep }
    enum Status { case waiting, running, failed, done }
    let id: String
    var direction: Direction
    var name: String
    var status: Status
    var fraction: Double
    var size: Int64?
    var message: String?
    var noRoom = false
    /* A kept folder's row: its files together. */
    var folder = false
    /* Waiting because the last try failed for a reason that passes (HushOS or its storage not answering). */
    var retrying = false
    var canRetry = false
    /* Only background transfers can be stopped; this session's run to the end. */
    var cancellable = false
    var queuedId: UUID?
    var foregroundId: UUID?
    /* A kept folder's row stands for several queued keeps: all of them are cancelled or removed together. */
    var queuedIds: [UUID] = []

    @MainActor static func rows(queued: [BackgroundTransfers.Record], foreground: [DriveStore.TransferItem]) -> [TransferRowModel] {
        // A kept folder's files: one row, named after the folder, with progress across its files.
        var groups: [TransferRowModel] = []
        for group in Array(Set(queued.compactMap(\.group))).sorted() {
            let members = queued.filter { $0.group == group }
            let active = members.filter { $0.state != .done && $0.state != .failed }
            let failed = members.filter { $0.state == .failed }
            let sizes = members.map { Double($0.size ?? 1) }
            let total = max(1, sizes.reduce(0, +))
            let moved = zip(members, sizes).map { record, size in
                // As Android counts it: a file's bytes count in full only once it is kept; one still
                // landing or being decrypted counts for at most 90%, so the bar never reads 99%
                // while the count still says "1 of 4 files".
                (record.state == .done ? 1 : record.state == .failed ? 0 : min(0.9, BackgroundTransfers.shared.fraction(of: record))) * size
            }.reduce(0, +)
            let failedLine = failed.count == 1 ? "1 file couldn’t be kept" : "\(failed.count) files couldn’t be kept"
            groups.append(TransferRowModel(
                id: "folder-" + group, direction: .keep, name: members.first?.groupName ?? "Folder",
                status: !active.isEmpty ? (active.allSatisfy { $0.state == .waiting } ? .waiting : .running) : failed.isEmpty ? .done : .failed,
                fraction: moved / total,
                size: Int64(total),
                message: failed.isEmpty ? nil : failedLine,
                folder: true,
                cancellable: !active.isEmpty,
                queuedIds: members.map(\.id)
            ))
        }
        let fromQueue = queued.filter { $0.group == nil }.map { record in
            TransferRowModel(
                id: record.id.uuidString,
                direction: record.kind == .upload ? .up : .keep,
                name: record.name,
                status: record.state == .done ? .done : record.state == .failed ? .failed : record.state == .waiting ? .waiting : .running,
                fraction: record.state == .done ? 1 : BackgroundTransfers.shared.fraction(of: record),
                size: record.size,
                message: record.state == .failed ? record.message ?? TransferWords.repeated : nil,
                noRoom: record.noRoom == true,
                retrying: record.state != .failed && record.state != .done && record.failures > 0,
                canRetry: BackgroundTransfers.shared.canRetry(record),
                cancellable: record.state != .done && record.state != .failed,
                queuedId: record.id
            )
        }
        let fromSession = foreground.map { item in
            TransferRowModel(
                id: item.id.uuidString,
                direction: item.kind == .keep ? .keep : item.kind == .download ? .down : .up,
                name: item.name,
                status: item.failed ? .failed : item.done ? .done : item.waiting ? .waiting : .running,
                fraction: item.done && !item.failed ? 1 : item.fraction,
                size: item.size,
                message: item.message,
                noRoom: item.noRoom,
                folder: item.folder,
                canRetry: item.canRetry,
                foregroundId: item.id
            )
        }
        return groups + fromQueue + fromSession
    }
}

/* The headline every surface uses, and the line under each row. */
enum TransferSummary {
    static func active(_ row: TransferRowModel) -> Bool { row.status == .running || row.status == .waiting }

    /* `batch`: how many files to name while some run (the Live Activity counts the whole batch, as its "1 of 2" does). */
    static func headline(_ rows: [TransferRowModel], offline: Bool, batch: Int? = nil) -> String {
        let running = rows.filter(active)
        if !running.isEmpty {
            if offline { return "Waiting for a connection" }
            let n = files(batch ?? running.count)
            let directions = Set(running.map(\.direction))
            if directions.count > 1 { return "Transferring \(n)" }
            switch directions.first {
            case .up: return "Uploading \(n)"
            case .down: return "Downloading \(n)"
            default:
                // A kept folder is named: "Keeping “Lisbon 2026” on this phone".
                if running.count == 1, running[0].folder { return "Keeping “\(running[0].name)” on this phone" }
                return "Keeping \(n) on this phone"
            }
        }
        let failed = rows.filter { $0.status == .failed }
        if !failed.isEmpty { return "\(failed.count == 1 ? "1 transfer" : "\(failed.count) transfers") didn’t finish" }
        let done = rows.filter { $0.status == .done }
        if !done.isEmpty {
            return done.allSatisfy { $0.direction == .up } ? "\(files(done.count)) uploaded" : "\(done.count == 1 ? "1 transfer" : "\(done.count) transfers") finished"
        }
        return "No transfers"
    }

    /* "2 of 5": finished out of everything in the list. */
    static func count(_ rows: [TransferRowModel]) -> String {
        "\(rows.filter { $0.status == .done }.count) of \(rows.count)"
    }

    static func overall(_ rows: [TransferRowModel]) -> Double {
        rows.isEmpty ? 0 : rows.map(\.fraction).reduce(0, +) / Double(rows.count)
    }

    static func status(_ row: TransferRowModel, offline: Bool) -> String {
        switch row.status {
        case .waiting:
            if offline { return "Waiting for a connection" }
            return row.retrying ? "HushOS isn’t answering. Trying again shortly." : "Waiting"
        case .running:
            if row.retrying && !offline { return "HushOS isn’t answering. Trying again shortly." }
            guard let size = row.size, size > 0 else { return "\(Int(row.fraction * 100))%" }
            return "\(formatBytes(Int64(Double(size) * row.fraction))) of \(formatBytes(size))"
        case .failed: return row.message ?? TransferWords.repeated
        case .done:
            let size = row.size.map { " · \(formatBytes($0))" } ?? ""
            switch row.direction {
            case .up: return "Uploaded" + size
            case .down: return "Downloaded" + size
            case .keep: return "On this phone" + size
            }
        }
    }

    private static func files(_ n: Int) -> String { n == 1 ? "1 file" : "\(n) files" }
}

/*
 * The Live Activity follows the queue, not the hand-over: it starts with the first
 * transfer, carries the same headline as the bar, and ends with the last file,
 * finished or not.
 */
@MainActor
final class TransferLive {
    static let shared = TransferLive()
    private let activity = TransferActivity()
    var foreground: [DriveStore.TransferItem] = [] { didSet { refresh() } }

    func refresh() {
        let rows = TransferRowModel.rows(queued: BackgroundTransfers.shared.records, foreground: foreground)
        let running = rows.filter(TransferSummary.active)
        let offline = !NetworkWatch.shared.online
        var title = TransferSummary.headline(rows, offline: offline)
        if !running.isEmpty {
            let first = running.first { $0.status == .running } ?? running[0]
            // The batch on its way: a failure earlier in the list is not part of it, so it neither
            // counts in "1 of 2" nor holds the bar back.
            let batch = rows.filter { $0.status != .failed }
            // The headline names the same set the line under it counts: "Keeping 2 files" with "1 of 2".
            title = TransferSummary.headline(rows, offline: offline, batch: batch.count)
            // One file: its name (the headline already says "1 file"). Several: how far, then the current one.
            var detail = batch.count == 1 ? first.name : "\(TransferSummary.count(batch)) · \(first.name)"
            if running.count == 1, first.folder, !offline {
                // A kept folder: the island has room for its name, not the whole sentence, and counts its files.
                let files = BackgroundTransfers.shared.records.filter { first.queuedIds.contains($0.id) }
                title = "Keeping “\(first.name)”"
                detail = "On this phone · \(files.filter { $0.state == .done }.count) of \(max(files.count, 1)) \(files.count > 1 ? "files" : "file")"
            }
            if activity.running {
                // As a kept folder counts (and Android): a file still on its way counts for at most
                // 90%, so the bar never reads 99% while the line under it says "1 of 2".
                let fraction = batch.isEmpty ? 0 : batch.map { $0.status == .done ? 1 : min(0.9, $0.fraction) }.reduce(0, +) / Double(batch.count)
                activity.update(title: title, fraction: fraction, detail: detail)
            } else {
                let kind = running.contains { $0.direction == .up } ? "upload" : running.contains { $0.direction == .keep } ? "keep" : "download"
                activity.start(kind: kind, title: title, detail: detail)
            }
        } else if activity.running {
            let failed = rows.contains { $0.status == .failed }
            activity.finish(title: title, detail: failed ? "Open HushOS to retry" : "", failed: failed,
                            count: failed ? TransferSummary.count(rows) : "", fraction: failed ? TransferSummary.overall(rows) : 1)
        }
    }
}

/* MARK: The bar */

/* One line in the tab bar's accessory: how it is going, and how far. Inline beside the folded tab bar it keeps only the words. */
struct TransfersAccessoryBar: View {
    let rows: [TransferRowModel]
    let offline: Bool
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        HStack(spacing: 10) {
            LeadIcon(rows: rows)
            Text(TransferSummary.headline(rows, offline: offline)).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink).lineLimit(1)
            Spacer(minLength: 0)
            if placement != .inline {
                Text(TransferSummary.count(rows)).font(Theme.Text.footnote.monospacedDigit()).foregroundStyle(Alpine.inkMuted)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows every transfer")
    }
}

/* A ring while things move; a check when all finished; a mark when something didn't. */
private struct LeadIcon: View {
    let rows: [TransferRowModel]

    var body: some View {
        let running = rows.contains(where: TransferSummary.active)
        let failed = rows.contains { $0.status == .failed }
        if running {
            ZStack {
                Circle().stroke(Alpine.primary.opacity(0.2), lineWidth: 3)
                Circle().trim(from: 0, to: max(0.04, TransferSummary.overall(rows))).stroke(Alpine.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: 20, height: 20)
            .accessibilityHidden(true)
        } else {
            Image(systemName: failed ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(failed ? Alpine.danger : Alpine.success)
                .accessibilityHidden(true)
        }
    }
}

/* MARK: The sheet */

/*
 * Every transfer: retry and cancel on the row, long-press for Remove from list,
 * and Retry failed (or Make room), Clear finished and Cancel all at the foot. Not enough
 * room leads to the storage sheet rather than a second copy of it here.
 */
struct TransfersSheet: View {
    let rows: [TransferRowModel]
    let offline: Bool
    let retry: (TransferRowModel) -> Void
    let remove: (TransferRowModel) -> Void
    let cancel: ([TransferRowModel]) async -> Void
    let clearFinished: () -> Void
    let makeRoom: () -> Void
    @Environment(\.dismiss) private var dismissSheet
    @State private var confirming: [TransferRowModel]?

    var body: some View {
        let failed = rows.filter { $0.status == .failed && $0.canRetry && !$0.noRoom }
        let cancellable = rows.filter(\.cancellable)
        // Failed rows stay until retried or removed one by one: clearing must not drop what still needs doing.
        let finished = rows.contains { $0.status == .done }
        // Every failure is "not enough room": retrying can't work until there is room, so Make room leads, once.
        let failures = rows.filter { $0.status == .failed }
        let onlyRoom = !failures.isEmpty && failures.allSatisfy(\.noRoom)
        NavigationStack {
            List {
                Section {
                    if rows.isEmpty { Text("Nothing left in the list").foregroundStyle(Alpine.inkMuted).alpineRow() }
                    ForEach(failuresFirst(rows)) { row in
                        TransferRow(row: row, offline: offline, retry: { retry(row) }, cancel: { confirming = [row] }, makeRoom: onlyRoom ? nil : makeRoom)
                            .contextMenu {
                                // Out of room, retrying can't work until there is room.
                                if row.canRetry, !row.noRoom { Button("Retry", systemImage: "arrow.clockwise") { retry(row) } }
                                if row.cancellable {
                                    Button("Cancel", systemImage: "xmark", role: .destructive) { confirming = [row] }.tint(Alpine.danger)
                                } else if row.status == .done || row.status == .failed {
                                    Button("Remove from list", systemImage: "xmark") { remove(row) }
                                }
                            }
                            .itemRow()
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            // The sheet's actions sit at its foot, whatever the list's length; the list scrolls above them.
            .safeAreaInset(edge: .bottom) {
                if onlyRoom || failed.count > 1 || cancellable.count > 1 || finished {
                    VStack(spacing: Alpine.Space.s2) {
                        if onlyRoom {
                            Button { makeRoom() } label: { Text("Make room").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                        } else if failed.count > 1 {
                            Button { failed.forEach(retry) } label: { Text("Retry failed").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                        }
                        // Failed rows stay until retried or removed one by one: clearing must not drop what still needs doing.
                        if finished {
                            Button { clearFinished() } label: { Text("Clear finished").frame(maxWidth: .infinity) }.buttonStyle(SecondaryCapsuleStyle())
                        }
                        if cancellable.count > 1 {
                            Button { confirming = cancellable } label: { Text("Cancel all").foregroundStyle(Alpine.danger).frame(maxWidth: .infinity) }
                                .buttonStyle(SecondaryCapsuleStyle())
                        }
                    }
                    .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s2).padding(.bottom, Alpine.Space.s2)
                    .background(Alpine.ground)
                }
            }
            .environment(\.defaultMinListRowHeight, 1)
            .navigationTitle(TransferSummary.headline(rows, offline: offline))
            .navigationSubtitle(Text(TransferSummary.count(rows)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismissSheet() } }
            }
            .alert(confirming.map { $0.count == 1 ? "Cancel this transfer?" : "Cancel \($0.count) transfers?" } ?? "",
                   isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
                Button("Keep going", role: .cancel) { confirming = nil }
                Button(confirming?.count == 1 ? "Cancel it" : "Cancel them all", role: .destructive) {
                    let targets = confirming ?? []
                    confirming = nil
                    Task { await cancel(targets) }
                }
            } message: {
                Text("What is still on its way stops and isn’t kept. What already finished stays where it is.")
            }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: rows.isEmpty) { _, empty in if empty { dismissSheet() } }
    }

    /* Failures lead: they are why the list is still up. */
    private func failuresFirst(_ rows: [TransferRowModel]) -> [TransferRowModel] {
        rows.filter { $0.status == .failed } + rows.filter { $0.status != .failed }
    }
}

/* One transfer: what it is, how far in words, how it ended and why, and what can be done. */
private struct TransferRow: View {
    let row: TransferRowModel
    let offline: Bool
    let retry: () -> Void
    let cancel: () -> Void
    /* Nil when the sheet's foot already offers Make room for every failure. */
    let makeRoom: (() -> Void)?

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            Image(systemName: icon).font(.title3).foregroundStyle(Alpine.primary)
                .frame(width: Theme.mark, height: Theme.mark).background(Alpine.tint, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                // Cut in the middle, so the extension shows.
                Text(row.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1).truncationMode(.middle)
                if TransferSummary.active(row) {
                    ProgressView(value: row.fraction).tint(Alpine.primary)
                }
                Text(TransferSummary.status(row, offline: offline))
                    .font(Theme.Text.footnote)
                    .foregroundStyle(row.status == .failed ? Alpine.danger : row.status == .done ? Alpine.success : Alpine.inkMuted)
                    .lineLimit(3)
            }
            Spacer(minLength: 0)
            if row.noRoom {
                if let makeRoom {
                    Button("Make room", action: makeRoom).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.onTint)
                        .padding(.horizontal, 12).frame(height: 32).background(Alpine.tint, in: Capsule()).buttonStyle(.plain)
                }
            } else if row.canRetry {
                roundButton("arrow.clockwise", label: "Retry \(row.name)", tint: true, action: retry)
            }
            if row.cancellable {
                roundButton("xmark", label: "Cancel \(row.name)", tint: false, action: cancel)
            } else if row.status == .done {
                Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(Alpine.success).accessibilityLabel("Finished")
            }
        }
        .padding(.vertical, Alpine.Space.s2)
        .frame(minHeight: Theme.row)
    }

    private var icon: String {
        switch row.direction {
        case .up: return "arrow.up"
        case .down, .keep: return "arrow.down"
        }
    }

    private func roundButton(_ symbol: String, label: String, tint: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.footnote.weight(.bold))
                .foregroundStyle(tint ? Alpine.onTint : Alpine.ink)
                .frame(width: 36, height: 36)
                .background(tint ? Alpine.tint : Alpine.ink.opacity(0.07), in: Circle())
        }
        .buttonStyle(.plain)
        .frame(width: Theme.control, height: Theme.control)
        .accessibilityLabel(label)
    }
}
