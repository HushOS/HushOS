import Observation
import SwiftUI
import UIKit

/*
 * Notices ("Moved 2 items to Trash · Undo", "Link copied") in a window of their
 * own above the app's, so a sheet in front never hides the feedback for what was
 * just done in it. The window lets every touch outside the notice through.
 */
@Observable
@MainActor
final class NoticeCenter {
    static let shared = NoticeCenter()

    struct Notice: Identifiable {
        let id = UUID()
        let text: String
        let undo: (() -> Void)?
        /* The action's word: "Undo" unless the notice offers something else ("Send a copy"). */
        var actionLabel = "Undo"
        /* Something changed that the person didn't do: it stays longer and has an OK. */
        var important = false
    }

    private(set) var current: Notice?
    /* How far above the bottom edge: clear of the tab bar, and of the transfers bar while it shows. */
    var bottom: CGFloat = 76
    /* Bars a screen adds above the tab bar (Paste, the selection toolbar), by screen: notices sit above them too. */
    var bars: [String: CGFloat] = [:]
    var lift: CGFloat { bars.values.max() ?? 0 }

    func show(_ text: String, undo: (() -> Void)? = nil, actionLabel: String = "Undo", important: Bool = false) {
        let notice = Notice(text: text, undo: undo, actionLabel: actionLabel, important: important)
        withAnimation(.snappy) { current = notice }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(important ? 8 : undo == nil ? 4 : 6))
            if current?.id == notice.id { withAnimation(.snappy) { current = nil } }
        }
    }

    func dismiss() { withAnimation(.snappy) { current = nil } }
}

@MainActor
enum NoticeWindow {
    private static var window: UIWindow?

    static func install() {
        guard window == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let window = PassThroughWindow(windowScene: scene)
        let host = UIHostingController(rootView: NoticeLayer())
        host.view.backgroundColor = .clear
        window.rootViewController = host
        // Above sheets and alerts the app presents; below the keyboard and system alerts.
        window.windowLevel = .alert + 1
        window.isHidden = false
        self.window = window
    }
}

/* Touches land on the notice; everywhere else they fall through to the app below. */
private final class PassThroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event) else { return nil }
        return hit == rootViewController?.view ? nil : hit
    }
}

private struct NoticeLayer: View {
    @State private var center = NoticeCenter.shared

    var body: some View {
        VStack {
            Spacer()
            if let notice = center.current {
                NoticeBar(notice: notice) { center.dismiss() }
                    .padding(.bottom, center.bottom + center.lift)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.keyboard)
    }
}

/* "Moved 2 items to Trash · Undo", for a few seconds: the snackbar capsule, its action a real button. */
struct NoticeBar: View {
    let notice: NoticeCenter.Notice
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(notice.text).font(Theme.Text.callout).foregroundStyle(Alpine.onSnackbar).lineLimit(3)
            Spacer(minLength: 8)
            if let undo = notice.undo {
                Button(notice.actionLabel) { dismiss(); undo() }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.snackbarAction)
                    .buttonStyle(.plain).frame(minHeight: 36)
            } else if notice.important {
                Button("OK") { dismiss() }
                    .font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.snackbarAction)
                    .buttonStyle(.plain).frame(minHeight: 36)
            }
        }
        .padding(.leading, 20).padding(.trailing, 14).padding(.vertical, 10)
        .frame(minHeight: 48)
        .frame(maxWidth: 370)
        .background(Alpine.snackbar, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .alpineRaised(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal)
        .accessibilityElement(children: .contain)
    }
}
