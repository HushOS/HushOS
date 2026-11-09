import HushOSKit
import UserNotifications

/*
 * The Notification Service Extension (docs/devices-design.md 5): every push from the relay is an
 * alert saying "New activity in HushOS" with `mutable-content`, carrying an event id and a tag.
 * Here the tag is checked against this phone's registration, the event is fetched over the
 * signed-in session, and the notice is written in the core's words (PushNotifications.notice).
 *
 * The text in the relay's payload is never what is shown: it is overwritten with the fixed
 * fallback first, and the fallback stays on any failure and when time runs out, so a ping is
 * always seen and never silent. iOS gives an extension about 30 seconds and about 24 MB; the fetch
 * has its own timeout well inside that, and a sharer's name comes from the small list the app keeps
 * (PushContactNames), never from opening the settings document here.
 */
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let content = UNMutableNotificationContent()
        NotificationService.write(pushNoticeFallback(), into: content)
        lock.withLock {
            handler = contentHandler
            self.content = content
        }
        let info = request.content.userInfo
        work = Task { [weak self] in
            let notice = await PushNotifications.notice(for: info)
            self?.finish(with: notice)
        }
    }

    /* Out of time: the fallback, as it stands. */
    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        finish(with: nil)
    }

    private func finish(with notice: PushNotice?) {
        let delivery: (((UNNotificationContent) -> Void), UNMutableNotificationContent)? = lock.withLock {
            guard let handler, let content else { return nil }
            self.handler = nil
            self.content = nil
            return (handler, content)
        }
        guard let (handler, content) = delivery else { return }
        if let notice { NotificationService.write(notice, into: content) }
        handler(content)
    }

    static func write(_ notice: PushNotice, into content: UNMutableNotificationContent) {
        PushNotifications.write(notice, into: content)
    }
}
