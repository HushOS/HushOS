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
        /* label, 12 semibold: section labels. */
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
            return dark ? UIColor(red: 0x26 / 255, green: 0x2B / 255, blue: 0x3A / 255, alpha: 1) : UIColor(red: 0xE2 / 255, green: 0xE5 / 255, blue: 0xEE / 255, alpha: 1)
        }
        return dark ? UIColor(red: 0x3A / 255, green: 0x41 / 255, blue: 0x55 / 255, alpha: 1) : UIColor(red: 0xC5 / 255, green: 0xCA / 255, blue: 0xD8 / 255, alpha: 1)
    })

    /* Minimum touch target, list row and the mark inside a row (packages/tokens `size`). */
    static let control: CGFloat = 44
    static let row: CGFloat = 56
    static let mark: CGFloat = 36

    /* UIKit's own bars, which SwiftUI's large titles are drawn by. */
    @MainActor static func configureAppearance() {
        let large = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: .systemFont(ofSize: 34, weight: .heavy))
        let ink = UIColor(Alpine.ink)
        let bar = UINavigationBar.appearance()
        bar.largeTitleTextAttributes = [.font: large, .foregroundColor: ink, .kern: -1.0]
        bar.titleTextAttributes = [.foregroundColor: ink]
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
struct EmptyStateView<Actions: View>: View {
    var symbol: String? = nil
    var danger = false
    let title: String
    var message: String? = nil
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: Alpine.Space.s2) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.title2)
                    .foregroundStyle(danger ? Alpine.danger : Alpine.onTint)
                    .frame(width: 56, height: 56)
                    .background(danger ? Alpine.dangerSoft : Alpine.tint, in: Circle())
                    .padding(.bottom, Alpine.Space.s2)
                    .accessibilityHidden(true)
            }
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
    init(symbol: String? = nil, danger: Bool = false, title: String, message: String? = nil) {
        self.init(symbol: symbol, danger: danger, title: title, message: message) { EmptyView() }
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
 * Every screen's header, as Home has it: one row with the large title on the left and
 * the screen's actions on the right in one glass capsule; a pushed screen puts its back
 * button in front of the title. It scrolls with the list; once it has gone, a compact
 * bar with the same title and actions takes its place (`screenChrome`).
 */
struct ScreenHeader<Actions: View>: View {
    let title: String
    var back: (() -> Void)? = nil
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            if let back { BackButton(action: back) }
            Text(title)
                .font(Theme.Text.titleLarge).kerning(-1)
                .foregroundStyle(Alpine.ink)
                .lineLimit(1).minimumScaleFactor(0.6)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: Alpine.Space.s2)
            HeaderActions(content: actions)
        }
        .frame(minHeight: Theme.control)
        .padding(.horizontal, Alpine.Space.s1)
        .textCase(nil)
    }
}

extension ScreenHeader where Actions == EmptyView {
    init(title: String, back: (() -> Void)? = nil) {
        self.init(title: title, back: back) { EmptyView() }
    }
}

/* The actions beside a title, grouped in one glass capsule as the system groups bar buttons. */
struct HeaderActions<Content: View>: View {
    @ViewBuilder var content: () -> Content
    /* No capsule around nothing: a screen whose actions are all hidden right now draws none. */
    @State private var width: CGFloat = 0

    var body: some View {
        HStack(spacing: 0) { content() }
            .font(.body.weight(.semibold))
            .foregroundStyle(Alpine.primary)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .glassEffect(width > 0 ? .regular.interactive() : .identity, in: .capsule)
            .highContrastEdge(Capsule().inset(by: width > 0 ? 0 : 1000))
    }
}

/* An icon in a header capsule: a 44pt target. */
struct HeaderIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol).font(.system(size: 17, weight: .semibold)).frame(width: Theme.control, height: Theme.control).contentShape(Rectangle())
    }
}

/* A word in a header capsule ("Done", "Select all"). */
struct HeaderWord: View {
    let text: String

    var body: some View {
        // One line always: a header word that wraps ("Empty / Trash") reads as two buttons.
        Text(text).font(.body.weight(.semibold)).lineLimit(1).fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 14).frame(minHeight: Theme.control).contentShape(Rectangle())
    }
}

struct BackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(Alpine.ink)
                .frame(width: Theme.control, height: Theme.control).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .highContrastEdge(Circle())
        .accessibilityLabel("Back")
    }
}

extension View {
    /*
     * The chrome around a list that starts with a ScreenHeader: no system bar (so nothing
     * sits empty above the title), and once the header has scrolled away a compact bar
     * with the same back button, title and actions fades in at the top.
     */
    func screenChrome<Actions: View>(title: String, back: (() -> Void)? = nil, @ViewBuilder actions: @escaping () -> Actions) -> some View {
        modifier(ScreenChrome(title: title, back: back, actions: actions))
    }

    func screenChrome(title: String, back: (() -> Void)? = nil) -> some View {
        modifier(ScreenChrome(title: title, back: back, actions: { EmptyView() }))
    }
}

private struct ScreenChrome<Actions: View>: ViewModifier {
    let title: String
    let back: (() -> Void)?
    let actions: () -> Actions
    @State private var collapsed = false

    func body(content: Self.Content) -> some View {
        content
            .toolbar(.hidden, for: .navigationBar)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top > 56
            } action: { _, past in
                withAnimation(.easeOut(duration: 0.18)) { collapsed = past }
            }
            .overlay(alignment: .top) {
                if collapsed {
                    ZStack {
                        Text(title).font(.headline).foregroundStyle(Alpine.ink).lineLimit(1).padding(.horizontal, 110)
                        HStack {
                            if let back { BackButton(action: back) }
                            Spacer()
                            HeaderActions(content: actions)
                        }
                    }
                    .padding(.horizontal, Alpine.Space.s4).padding(.bottom, 6)
                    .frame(maxWidth: .infinity)
                    .background {
                        // Ground, fading out below, so rows pass under it the way they pass under a system bar.
                        LinearGradient(colors: [Alpine.ground, Alpine.ground, Alpine.ground.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .ignoresSafeArea(edges: .top)
                    }
                    .transition(.opacity)
                }
            }
    }
}

/* The system bar is hidden on screens that draw their own header; the edge swipe still goes back. */
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
