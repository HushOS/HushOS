#if canImport(UserNotifications)
import UserNotifications

extension PushNotifications {
    /* The category every push notice carries: its hidden-preview placeholder is the fallback text (TransferNotices.start). */
    public static let category = "push"

    /*
     * A notice into notification content, the same for the Notification Service Extension and the
     * app's catch-up: its words, its thread, what a tap opens (`push` in userInfo, PhonePush.tapped)
     * and the push category. Written notices sound; the fallback stays quiet, as the relay sent it.
     */
    public static func write(_ notice: PushNotice, into content: UNMutableNotificationContent) {
        content.title = notice.title
        content.body = notice.body
        content.categoryIdentifier = category
        switch notice.channel {
        case .security: content.threadIdentifier = "security"
        case .shared: content.threadIdentifier = "shared"
        case .families: content.threadIdentifier = "families"
        case .other: content.threadIdentifier = "push"
        }
        let open: String
        switch notice.open {
        case .devices: open = "devices"
        case .shared: open = "shared"
        case .families: open = "families"
        case .app: open = "app"
        }
        content.userInfo = ["push": open]
        content.sound = notice.channel == .other ? nil : .default
    }
}
#endif
