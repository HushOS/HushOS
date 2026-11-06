import SwiftUI

extension View {
    /*
     * A secure field's characters drawn over it while revealed: the field stays underneath (and
     * stays the one typed into), only its dots are hidden. Not hit-testable, so a tap still lands
     * on the field. The field is faded rather than hidden: UIKit stops delivering touches to a
     * view below 1% alpha. Faded, its caret is gone too, so a drawn one stands in while it has
     * focus. The overlay is the row's colour across the whole field: at 1% the field's dots,
     * wider than the letters, still showed past the end of the text. Every revealed field sits
     * on an Alpine.surface row. Used by the app and by the Files sign-in sheet (FilesUI compiles
     * this file).
     */
    func revealed(_ value: String?, placeholder: String, focused: Bool) -> some View {
        opacity(value == nil ? 1 : 0.011)
            .overlay(alignment: .leading) {
                if let value {
                    HStack(spacing: 1) {
                        // Before the placeholder when empty, after the last character otherwise: typing only
                        // adds at the end, unless the caret is moved with the space bar, which this can't follow.
                        if focused, value.isEmpty { RevealCaret(restart: value) }
                        Text(value.isEmpty ? placeholder : value)
                            .foregroundStyle(value.isEmpty ? Alpine.inkMuted : Alpine.ink)
                            .lineLimit(1).truncationMode(.head)
                            .privacySensitive()
                        if focused, !value.isEmpty { RevealCaret(restart: value) }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .background(Alpine.surface)
                    .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
    }
}

/* The caret the faded field can't show: the tint colour, blinking as UIKit's does, solid again after each keystroke. */
private struct RevealCaret: View {
    let restart: String
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 22

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            Capsule().fill(.tint).frame(width: 2, height: height)
                .opacity(Int(context.date.timeIntervalSinceReferenceDate * 2).isMultiple(of: 2) ? 1 : 0)
        }
        .id(restart)
    }
}
