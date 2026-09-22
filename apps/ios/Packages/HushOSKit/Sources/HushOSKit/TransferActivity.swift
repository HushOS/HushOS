import Foundation
#if canImport(ActivityKit)
@preconcurrency import ActivityKit

/* A transfer in flight, shown on the Lock Screen and in the Dynamic Island while the app is away. */
public struct TransferAttributes: ActivityAttributes, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
        public var title: String
        public var fraction: Double
        public var done: Bool
        public init(title: String, fraction: Double, done: Bool) {
            self.title = title
            self.fraction = fraction
            self.done = done
        }
    }

    /// "upload" or "download".
    public var kind: String
    public init(kind: String) { self.kind = kind }
}

/* Starts, updates and ends the one Live Activity a transfer batch owns. */
@MainActor
public final class TransferActivity {
    private var activity: Activity<TransferAttributes>?
    private var lastFraction = 0.0

    public init() {}

    public func start(kind: String, title: String) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end()
        let state = TransferAttributes.ContentState(title: title, fraction: 0, done: false)
        activity = try? Activity.request(attributes: TransferAttributes(kind: kind), content: .init(state: state, staleDate: nil))
        lastFraction = 0
    }

    public func update(title: String, fraction: Double) {
        guard let activity, fraction - lastFraction >= 0.02 || fraction >= 1 else { return }
        lastFraction = fraction
        Task { await activity.update(.init(state: .init(title: title, fraction: fraction, done: false), staleDate: nil)) }
    }

    public func finish(title: String) {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(.init(state: .init(title: title, fraction: 1, done: true), staleDate: nil), dismissalPolicy: .after(.now + 4)) }
    }

    public func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
}
#endif
