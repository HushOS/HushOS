import Foundation
#if canImport(ActivityKit)
@preconcurrency import ActivityKit

/* A transfer in flight, shown on the Lock Screen and in the Dynamic Island while the app is away. */
public struct TransferAttributes: ActivityAttributes, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
        /* The shared headline: "Uploading 3 files", "3 files uploaded", "1 transfer didn’t finish". */
        public var title: String
        public var fraction: Double
        public var done: Bool
        /* The line under it: "Sintra.jpg · 1 of 3", "In Lisbon 2026", "Open HushOS to retry". */
        public var detail: String
        /* Ended with something that didn't finish. */
        public var failed: Bool
        /* "2 of 3": what finished out of the batch, shown on the right when it ended badly. */
        public var count: String
        public init(title: String, fraction: Double, done: Bool, detail: String = "", failed: Bool = false, count: String = "") {
            self.title = title
            self.fraction = fraction
            self.done = done
            self.detail = detail
            self.failed = failed
            self.count = count
        }
    }

    /// "upload", "download" or "keep".
    public var kind: String
    public init(kind: String) { self.kind = kind }
}

/* Starts, updates and ends the one Live Activity a transfer batch owns. */
@MainActor
public final class TransferActivity {
    private var activity: Activity<TransferAttributes>?
    private var lastFraction = 0.0
    private var lastTitle = ""
    private var lastDetail = ""

    public init() {}

    public var running: Bool { activity != nil }

    public func start(kind: String, title: String, detail: String = "") {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end()
        // One activity at a time: an earlier batch's "didn't finish" (kept on the Lock Screen until seen)
        // gives way to the new batch rather than sitting on top of it.
        for earlier in Activity<TransferAttributes>.activities {
            Task { await earlier.end(nil, dismissalPolicy: .immediate) }
        }
        let state = TransferAttributes.ContentState(title: title, fraction: 0, done: false, detail: detail)
        activity = try? Activity.request(attributes: TransferAttributes(kind: kind), content: .init(state: state, staleDate: nil))
        lastFraction = 0
        lastTitle = title
        lastDetail = detail
    }

    /* Pushed when the words change or the bar moves 2%: an activity has an update budget. */
    public func update(title: String, fraction: Double, detail: String = "") {
        guard let activity, title != lastTitle || detail != lastDetail || fraction - lastFraction >= 0.02 || fraction >= 1 else { return }
        lastFraction = fraction
        lastTitle = title
        lastDetail = detail
        Task { await activity.update(.init(state: .init(title: title, fraction: fraction, done: false, detail: detail), staleDate: nil)) }
    }

    public func finish(title: String, detail: String = "", failed: Bool = false, count: String = "", fraction: Double = 1) {
        guard let activity else { return }
        self.activity = nil
        let state = TransferAttributes.ContentState(title: title, fraction: fraction, done: true, detail: detail, failed: failed, count: count)
        // A batch that finished leaves after a few seconds; one that didn't stays until it's seen.
        Task { await activity.end(.init(state: state, staleDate: nil), dismissalPolicy: failed ? .default : .after(.now + 4)) }
    }

    public func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}
#endif
