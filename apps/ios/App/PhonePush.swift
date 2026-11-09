import HushOSKit
import Observation
import SwiftUI
import UIKit
import UserNotifications

/*
 * Notifications on this iPhone, the app's side (PushNotifications in HushOSKit holds the rest):
 * asking iOS for the APNs token, handing it on when Account's "On this phone" is turned on and at
 * every signed-in start (a token iOS replaced is registered again), and where a tapped notice goes.
 * iOS asks the person's permission only from that switch, never on its own.
 */
@MainActor
@Observable
final class PhonePush {
    static let shared = PhonePush()

    /* What a tapped notice opens, set by TransferNotices' delegate; the drive opens it and clears it. */
    enum Target: String { case devices, shared, families, app }
    var opening: Target?

    @ObservationIgnored private var waiting: [CheckedContinuation<Data, Error>] = []
    /* Which request a timeout belongs to: an earlier one's never fails a later request. */
    @ObservationIgnored private var round = 0
    @ObservationIgnored private var catchingUp = false

    struct RegistrationFailed: Error {}

    /* The APNs token, from AppDelegate. */
    func received(_ token: Data) {
        let all = waiting
        waiting = []
        for continuation in all { continuation.resume(returning: token) }
    }

    func failed(_ error: Error) {
        let all = waiting
        waiting = []
        for continuation in all { continuation.resume(throwing: error) }
    }

    /*
     * Asks iOS to register; it answers through AppDelegate, with the same token until it replaces it.
     * An answer that never comes (no network to Apple) fails after 30 seconds, so the switch is never
     * left waiting.
     */
    private func token() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            guard waiting.count == 1 else { return }
            round += 1
            let this = round
            UIApplication.shared.registerForRemoteNotifications()
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(30))
                guard let self, self.round == this else { return }
                self.failed(RegistrationFailed())
            }
        }
    }

    static var authorized: Bool {
        get async {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            return status == .authorized || status == .provisional || status == .ephemeral
        }
    }

    /* Whether "On this phone" is on: this account's registration is kept and iOS still lets HushOS notify. */
    func on() async -> Bool {
        guard let session = SharedKeychain.session, PushNotifications.registration?.belongs(to: session) == true else { return false }
        return await Self.authorized
    }

    /* The switch turned on: iOS's permission (asked here only), the token, then the relay and the server. */
    func turnOn(relay: String) async throws {
        let center = UNUserNotificationCenter.current()
        if await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
        guard await Self.authorized else {
            throw PushNotifications.PushError.refused("Notifications are off for HushOS. Turn them on in Settings, then try again.")
        }
        let token: Data
        do {
            token = try await self.token()
        } catch {
            throw PushNotifications.PushError.refused("This iPhone couldn’t sign up for notifications. Try again later.")
        }
        try await PushNotifications.register(token: token, relay: relay)
        // The names a notice may give a sharer, kept for the extension from the settings read afresh.
        if let vault = Vault.fromKeychain() { await vault.rememberPushContacts() }
    }

    func turnOff() async throws {
        try await PushNotifications.turnOff()
    }

    /*
     * At every signed-in start, for an account that turned notifications on here: the token again
     * (iOS may have replaced it), sent on, and the kept handle given to the server again, as the web
     * renews its subscription. A server that turned them off or names no relay leaves it as it is.
     */
    func refresh() async {
        guard PushNotifications.available, let session = SharedKeychain.session, PushNotifications.registration?.belongs(to: session) == true,
              await Self.authorized,
              // A server naming no relay now, or another one, has the registration let go of here (serverState).
              let state = try? await PushNotifications.serverState(), let relay = state.relay,
              let token = try? await token()
        else { return }
        try? await PushNotifications.register(token: token, relay: relay)
    }

    /* At every start: handles still waiting to be deleted at their relay, signed in or not. */
    func started() {
        Task { await PushNotifications.retryDeletions() }
    }

    /*
     * Signed in and on screen (a start, or back from the background): what the server holds that no
     * push showed, posted as notices in the same words, one per event (its id is the request's).
     * Listing also answers the device's open ping, so later events aren't held back as coalesced.
     */
    func catchUp() async {
        // A start and coming on screen ask at once: one catch-up at a time.
        guard !catchingUp else { return }
        catchingUp = true
        defer { catchingUp = false }
        guard await Self.authorized else { return }
        let center = UNUserNotificationCenter.current()
        for pending in await PushNotifications.catchUp() {
            let content = UNMutableNotificationContent()
            PushNotifications.write(pending.notice, into: content)
            try? await center.add(UNNotificationRequest(identifier: "push-" + pending.id, content: content, trigger: nil))
        }
    }

    /* A tapped notice, from the notification centre's delegate. */
    func tapped(_ open: String) {
        opening = Target(rawValue: open) ?? .app
    }
}

/*
 * Account → Notifications, the web's AccountNotifications: whether this iPhone gets them, and the
 * two kinds a person can turn off. Security notices always come. Hidden on a server with
 * notifications off, or one whose pushes can't reach this app (no relay, or not HushOS's). The
 * state lives here and Account loads it (a section that draws nothing never runs its own task).
 */
@MainActor
@Observable
final class NotificationSettings {
    /* nil while loading and on a server where the section doesn't apply. */
    var toggles: PushNotifications.Toggles?
    var relay: String?
    var phone = false
    var busy = false
    var problem: String?

    func load() async {
        // A sideloaded build can't get pushes (its profile grants no aps-environment): nothing to show.
        guard PushNotifications.available else {
            toggles = nil
            relay = nil
            return
        }
        do {
            guard let state = try await PushNotifications.serverState(), state.relay != nil else {
                toggles = nil
                relay = nil
                return
            }
            relay = state.relay
            toggles = state.toggles
            phone = await PhonePush.shared.on()
        } catch {
            // Kept as last read; a first read that fails leaves the section out, as on a server without them.
        }
    }

    func setPhone(_ on: Bool) async {
        guard !busy, let relay else { return }
        busy = true
        problem = nil
        phone = on
        defer { busy = false }
        do {
            if on { try await PhonePush.shared.turnOn(relay: relay) } else { try await PhonePush.shared.turnOff() }
        } catch {
            problem = ErrorWords.say(error, otherwise: "Please try again.")
        }
        phone = await PhonePush.shared.on()
    }

    func set(_ key: WritableKeyPath<PushNotifications.Toggles, Bool>, _ on: Bool) async {
        guard let before = toggles else { return }
        var next = before
        next[keyPath: key] = on
        toggles = next
        problem = nil
        do {
            toggles = try await PushNotifications.save(next)
        } catch {
            toggles = before
            problem = "Your notification settings weren’t saved. Please try again."
        }
    }
}

struct NotificationsSection: View {
    let model: NotificationSettings

    var body: some View {
        if let toggles = model.toggles, model.relay != nil {
            Section {
                Toggle(isOn: Binding(get: { model.phone }, set: { on in Task { await model.setPhone(on) } })) {
                    label("On this phone", "Notices here while HushOS is closed")
                }
                .disabled(model.busy)
                .tint(Alpine.primary)
                .alpineRow()
                Toggle(isOn: Binding(get: { toggles.shared }, set: { on in Task { await model.set(\.shared, on) } })) {
                    label("Shared with you", "When someone shares something with you")
                }
                .tint(Alpine.primary)
                .alpineRow()
                Toggle(isOn: Binding(get: { toggles.family }, set: { on in Task { await model.set(\.family, on) } })) {
                    label("Families", "Invitations, and people waiting to join your family")
                }
                .tint(Alpine.primary)
                .alpineRow()
            } header: {
                SectionTitle("Notifications")
            } footer: {
                if let problem = model.problem { Text(problem).foregroundStyle(Alpine.danger) }
            }
        }
    }

    private func label(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).foregroundStyle(Alpine.ink)
            Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
        }
    }
}
