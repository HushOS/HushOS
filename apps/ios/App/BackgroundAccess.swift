import ActivityKit
import Observation
import SwiftUI
import UIKit
import UserNotifications

/*
 * What iOS lets HushOS do while you're away from it. The app can't turn any of it on;
 * it can only see what is off, say so once when a transfer starts, and open Settings.
 * Notifications matter only when Live Activities are off (TransferNotices): then the
 * same sheet asks for them, once, as it opens.
 */
@Observable
@MainActor
final class BackgroundAccess {
    static let shared = BackgroundAccess()

    /* The question on screen, when a transfer has just started and something is off. */
    var asking = false
    /* Bumped when the app comes back from Settings, so the Account lines redraw. */
    var version = 0

    private static let notNowKey = "background.notNow"
    private static let week: TimeInterval = 7 * 24 * 3600

    var refreshOff: Bool { _ = version; return UIApplication.shared.backgroundRefreshStatus != .available }
    var refreshRestricted: Bool { _ = version; return UIApplication.shared.backgroundRefreshStatus == .restricted }
    var lowPower: Bool { _ = version; return ProcessInfo.processInfo.isLowPowerModeEnabled }
    var activitiesOff: Bool { _ = version; return !ActivityAuthorizationInfo().areActivitiesEnabled }
    /* Read from iOS when the app comes forward; .notDetermined until then. */
    private(set) var notifications: UNAuthorizationStatus = .notDetermined
    var notificationsOff: Bool { notifications == .denied }
    var anythingOff: Bool { refreshOff || lowPower || activitiesOff }
    /* Settings › HushOS can turn these back on; Low Power Mode and a phone-wide restriction live elsewhere. */
    var settingsHelps: Bool { (refreshOff && !refreshRestricted && !lowPower) || activitiesOff }

    func readNotifications() async {
        notifications = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /* The sheet is up and Live Activities are off: iOS's own question, which it asks only once. */
    func askForNotifications() async {
        guard activitiesOff else { return }
        await readNotifications()
        guard notifications == .notDetermined else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        await readNotifications()
    }

    /* A transfer started: ask once, and after Not now, not again for a week. */
    func transferStarted() {
        guard anythingOff, !asking, !queued else { return }
        if let last = UserDefaults.standard.object(forKey: Self.notNowKey) as? Date, Date().timeIntervalSince(last) < Self.week { return }
        // A transfer starts as the picker that chose it closes, and SwiftUI drops a sheet asked
        // for while another is still going away: ask once it has gone.
        queued = true
        Task {
            try? await Task.sleep(for: .milliseconds(800))
            queued = false
            asking = true
        }
    }

    @ObservationIgnored private var queued = false

    func notNow() {
        UserDefaults.standard.set(Date(), forKey: Self.notNowKey)
        asking = false
    }

    func openSettings() {
        asking = false
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    /* The sheet's words, for what is off now. */
    var title: String {
        refreshOff || lowPower ? "Let HushOS finish transfers in the background" : "Show transfers on the Lock Screen"
    }

    var message: String {
        var lines: [String] = []
        /* Low Power Mode also reports refresh as off, so name the cause people can see. */
        if lowPower {
            lines.append("Low Power Mode is on, so transfers can’t finish while you’re away from HushOS until it’s off.")
        } else if refreshRestricted {
            lines.append("Background App Refresh is turned off on this iPhone, so transfers can’t finish while you’re away from HushOS.")
        } else if refreshOff {
            lines.append("Background App Refresh is off for HushOS, so transfers can’t finish while you’re away from the app.")
        }
        if activitiesOff {
            lines.append("Live Activities are off for HushOS, so progress doesn’t show on the Lock Screen.")
            if notificationsOff { lines.append("Notifications are off too, so you won’t hear when transfers end.") }
        }
        return lines.joined(separator: " ")
    }
}

/* The short sheet: what is off, why it matters now, Open Settings or Not now. */
struct BackgroundAccessSheet: View {
    @State private var access = BackgroundAccess.shared

    var body: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            Text(access.title).font(Theme.Text.headline).foregroundStyle(Alpine.ink).accessibilityAddTraits(.isHeader)
            Text(access.message).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Alpine.Space.s2) {
                if access.settingsHelps {
                    Button { access.notNow() } label: { Text("Not now").frame(maxWidth: .infinity) }.buttonStyle(SecondaryCapsuleStyle())
                    Button { access.openSettings() } label: { Text("Open Settings").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                } else {
                    Button { access.notNow() } label: { Text("OK").frame(maxWidth: .infinity) }.buttonStyle(PrimaryCapsuleStyle())
                }
            }
            .padding(.top, Alpine.Space.s1)
        }
        .padding(.horizontal, Alpine.Space.s6).padding(.top, Alpine.Space.s6).padding(.bottom, Alpine.Space.s4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Alpine.ground)
        .presentationDetents([.height(250)])
        .interactiveDismissDisabled(false)
        // With Live Activities off, a notification is how a transfer's end reaches the Lock Screen.
        .task { await access.askForNotifications() }
    }
}

/* Account › Advanced: each setting's state, quietly, with Open Settings when one is off. */
struct BackgroundAccessSection: View {
    @State private var access = BackgroundAccess.shared

    var body: some View {
        Section {
            line("Background App Refresh", on: !access.refreshOff)
            if access.lowPower {
                HStack {
                    Text("Low Power Mode").foregroundStyle(Alpine.ink)
                    Spacer()
                    Text("On · pauses refresh").foregroundStyle(Alpine.inkMuted)
                }
                .alpineRow()
            }
            line("Live Activities", on: !access.activitiesOff)
            // Only then does HushOS notify, when transfers end while it's in the background.
            if access.activitiesOff { line("Notifications", on: access.notifications == .authorized || access.notifications == .provisional) }
            if access.settingsHelps {
                Button("Open Settings") { access.openSettings() }.foregroundStyle(Alpine.primary).alpineRow()
            }
        } header: {
            Text("While you’re away").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
        } footer: {
            Text("Uploads and kept files finish while HushOS is in the background when these are on.")
        }
    }

    private func line(_ title: String, on: Bool) -> some View {
        HStack {
            Text(title).foregroundStyle(Alpine.ink)
            Spacer()
            Text(on ? "On" : "Off").foregroundStyle(on ? Alpine.inkMuted : Alpine.danger)
        }
        .alpineRow()
        .accessibilityElement(children: .combine)
    }
}
