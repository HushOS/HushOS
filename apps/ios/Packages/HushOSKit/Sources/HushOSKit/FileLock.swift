import Foundation

/*
 * An exclusive `flock` on a lock file in the app group, shared by every file the app and its
 * extensions read-modify-write there (the rollback marks, the family device records). Held only
 * while the system has promised not to suspend the process, and never waited on without end.
 */
enum FileLock {
    /* Whether the system is asked for time to write: `expired` is a process it refuses (tests). */
    enum Activity: Sendable { case system, expired }

    /*
     * The lock, never waited on without end: a process parked behind another's lock is one
     * the system may suspend there. Tried for about a second when there is time, once when not.
     */
    static func take(_ lock: Int32, wait: Bool) -> Bool {
        var tries = wait ? 100 : 1
        while true {
            if flock(lock, LOCK_EX | LOCK_NB) == 0 { return true }
            if errno == EINTR { continue }
            tries -= 1
            guard errno == EWOULDBLOCK, tries > 0 else { return false }
            usleep(10_000)
        }
    }

    /*
     * Runs `work` (which takes the lock) while the system has promised not to suspend this
     * process, and tells it so: the lock file is in the app group's container, and a process
     * suspended holding a lock there is killed (0xdead10cc). The app, the Files extension, the
     * sign-in sheet, the share extension and the widget all link this, so it is
     * `performExpiringActivity`, which extensions have too (UIApplication's background task is
     * the app's alone). Its block runs on another queue and holds the assertion until it
     * returns: it waits there while `work` runs here. When the system grants none (the block is
     * told `expired` first) or doesn't answer in two seconds, `work` tries the lock once, without
     * waiting; a raise not written then stays pending. Callers are on the vault's actor, never
     * the main thread.
     */
    static func whileRunning(_ activity: Activity, _ work: (_ granted: Bool) -> Void) {
        if activity == .expired { return work(false) }
        #if os(iOS)
        let granted = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let answer = ActivityAnswer()
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Saving a record on this device") { expired in
            // The second call (expiring while the write runs) changes nothing: the write takes milliseconds.
            guard answer.first(expired: expired) else { return }
            granted.signal()
            if !expired { finished.wait() }
        }
        defer { finished.signal() }
        work(granted.wait(timeout: .now() + 2) == .success && answer.mayRun)
        #else
        work(true)
        #endif
    }

    /*
     * Runs `body` holding the lock at `path` (made if missing), within the activity above; false
     * when the lock could not be had, and `body` did not run.
     */
    @discardableResult
    static func withLock(_ path: String, activity: Activity = .system, _ body: () -> Void) -> Bool {
        var ran = false
        whileRunning(activity) { granted in
            let lock = open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard lock >= 0 else { return }
            defer { close(lock) }
            guard take(lock, wait: granted) else { return }
            defer { flock(lock, LOCK_UN) }
            body()
            ran = true
        }
        return ran
    }
}

#if os(iOS)
/* The expiring activity's first answer: whether the process may run until the block returns. */
private final class ActivityAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var answered = false
    private var expired = true

    /* True for the first call only, which records whether it came expired. */
    func first(expired: Bool) -> Bool {
        lock.withLock {
            guard !answered else { return false }
            answered = true
            self.expired = expired
            return true
        }
    }

    var mayRun: Bool { lock.withLock { answered && !expired } }
}
#endif
