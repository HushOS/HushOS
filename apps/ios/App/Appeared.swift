import SwiftUI
import UIKit

/*
 * UIKit's viewDidAppear for the screen this sits in: the moment the screen's own appearing has
 * finished, a tab's included. A link pushes onto a tab's stack only from then on: pushed while the
 * tab was still appearing (a link from another tab, a notification, a cold launch), the pushed
 * screen's bar was laid out before the tab had its safe area and was drawn over the status bar.
 */
struct AppearedSignal: UIViewControllerRepresentable {
    let appeared: () -> Void

    func makeUIViewController(context: Context) -> Controller { Controller(appeared: appeared) }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.appeared = appeared }

    final class Controller: UIViewController {
        var appeared: () -> Void

        init(appeared: @escaping () -> Void) {
            self.appeared = appeared
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { nil }

        override func loadView() {
            view = UIView()
            view.isUserInteractionEnabled = false
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            appeared()
        }
    }
}

extension View {
    /* Runs once this screen has finished appearing, each time it does. */
    func onFinishedAppearing(_ action: @escaping () -> Void) -> some View {
        background { AppearedSignal(appeared: action).frame(width: 0, height: 0).accessibilityHidden(true) }
    }
}
