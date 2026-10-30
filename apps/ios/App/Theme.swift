import SwiftUI
import UIKit

/*
 * Alpine on iOS. Colours, radii and spacing come from `Alpine` (packages/tokens,
 * generated); this file maps the token type scale onto the system font's text
 * styles, so Dynamic Type still scales it, and holds the few pieces of furniture
 * every screen shares: the grouped-list surfaces, raised edges and the offline line.
 * The app keeps the system font: the token brand face is for the web.
 */
enum Theme {
    /* The token scale (packages/tokens `type`), as system text styles at the same default sizes. */
    enum Text {
        /* titleLarge, 34 heavy: large titles. */
        static let titleLarge = Font.largeTitle.weight(.heavy)
        /* title, 22 bold: section headings, sheet and alert titles. */
        static let title = Font.title2.weight(.bold)
        /* headline, 17 semibold: row titles that lead, buttons. */
        static let headline = Font.headline
        /* body: running text and row names (iOS keeps 17 for list rows). */
        static let body = Font.body
        /* callout, 15: supporting lines in sheets, cards and banners. */
        static let callout = Font.subheadline
        /* footnote, 13: metadata and footers. */
        static let footnote = Font.footnote
        /* label, 12 semibold: badges and chips only, never a section's or a field's name. */
        static let label = Font.caption.weight(.semibold)
    }

    /*
     * Row dividers. Not a token yet (packages/tokens has `rule`, which in high contrast is a
     * 4.5:1 edge colour): dividers between rows are decorative, so in high contrast they
     * step up from the normal hairline but never reach the edge strength controls need.
     */
    static let divider = Color(uiColor: UIColor { traits in
        let dark = traits.userInterfaceStyle == .dark
        guard traits.accessibilityContrast == .high else {
            return dark ? UIColor(red: 0x38 / 255, green: 0x38 / 255, blue: 0x3A / 255, alpha: 1) : UIColor(red: 0xE2 / 255, green: 0xE5 / 255, blue: 0xEE / 255, alpha: 1)
        }
        return dark ? UIColor(red: 0x3A / 255, green: 0x41 / 255, blue: 0x55 / 255, alpha: 1) : UIColor(red: 0xC5 / 255, green: 0xCA / 255, blue: 0xD8 / 255, alpha: 1)
    })

    /* Minimum touch target, list row and the mark inside a row (packages/tokens `size`). */
    static let control: CGFloat = 44
    static let row: CGFloat = 56
    static let mark: CGFloat = 36

    /*
     * Between the system bar and a list's first card or control. The bar ends 20pt below a big title and 10pt
     * below a search field; 2 more puts the first card where main's one-row header put it (22 and 12 on
     * iPhone 17), the same on every screen.
     */
    static let listTop: CGFloat = 2

    /* UIKit's own bars, which SwiftUI's large titles are drawn by. */
    @MainActor static func configureAppearance() {
        let large = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: .systemFont(ofSize: 34, weight: .heavy))
        let ink = UIColor(Alpine.ink)
        let bar = UINavigationBar.appearance()
        bar.largeTitleTextAttributes = [.font: large, .foregroundColor: ink, .kern: -1.0]
        bar.titleTextAttributes = [.foregroundColor: ink]
    }
}

/*
 * A section's name over a grouped list: a real heading at the title scale in ink, never a small
 * muted kicker (DESIGN.md, No eyebrows). Pulled in to line up with the card's edge.
 */
struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(Theme.Text.title).foregroundStyle(Alpine.ink).textCase(nil)
            .padding(.leading, -Alpine.Space.s1).accessibilityAddTraits(.isHeader)
    }
}

/* A field's name over the field: callout at 600 in ink, sentence case. */
struct FieldLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink).textCase(nil)
    }
}

extension View {
    /* A grouped list or form on the ground colour; rows sit on the surface. */
    func alpineGrouped() -> some View {
        self.scrollContentBackground(.hidden)
            .background(Alpine.ground)
            .listRowBackground(Alpine.surface)
            .listRowSeparatorTint(Theme.divider)
    }

    /* A row on a surface card, inset grouped; a picked row adds the tint behind its check. */
    func alpineRow(selected: Bool = false) -> some View {
        self.listRowBackground(selected ? Alpine.tint : Alpine.surface)
            .listRowSeparatorTint(Theme.divider)
    }

    /* A 56pt item row: the row sets its own height, the list adds only the side margins. */
    func itemRow(selected: Bool = false) -> some View {
        self.alpineRow(selected: selected)
            .listRowInsets(EdgeInsets(top: 0, leading: Alpine.Space.s4, bottom: 0, trailing: Alpine.Space.s4))
    }

    /* Furniture above or between the cards (capsules, banners, chips): no card behind it. */
    func bareRow(top: CGFloat = 0, bottom: CGFloat = Alpine.Space.s3) -> some View {
        self.listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: top, leading: 0, bottom: bottom, trailing: 0))
    }

    /* A banner or card that floats on the ground: a faint edge normally, a solid one in high contrast. */
    func alpineCardEdge<S: InsettableShape>(_ shape: S) -> some View {
        modifier(CardEdge(shape: shape))
    }

    /* Glass controls keep the system's glass; in high contrast they also get the solid 4.5:1 edge every control needs. */
    func highContrastEdge<S: InsettableShape>(_ shape: S) -> some View {
        modifier(HighContrastEdge(shape: shape))
    }

    /* Raised furniture (notices, bars): a soft ink shadow normally, a solid edge in high contrast where shadows carry nothing. */
    func alpineRaised<S: InsettableShape>(_ shape: S) -> some View {
        modifier(Raised(shape: shape))
    }
}

extension View {
    /*
     * A row of chips scrolls past its column to the screen's edge, except where that edge holds
     * a vertical bar (iPhone Duo's strip of status, tabs and back): chips drawn into the strip
     * would sit under the system's controls, so there the row stops at its column.
     */
    func chipRowClip() -> some View {
        modifier(ChipRowClip())
    }
}

private struct ChipRowClip: ViewModifier {
    func body(content: Self.Content) -> some View {
        if #available(iOS 27.1, *) {
            content.modifier(BarAwareChipRowClip())
        } else {
            content.scrollClipDisabled()
        }
    }
}

@available(iOS 27.1, *)
private struct BarAwareChipRowClip: ViewModifier {
    @Environment(\.toolbarVerticalEdge) private var barEdge

    func body(content: Self.Content) -> some View {
        content.scrollClipDisabled(barEdge == nil)
    }
}

private struct CardEdge<S: InsettableShape>: ViewModifier {
    let shape: S

    func body(content: Self.Content) -> some View {
        // `edge` is the faint outline normally and the solid 4.5:1 edge in high contrast.
        content.overlay { shape.strokeBorder(Alpine.edge, lineWidth: 1) }
    }
}

private struct HighContrastEdge<S: InsettableShape>: ViewModifier {
    let shape: S
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Self.Content) -> some View {
        content.overlay { if contrast == .increased { shape.strokeBorder(Alpine.edge, lineWidth: 1).allowsHitTesting(false) } }
    }
}

private struct Raised<S: InsettableShape>: ViewModifier {
    let shape: S
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Self.Content) -> some View {
        if contrast == .increased {
            content.overlay(shape.strokeBorder(Alpine.edge, lineWidth: 1))
        } else {
            content
                .overlay(shape.strokeBorder(Alpine.edge, lineWidth: 1))
                .shadow(color: Color.black.opacity(0.12), radius: 12, y: 6)
        }
    }
}

/* "You're offline. Showing what's on this phone.": a quiet capsule at the top of a list, not a full-width bar. */
struct OfflineCapsule: View {
    var body: some View {
        HStack(spacing: Alpine.Space.s2) {
            Image(systemName: "icloud.slash").font(.subheadline).foregroundStyle(Alpine.inkMuted)
            Text("You’re offline. Showing what’s on this phone.").font(Theme.Text.callout).foregroundStyle(Alpine.ink)
                .lineLimit(2).minimumScaleFactor(0.9)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        // A capsule on one line; at larger text sizes it wraps and keeps its rounded ends.
        .background(Alpine.ink.opacity(0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/* A centred empty, error or offline state: a quiet mark, a short title, one line, then actions. */
/*
 * An empty, error or waiting state: a short title, one line, then the actions. No icon tile
 * (DESIGN.md: no icon tiles for decoration); Android's is the same.
 */
struct EmptyStateView<Actions: View>: View {
    let title: String
    var message: String? = nil
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: Alpine.Space.s2) {
            Text(title).font(.title3.weight(.bold)).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
            if let message {
                Text(message).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }
            actions().padding(.top, Alpine.Space.s3)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Alpine.Space.s8)
        .padding(.vertical, Alpine.Space.s6)
    }
}

extension EmptyStateView where Actions == EmptyView {
    init(title: String, message: String? = nil) {
        self.init(title: title, message: message) { EmptyView() }
    }
}

/* The filled primary capsule the board draws for an empty state's action. */
struct PrimaryCapsuleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Capsule_(configuration: configuration) }

    /* Off, it fades to a quiet fill with muted text, so it never reads as ready. */
    private struct Capsule_: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(enabled ? Alpine.onPrimary : Alpine.inkMuted)
                .padding(.horizontal, 20)
                .frame(minHeight: Theme.control)
                .background(enabled ? (configuration.isPressed ? Alpine.primaryPressed : Alpine.primary) : Alpine.ink.opacity(0.08), in: Capsule())
        }
    }
}

/* The quiet capsule beside it. */
struct SecondaryCapsuleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Alpine.ink)
            .padding(.horizontal, 20)
            .frame(minHeight: Theme.control)
            .background(Alpine.ink.opacity(configuration.isPressed ? 0.12 : 0.07), in: Capsule())
    }
}

/* "Today, 14:02", "Yesterday", "29 Sept", "3 Mar 2025": how the board says when something changed. */
/* Day and month the en-GB way on every client ("29 Sept"), as the web writes them; times keep the phone's own clock. */
extension Locale {
    static let dayMonth = Locale(identifier: "en_GB")
}

func changedLabel(_ date: Date?) -> String? {
    guard let date else { return nil }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Today, " + date.formatted(date: .omitted, time: .shortened) }
    if calendar.isDateInYesterday(date) { return "Yesterday" }
    if calendar.isDate(date, equalTo: .now, toGranularity: .year) { return date.formatted(.dateTime.day().month(.abbreviated).locale(.dayMonth)) }
    return date.formatted(.dateTime.day().month(.abbreviated).year().locale(.dayMonth))
}

/*
 * Every screen's header is iOS's own navigation bar, so the bar moves where iOS puts bars
 * (iPhone Duo's vertical strip, the tab sidebar's toggle on a wide window), with the screen's
 * actions as toolbar items (the system groups them in one glass capsule) and the system's Back.
 * The look is Alpine's through the bar appearance (`Theme.configureAppearance`) and the tint.
 *
 * - A tab root (Home, Files, Shared, Account, Search) has its big title on the row with its
 *   buttons (inlineLarge; nothing sits in a row above the title, as DESIGN.md asks of phones).
 * - A pushed screen (a folder, Trash, Devices, …) follows Apple's Files app: the title leading,
 *   right after Back, on the same row as the buttons (the browser role, which leads the title,
 *   with the title inline). UIKit documents that a large inline title reverts to its own row
 *   under the buttons once there is a Back button (`UINavigationItem.LargeTitleDisplayMode.inline`),
 *   so a pushed screen never asks for one.
 */

/* An icon in the bar: the system sizes it and makes the 44pt target. */
struct HeaderIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
    }
}

/* A word in the bar ("Done", "Select all"), one line always: a word that wraps reads as two buttons. */
struct HeaderWord: View {
    let text: String

    var body: some View {
        Text(text).lineLimit(1)
    }
}

extension View {
    /*
     * The chrome of a screen: the system bar with this title and these actions at its trailing
     * end; `root` for a tab's first screen. On a wide window the rows keep a readable column.
     */
    func screenChrome<Actions: View>(title: String, root: Bool = false, @ViewBuilder actions: @escaping () -> Actions) -> some View {
        modifier(ScreenChrome(title: title, root: root, actions: actions))
    }

    func screenChrome(title: String, root: Bool = false) -> some View {
        modifier(ScreenChrome(title: title, root: root, actions: { EmptyView() }))
    }
}

private struct ScreenChrome<Actions: View>: ViewModifier {
    let title: String
    let root: Bool
    let actions: () -> Actions
    @State private var width: CGFloat = 0
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    func body(content: Self.Content) -> some View {
        content
            // Where the window is wider than a list reads well (iPhone Duo's inner display on its side, an
            // iPad), the rows keep a readable column in the middle rather than stretching edge to edge.
            .contentMargins(.horizontal, ReadableColumn.margin(forWidth: width, regularHeight: verticalSizeClass == .regular), for: .scrollContent)
            // The list starts just under the system bar, as main's own header had its first card: the inset-grouped
            // list's own top margin (about 35pt) left a gap the old header never had.
            .contentMargins(.top, Theme.listTop, for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .navigationTitle(title)
            .toolbarTitleDisplayMode(root ? .inlineLarge : .inline)
            .toolbarRole(root ? .automatic : .browser)
            .toolbar {
                if !root {
                    // Sized as Apple's Files sizes a folder's title beside Back; the system's own inline title is 17pt.
                    ToolbarItem(placement: .title) {
                        Text(title).font(.title3.weight(.bold)).foregroundStyle(Alpine.ink).lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) { actions() }
            }
    }
}

/* How wide a list or a settings page gets before it stops growing and centres instead. */
enum ReadableColumn {
    static let width: CGFloat = 720

    /*
     * Each side's margin, the list's own 16 outside a centred column; nil (the system's own
     * margins, as today) wherever the window is no wider than the column, and on any iPhone screen
     * on its side (compact height), which stays as it is.
     */
    static func margin(forWidth available: CGFloat, regularHeight: Bool) -> CGFloat? {
        regularHeight && available > width ? (available - width) / 2 + Alpine.Space.s4 : nil
    }
}
