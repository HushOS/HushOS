import ActivityKit
import Foundation
import HushOSKit
import Observation
import UIKit
import UserNotifications

/*
 * One notification when transfers end while you're away from HushOS and nothing else
 * would tell you: only with the app in the background, and only when Live Activities
 * are off or unavailable (otherwise the Lock Screen already shows how they ended).
 * It goes out once the queue has nothing left running, not once per file, in Android's
 * words. A failure opens the transfers list, where its row waits, and carries Retry when
 * a retry can help; a finished summary opens where the files are (finished rows leave the
 * list moments after the queue empties): the folder the uploads went to, On this phone
 * for kept files, or Files.
 */
@MainActor
@Observable
final class TransferNotices: NSObject, UNUserNotificationCenterDelegate {
    static let shared = TransferNotices()

    enum Target: Equatable {
        case transfers
        /* nil: the top of Files. */
        case folder(String?)
        case phone
    }

    /* Set by a tap on the notification; the drive opens it and clears it. */
    var opening: Target?

    struct Outcome: Equatable {
        /* The transfer, or for a file of a kept folder the folder, which counts once as its row does. */
        let key: String
        let name: String
        let upload: Bool
        /* Why it didn't finish; nil when it did. */
        let reason: String?
        /* Where an upload went, so a tap can open it. */
        var folder: String?
        /* The queued transfers behind it that Retry could send again. */
        var retryable: [UUID] = []
    }

    @ObservationIgnored private var outcomes: [Outcome] = []
    private static let failedCategory = "transfers-failed"
    private static let retryAction = "retry"

    /* Before launch finishes, so a tap that launched the app is delivered. */
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let retry = UNNotificationAction(identifier: Self.retryAction, title: "Retry", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.failedCategory, actions: [retry], intentIdentifiers: [])])
    }

    /* A transfer ended. Only what ends off screen counts: on screen, the list says it. */
    func ended(_ outcome: Outcome) {
        guard UIApplication.shared.applicationState != .active else { outcomes = []; return }
        if let index = outcomes.firstIndex(where: { $0.key == outcome.key }) {
            // A kept folder: one file failing makes the folder's line a failure.
            if outcome.reason != nil {
                var merged = outcome
                merged.retryable = outcomes[index].retryable + outcome.retryable
                outcomes[index] = merged
            }
            return
        }
        outcomes.append(outcome)
    }

    /* Nothing is left running: say how it went, if this is the only way the person would hear. */
    func queueDrained() async {
        let ended = outcomes
        outcomes = []
        guard !ended.isEmpty, UIApplication.shared.applicationState != .active,
              !ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        guard status == .authorized || status == .provisional else { return }
        let words = Self.words(ended)
        let content = UNMutableNotificationContent()
        content.title = words.title
        if let body = words.body { content.body = body }
        content.threadIdentifier = "transfers"
        content.userInfo = ["target": Self.encode(Self.target(ended))]
        let retryable = ended.flatMap(\.retryable)
        if !retryable.isEmpty {
            content.categoryIdentifier = Self.failedCategory
            content.userInfo["retry"] = retryable.map(\.uuidString)
        }
        try? await center.add(UNNotificationRequest(identifier: "transfers-" + UUID().uuidString, content: content, trigger: nil))
    }

    /* Sign-out and account wipe: what was gathered, and any summary still naming the account's files. */
    func clear() {
        outcomes = []
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    /*
     * Android's words. Finished: "3 files uploaded" naming them, or "“Lisbon” is on this phone";
     * didn't: "1 upload didn’t finish" with the file and its reason. Mixed or several keeps use
     * the transfers bar's own words.
     */
    static func words(_ ended: [Outcome]) -> (title: String, body: String?) {
        let failed = ended.filter { $0.reason != nil }
        if failed.count == 1, let only = failed.first, let reason = only.reason {
            return (only.upload ? "1 upload didn’t finish" : "1 transfer didn’t finish", "“\(only.name)”: \(reason)")
        }
        if !failed.isEmpty {
            return ("\(failed.count) \(failed.allSatisfy(\.upload) ? "uploads" : "transfers") didn’t finish", names(failed))
        }
        if ended.allSatisfy(\.upload) { return ("\(ended.count) \(ended.count == 1 ? "file" : "files") uploaded", names(ended)) }
        if ended.count == 1 { return ("“\(ended[0].name)” is on this phone", nil) }
        return ("\(ended.count) transfers finished", names(ended))
    }

    /* Where a tap goes, as on Android. */
    static func target(_ ended: [Outcome]) -> Target {
        if ended.contains(where: { $0.reason != nil }) { return .transfers }
        let folders = Set(ended.map(\.folder))
        if ended.allSatisfy(\.upload), folders.count == 1, let folder = folders.first, let folder { return .folder(folder) }
        if ended.allSatisfy({ !$0.upload }) { return .phone }
        return .folder(nil)
    }

    /* “a”, “a” and “b”, or “a”, “b” and 3 more. */
    private static func names(_ outcomes: [Outcome]) -> String {
        let quoted = outcomes.map { "“\($0.name)”" }
        switch quoted.count {
        case 1: return quoted[0]
        case 2: return "\(quoted[0]) and \(quoted[1])"
        default: return "\(quoted[0]), \(quoted[1]) and \(quoted.count - 2) more"
        }
    }

    private static func encode(_ target: Target) -> String {
        switch target {
        case .transfers: "transfers"
        case let .folder(id): "folder:" + (id ?? "")
        case .phone: "phone"
        }
    }

    private static func decode(_ text: String?) -> Target {
        guard let text else { return .transfers }
        if text == "phone" { return .phone }
        if text.hasPrefix("folder:") {
            let id = String(text.dropFirst("folder:".count))
            return .folder(id.isEmpty ? nil : id)
        }
        return .transfers
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        let target = info["target"] as? String
        let retry = (info["retry"] as? [String] ?? []).compactMap(UUID.init(uuidString:))
        await MainActor.run {
            if action == Self.retryAction {
                for id in retry { BackgroundTransfers.shared.retry(id) }
            } else if action == UNNotificationDefaultActionIdentifier {
                opening = Self.decode(target)
            }
        }
    }

    /* On screen the list already shows it; nothing is posted then anyway, so show nothing. */
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions { [] }
}
