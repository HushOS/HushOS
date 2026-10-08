import ActivityKit
import HushOSKit
import SwiftUI
import WidgetKit

@main
struct HushOSWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TransferLiveActivity()
    }
}

/*
 * Transfers on the Lock Screen and in the Dynamic Island (DESIGN.md):
 * the app's headline, the file and count under it, the percentage, Done or the count
 * on the right, a bar coloured by how it went. The island is black in every scheme.
 */
struct TransferLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TransferAttributes.self) { context in
            LockScreenTransfer(context: context)
        } dynamicIsland: { context in
            let island = Palette.island
            return DynamicIsland {
                /*
                 * One row under the camera, so nothing floats between regions: the logo centred
                 * against the words, the percent on the title's baseline, then the bar, inset
                 * well inside the island's curve so its ends are never clipped.
                 */
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 12) {
                        HStack(alignment: .center, spacing: 12) {
                            AppMark(size: 40)
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                TransferWords(state: context.state, palette: island)
                                Spacer(minLength: 4)
                                TransferTrailing(context: context, palette: island)
                            }
                        }
                        TransferBar(state: context.state, palette: island)
                    }
                    .padding(.horizontal, 14)
                }
            } compactLeading: {
                TransferSymbol.image(context).foregroundStyle(.white)
            } compactTrailing: {
                if context.state.done {
                    Text(context.state.failed ? context.state.count : "Done").font(.caption.weight(.semibold))
                } else {
                    ProgressView(value: context.state.fraction).progressViewStyle(.circular).tint(.white).frame(width: 20, height: 20)
                }
            } minimal: {
                if context.state.done {
                    TransferSymbol.image(context).foregroundStyle(.white)
                } else {
                    ProgressView(value: context.state.fraction).progressViewStyle(.circular).tint(.white)
                }
            }
            /*
             * The block sits centred: the row starts just under the camera (no margin added
             * above it), and the space under the bar matches the space the camera leaves above
             * the row, about 36 points, so the gaps read equal.
             */
            .contentMargins(.top, 0, for: .expanded)
            .contentMargins(.bottom, 36, for: .expanded)
        }
    }
}

/*
 * The Lock Screen card. Its colours are picked here from the scheme and contrast setting
 * rather than left to resolve on their own, so the card, the text and the system's
 * Allow area always agree: a solid surface card in light and in dark.
 */
private struct LockScreenTransfer: View {
    let context: ActivityViewContext<TransferAttributes>
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let palette = Palette(scheme: scheme, high: contrast == .increased)
        VStack(spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                AppMark(size: 36)
                TransferWords(state: context.state, palette: palette)
                Spacer(minLength: 4)
                TransferTrailing(context: context, palette: palette)
            }
            TransferBar(state: context.state, palette: palette)
        }
        .padding(16)
        .activityBackgroundTint(palette.surface)
        .activitySystemActionForegroundColor(palette.primary)
    }
}

/* Alpine's colours as plain values, one set per scheme and contrast; the island is always dark. */
private struct Palette {
    let surface, ink, muted, primary, success, danger, track: Color

    init(scheme: ColorScheme, high: Bool) {
        if scheme == .dark {
            surface = hex(high ? 0x0A0D16 : 0x161A26); ink = hex(high ? 0xFFFFFF : 0xE4E8F4); muted = hex(high ? 0xD3D9EA : 0x9AA3BE)
            primary = hex(high ? 0xC9D3FF : 0xAAB8F4); success = hex(high ? 0xA3EBC8 : 0x7FD1AD); danger = hex(high ? 0xFFB8B0 : 0xF2A69F)
            track = hex(high ? 0x8D95AF : 0x262B3A)
        } else {
            surface = hex(0xFFFFFF); ink = hex(high ? 0x070B18 : 0x17203A); muted = hex(high ? 0x2E3650 : 0x5A6380)
            primary = hex(high ? 0x1A2C6B : 0x2C428E); success = hex(high ? 0x0C4A30 : 0x24704F); danger = hex(high ? 0x7E120C : 0xB3261E)
            track = hex(high ? 0x5F6886 : 0xE2E5EE)
        }
    }

    private init(surface: Color, ink: Color, muted: Color, primary: Color, success: Color, danger: Color, track: Color) {
        self.surface = surface; self.ink = ink; self.muted = muted; self.primary = primary
        self.success = success; self.danger = danger; self.track = track
    }

    static let island = Palette(surface: .black, ink: .white, muted: .white.opacity(0.7), primary: .white,
                                success: hex(0x7FD1AD), danger: hex(0xF2A69F), track: .white.opacity(0.25))

    func tone(_ state: TransferAttributes.ContentState) -> Color {
        state.failed ? danger : state.done ? success : primary
    }
}

private func hex(_ value: UInt32) -> Color {
    Color(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
}

/* The headline and the file and count under it. */
private struct TransferWords: View {
    let state: TransferAttributes.ContentState
    let palette: Palette

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // A long folder name shrinks a little before it truncates.
            title.font(.callout.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
            if !state.detail.isEmpty { detail.font(.footnote).foregroundStyle(palette.muted).lineLimit(1) }
        }
    }
}

extension TransferWords {
    /* "Keeping “Very long fol…der name”": the words and quotes stay whole; a long name gives way in its middle. */
    @ViewBuilder var title: some View {
        if let open = state.title.firstIndex(of: "“"), let close = state.title.lastIndex(of: "”"), open < close {
            HStack(spacing: 0) {
                // Each piece is one line of its own: the stack's limit doesn't reach them in a widget.
                Text(state.title[...open]).lineLimit(1).fixedSize()
                Text(state.title[state.title.index(after: open)..<close]).lineLimit(1).truncationMode(.middle)
                Text(state.title[close...]).lineLimit(1).fixedSize()
            }
        } else {
            // "Keeping 1 file on this phone" shrinks a little rather than losing words.
            Text(state.title).lineLimit(1).minimumScaleFactor(0.75)
        }
    }

    /*
     * "2 of 5 · holiday-video-final.mp4": the part before the dot stays whole, and a long
     * file name gives way in its middle so its extension still shows.
     */
    @ViewBuilder var detail: some View {
        let parts = state.detail.components(separatedBy: " · ")
        if parts.count > 1 {
            HStack(spacing: 0) {
                Text(parts[0] + " · ").lineLimit(1).fixedSize()
                Text(parts.dropFirst().joined(separator: " · ")).lineLimit(1).truncationMode(.middle)
            }
        } else {
            Text(state.detail).truncationMode(.middle)
        }
    }
}

/* The percent, Done, or the count of what failed, set like the title so they share its line. */
private struct TransferTrailing: View {
    let context: ActivityViewContext<TransferAttributes>
    let palette: Palette

    var body: some View {
        HStack(spacing: 6) {
            if context.state.done { TransferSymbol.image(context).foregroundStyle(palette.tone(context.state)) }
            // One line always: the island's trailing region is narrow, and "100 %" wrapped there.
            Text(text).font(.callout.weight(.semibold).monospacedDigit()).foregroundStyle(palette.ink)
                .lineLimit(1).fixedSize()
        }
    }

    private var text: String {
        let state = context.state
        if state.failed { return state.count }
        // Every byte sent is not the same as finished: the server still has to close the upload.
        return state.done ? "Done" : "\(min(99, Int(state.fraction * 100)))%"
    }
}

/* A plain bar on its own track, coloured by how it went. */
private struct TransferBar: View {
    let state: TransferAttributes.ContentState
    let palette: Palette

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.track)
                Capsule().fill(palette.tone(state)).frame(width: max(6, geo.size.width * min(1, max(0, state.fraction))))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

private enum TransferSymbol {
    static func image(_ context: ActivityViewContext<TransferAttributes>) -> Image {
        if context.state.failed { return Image(systemName: "exclamationmark.triangle.fill") }
        if context.state.done { return Image(systemName: "checkmark.circle.fill") }
        return Image(systemName: context.attributes.kind == "upload" ? "arrow.up" : "arrow.down")
    }
}

/* The app's mark, small: the cream mark on Hush blue. */
private struct AppMark: View {
    let size: CGFloat

    var body: some View {
        Image("BrandMark").resizable().frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}
