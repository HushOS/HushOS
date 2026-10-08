import HushOSKit
import SwiftUI
import UIKit

/* The extension's principal class: the SwiftUI sheet over what the other app shared. */
final class ShareViewController: UIViewController {
    private let model = SaveModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        Theme.configureAppearance()
        let host = UIHostingController(rootView: SaveView(model: model) { [weak self] in self?.finish() })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        // Saved: the sheet goes, the uploads carry on in the background session.
        model.saved = { [weak self] in self?.finish() }
        Task { await model.open(items) }
    }

    private func finish() {
        model.close()
        extensionContext?.completeRequest(returningItems: nil)
    }
}
