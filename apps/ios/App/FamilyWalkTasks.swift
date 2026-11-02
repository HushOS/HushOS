import BackgroundTasks
import Foundation
import HushOSKit
import os

/*
 * The family check while the app is closed (docs/groups-mobile-plan.md iOS 4, owner decision): a
 * BGProcessingTask that runs one HushOSKit pass (FamilySync.backgroundPass), so a key change a
 * removal leaves in a family folder is walked even if nobody opens the app.
 *
 * - Scheduled for the session that asked (its tag, never its secret): a pass that finds another
 *   session stored, or none, does nothing, and signing out cancels it.
 * - Asked for every hour or so while the account is in a family (or a removal isn't settled), and
 *   sooner after a walk was found due or a pass stopped short, with the wait doubling from 30
 *   seconds to 10 minutes. iOS decides when it runs; the foreground walks don't wait for it.
 * - It uses the app's own vault (one ledger, one family turn per process).
 * - Its time running out stops the pass between batches (never with keys pending); the task then
 *   asks to run again.
 */
@MainActor
enum FamilyWalkTasks {
    static let identifier = "com.hushos.app.families.walks"
    private static let sessionKey = "familyWalks.session"
    private static let attemptsKey = "familyWalks.attempts"
    private static let hour: TimeInterval = 60 * 60
    /* What a pass ended as: no names, ids or keys. */
    private static let log = Logger(subsystem: "com.hushos.app", category: "family-check")

    /* Registers the task's handler; before the app finishes launching. */
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            Task { @MainActor in handle(task) }
        }
    }

    /*
     * Whether the session's families need the background check (FamilySync.familyWork): asked for
     * within the hour, or let go of.
     */
    static func wanted(_ wanted: Bool, session: SharedKeychain.Session) {
        if wanted {
            schedule(after: hour, session: session)
        } else if UserDefaults.standard.string(forKey: sessionKey) == session.tag {
            cancel()
        }
    }

    /* A walk found due, or one that stopped: the check asked for soon, waiting longer after each stop. */
    static func soon(session: SharedKeychain.Session) {
        let attempts = UserDefaults.standard.integer(forKey: attemptsKey)
        schedule(after: min(10 * 60, 30 * pow(2, Double(attempts))), session: session)
    }

    /* Signed out, or another account signed in: nothing of the last session's check runs. */
    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        UserDefaults.standard.removeObject(forKey: sessionKey)
        UserDefaults.standard.removeObject(forKey: attemptsKey)
    }

    private static func schedule(after delay: TimeInterval, session: SharedKeychain.Session) {
        UserDefaults.standard.set(session.tag, forKey: sessionKey)
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: delay)
        // One request per identifier: this replaces any earlier one.
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handle(_ task: BGTask) {
        let stop = StopSwitch()
        task.expirationHandler = { stop.flip() }
        Task { @MainActor in
            log.notice("family check started")
            let (pass, session) = await run(stop: stop)
            log.notice("family check ended: \(String(describing: pass), privacy: .public)")
            switch pass {
            case .retry, .stopped:
                if let session {
                    UserDefaults.standard.set(UserDefaults.standard.integer(forKey: attemptsKey) + 1, forKey: attemptsKey)
                    soon(session: session)
                }
            case .done:
                UserDefaults.standard.removeObject(forKey: attemptsKey)
                // Still wanted unless the pass let it go (no family, nothing unsettled).
                if let session, UserDefaults.standard.string(forKey: sessionKey) == session.tag { schedule(after: hour, session: session) }
            case .signedOut:
                break
            }
            task.setTaskCompleted(success: pass == .done)
        }
    }

    /* One pass for the session the check was asked for, through its own vault; nothing for any other. */
    private static func run(stop: StopSwitch) async -> (FamilyWalkPass, SharedKeychain.Session?) {
        guard let session = SharedKeychain.session, UserDefaults.standard.string(forKey: sessionKey) == session.tag,
              let vault = Vault.fromKeychain(), let sync = FamilySync.shared(for: vault) else { return (.signedOut, nil) }
        sync.familyWork.set { wanted in Task { @MainActor in FamilyWalkTasks.wanted(wanted, session: session) } }
        // Asked before every step: the vault still open, and still the keychain's session.
        let current: @Sendable () -> Bool = { vault.copySession.stands && SharedKeychain.session?.tag == session.tag }
        let pass = await sync.backgroundPass(current: current) { if stop.flipped { throw FamilyWalkStopped() } }
        return (pass, session)
    }
}

/* Flipped by the task's expiration handler; read by the pass between steps. */
final class StopSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var on = false
    func flip() { lock.withLock { on = true } }
    var flipped: Bool { lock.withLock { on } }
}
