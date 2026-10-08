import HushOSKit
import SwiftUI
import UniformTypeIdentifiers

/*
 * One node in a list, as the board draws a row: 56pt tall, a 36pt mark, the name,
 * then who can open it and when it changed. Selecting adds a check in front; the
 * list tints the row behind it, so the tint never stands alone.
 */
struct NodeRow: View {
    @Environment(DriveStore.self) private var store
    let item: Opened
    /* Takes the date's place, as the trash's "Trashed 23 Sep" or Home's "Not on this phone". */
    var note: String? = nil
    /* Something is being done to it (a restore or a delete in the trash): a spinner until it is over. */
    var working = false
    /* In select mode: the check in front, filled when picked. */
    var selected: Bool? = nil
    /* Where it lives, for search results: "In Lisbon 2026" takes the access line's place. */
    var location: String? = nil
    /* Who can open it, before the date; the trash leaves it out. */
    var access = true
    /* The note says something went wrong ("Couldn’t be restored"): it is drawn in the danger colour. */
    var noteIsProblem = false
    /* In Recent: the date is when it changed in HushOS, which Recent is ordered by, not the file's own. */
    var recent = false

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            if let selected { SelectCheck(on: selected) }
            FileMark(item: item)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                HStack(spacing: 6) {
                    subtitleView.font(Theme.Text.footnote)
                    let tags = store.tags.tags(of: item.id)
                    if !tags.isEmpty {
                        HStack(spacing: 3) { ForEach(tags.prefix(3)) { tag in TagDot(tag: tag) } }
                            .accessibilityLabel("Tags: " + tags.map(\.name).joined(separator: ", "))
                    }
                }
            }
            Spacer(minLength: 0)
            if working {
                ProgressView().controlSize(.small)
            } else if let fraction = store.opening[item.id] {
                // Fetching to open: a small ring on the row, as the drives do, not a banner.
                ProgressView(value: fraction).progressViewStyle(.circular).controlSize(.small)
            }
        }
        .frame(minHeight: Theme.row)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected == true ? .isSelected : [])
        .task { store.thumbnail(for: item) }
    }

    /*
     * "Anyone with the link · [phone] Yesterday · 2.4 MB": who can open it when that differs from
     * its folder, then the kept mark, the date and the size. The words stay muted; an open link
     * leads with a small link icon in the brand blue.
     */
    /*
     * One line when it fits. When it doesn't (large text, a long access sentence), who can
     * open it keeps the first line and the kept mark, date and size wrap onto the next,
     * rather than being cut off.
     */
    @ViewBuilder private var subtitleView: some View {
        let (lead, rest) = subtitleParts
        ViewThatFits(in: .horizontal) {
            Self.join([lead, rest].compactMap { $0 }).lineLimit(1).fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 1) {
                if let lead { lead.fixedSize(horizontal: false, vertical: true) }
                if let rest { rest.fixedSize(horizontal: false, vertical: true) }
            }
        }
    }

    static func join(_ parts: [Text]) -> Text {
        guard var joined = parts.first else { return Text("") }
        for part in parts.dropFirst() { joined = Text("\(joined)\(Text(" · ").foregroundStyle(Alpine.inkMuted))\(part)") }
        return joined
    }

    /* The lead (where it is, or who can open it) and the rest (kept mark, date, size). */
    private var subtitleParts: (Text?, Text?) {
        let muted = Alpine.inkMuted
        var lead: Text?
        var parts: [Text] = []
        if let location {
            lead = Text(location).foregroundStyle(muted)
        } else if access, let line = store.accessLine(for: item) {
            lead = AccessText.line(line.link ?? line.text, link: line.link != nil)
        }
        var when: Text?
        if note == nil, !item.isFolder, store.keepFailure(item) != nil {
            // A file of a kept folder that couldn't be kept (it is tried again later; the menu has Retry).
            when = Text("Couldn’t be kept").foregroundStyle(Alpine.danger).fontWeight(.semibold)
        } else if let note, noteIsProblem {
            when = Text(note).foregroundStyle(Alpine.danger).fontWeight(.semibold)
        } else if let label = note ?? changedLabel(recent ? item.changed : item.modified) {
            when = Text(label).foregroundStyle(muted)
        }
        // Kept on this phone (a file, a folder, or a file kept with its folder): the phone mark leads the date, as on Android.
        if store.isOnPhone(item) {
            parts.append(when.map { Text("\(KeptMark.text) \($0)") } ?? KeptMark.text)
        } else if let when {
            parts.append(when)
        }
        // A file's size after its date; a note (a kept size, "Trashed …") already says what matters.
        if note == nil, location == nil, let size = item.size { parts.append(Text(formatBytes(Int64(size))).foregroundStyle(muted)) }
        return (lead, parts.isEmpty ? nil : Self.join(parts))
    }

    static func type(for item: Opened) -> UTType {
        if let mime = item.metadata.mime, let type = UTType(mimeType: mime) { return type }
        return UTType(filenameExtension: (item.name as NSString).pathExtension) ?? .data
    }
}

/*
 * One node in a folder's grid: a 4:3 picture (a photo or a video frame as itself,
 * anything else its row mark centred on the surface the row's mark sits on), the
 * name, then the row's second line without the date. Selecting adds a check in the
 * picture's corner; the grid tints the tile behind it, as the list tints a row.
 */
struct NodeTile: View {
    @Environment(DriveStore.self) private var store
    let item: Opened
    /* In select mode: the check in the corner, filled when picked. */
    var selected: Bool? = nil

    static let radius = Alpine.Radius.card
    /* Just outside the tile, concentric with its picture: the selected tint and the long-press preview. */
    static let halo = RoundedRectangle(cornerRadius: radius + Alpine.Space.s1, style: .continuous)

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            picture
            HStack(spacing: Alpine.Space.s2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                    HStack(spacing: 6) {
                        line.font(Theme.Text.footnote).lineLimit(1)
                        let tags = store.tags.tags(of: item.id)
                        if !tags.isEmpty {
                            HStack(spacing: 3) { ForEach(tags.prefix(3)) { tag in TagDot(tag: tag) } }
                                .accessibilityLabel("Tags: " + tags.map(\.name).joined(separator: ", "))
                        }
                    }
                }
                Spacer(minLength: 0)
                if let fraction = store.opening[item.id] {
                    ProgressView(value: fraction).progressViewStyle(.circular).controlSize(.small)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected == true ? .isSelected : [])
        .task { store.thumbnail(for: item) }
    }

    /* A photo or a video frame fills the picture; anything else, a PDF included, is its type mark. */
    private var photo: UIImage? {
        let type = NodeRow.type(for: item)
        guard type.conforms(to: .image) || type.conforms(to: .movie), let data = store.thumbnails[item.id] else { return nil }
        return UIImage(data: data)
    }

    private var picture: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        let photo = photo
        return Alpine.surface
            .aspectRatio(4 / 3, contentMode: .fit)
            .overlay {
                if let photo {
                    Image(uiImage: photo).resizable().scaledToFill()
                    if NodeRow.type(for: item).conforms(to: .movie) {
                        Image(systemName: "play.fill").font(.system(size: 16)).foregroundStyle(.white)
                            .frame(width: 40, height: 40).background(.black.opacity(0.45), in: Circle())
                    }
                } else {
                    // A PDF's first page shrunk into a tile reads as a blank sheet; its type says more.
                    FileMark(item: item, box: 72, thumbnail: false)
                }
            }
            .clipShape(shape)
            // A white picture still reads, as the row's thumbnail does.
            .overlay { if photo != nil { shape.strokeBorder(Alpine.rule, lineWidth: 1) } }
            .overlay(alignment: .topLeading) {
                if let selected {
                    // The empty ring sits on the surface so it reads on any photo.
                    SelectCheck(on: selected).background(Circle().fill(Alpine.surface)).padding(Alpine.Space.s2)
                }
            }
            .accessibilityHidden(true)
    }

    /*
     * "318 KB", "Anyone with the link", "Folder": the row's second line with the date left
     * out. Who can open it leads, then the kept mark in front of the size; a folder with
     * nothing else to say says it is one.
     */
    private var line: Text {
        let muted = Alpine.inkMuted
        var parts: [Text] = []
        if let access = store.accessLine(for: item) {
            parts.append(AccessText.line(access.link ?? access.text, link: access.link != nil))
        }
        var rest: [Text] = []
        if !item.isFolder, store.keepFailure(item) != nil {
            rest.append(Text("Couldn’t be kept").foregroundStyle(Alpine.danger).fontWeight(.semibold))
        }
        if let size = item.size { rest.append(Text(formatBytes(Int64(size))).foregroundStyle(muted)) }
        if item.isFolder, parts.isEmpty { rest.append(Text("Folder").foregroundStyle(muted)) }
        if store.isOnPhone(item) {
            parts.append(rest.isEmpty ? KeptMark.text : Text("\(KeptMark.text) \(NodeRow.join(rest))"))
        } else {
            parts += rest
        }
        return NodeRow.join(parts)
    }
}

/* A tile's placeholder while a folder loads: the picture block and two text bars. */
struct SkeletonTile: View {
    let index: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            RoundedRectangle(cornerRadius: NodeTile.radius, style: .continuous).fill(Alpine.ink.opacity(0.07)).aspectRatio(4 / 3, contentMode: .fit)
            VStack(alignment: .leading, spacing: 6) {
                Capsule().fill(Alpine.ink.opacity(0.07)).frame(width: CGFloat(120 - (index * 29) % 50), height: 11)
                Capsule().fill(Alpine.ink.opacity(0.05)).frame(width: 60, height: 9)
            }
            .padding(.vertical, 4)
        }
        .accessibilityHidden(true)
    }
}

/*
 * An icon inside a row's subtitle. It takes the line's own font and weight rather than
 * one of its own, so every such icon (phone, link) is the same size, sits on the text
 * the way SF Symbols sit on their text, and is followed by the same single space.
 */
enum LineIcon {
    static func text(_ symbol: String, colour: Color, label: String) -> Text {
        Text(Image(systemName: symbol)).foregroundStyle(colour).accessibilityLabel(label)
    }
}

/* The kept mark: a small muted phone, as on Home's "On this phone" row and on Android. HushOS has no pinning. */
enum KeptMark {
    static var text: Text { LineIcon.text("iphone", colour: Alpine.inkMuted, label: "Kept on this phone") }
}

/*
 * Who can open, as one-line rows say it (Files, Home, Search, Shared, the move picker, the
 * viewer's foot). The words keep the line's colour; an open link adds a small link icon in
 * the brand blue in front. People-only access has no icon.
 * Detail lists (Info) say the whole sentence without it.
 */
enum AccessText {
    static var linkIcon: Text { LineIcon.text("link", colour: Alpine.primary, label: "") }

    static func line(_ words: String, link: Bool, colour: Color = Alpine.inkMuted) -> Text {
        let text = Text(words).foregroundStyle(colour)
        return link ? Text("\(linkIcon) \(text)") : text
    }
}

/* A tag as a small named pill in its colour; picked, it fills and carries a check, so colour is never the only sign. */
struct TagPill: View {
    let tag: Tag
    var selected = false

    var body: some View {
        HStack(spacing: 5) {
            if selected { Image(systemName: "checkmark").font(.caption2.weight(.bold)) } else { TagDot(tag: tag) }
            Text(tag.name).font(.footnote.weight(.semibold))
        }
        .foregroundStyle(selected ? Alpine.onTint : Alpine.ink)
        .padding(.horizontal, 10).frame(height: 28)
        .background(selected ? Alpine.tint : Alpine.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(selected ? Alpine.primary : Alpine.rule, lineWidth: 1))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/* A tag's colour as a dot; tags lighten in the dark so a deep colour stays visible. */
struct TagDot: View {
    let tag: Tag
    var size: CGFloat = 8

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let base = TagColour.swiftUI(tag.colour)
        Circle().fill(scheme == .dark && !TagColour.hasDarkValue(tag.colour) ? base.mix(with: .white, by: 0.35) : base).frame(width: size, height: size)
    }
}

/* The select-mode check: an empty ring, or a filled primary disc with a tick. */
struct SelectCheck: View {
    let on: Bool

    var body: some View {
        ZStack {
            Circle().strokeBorder(on ? Alpine.primary : Alpine.field, lineWidth: 2)
            if on {
                Circle().fill(Alpine.primary)
                Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(Alpine.onPrimary)
            }
        }
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }
}

/*
 * The mark for an item (DESIGN.md, Components): the thumbnail the app made at upload,
 * with a hairline edge so a white picture still reads; otherwise a folder of two solid
 * sheets, or a white page with a turned corner and its type.
 */
struct FileMark: View {
    @Environment(DriveStore.self) private var store
    let item: Opened
    var box: CGFloat = Theme.mark
    /* Off for a grid tile, which shows only photos and video frames as themselves. */
    var thumbnail = true

    var body: some View {
        Group {
            if thumbnail, let data = store.thumbnails[item.id], let image = UIImage(data: data) {
                let shape = RoundedRectangle(cornerRadius: box * 0.22, style: .continuous)
                Image(uiImage: image).resizable().scaledToFill()
                    .frame(width: box, height: box).clipShape(shape)
                    .overlay(shape.strokeBorder(Alpine.rule, lineWidth: 1))
                    .overlay {
                        if NodeRow.type(for: item).conforms(to: .movie) {
                            Image(systemName: "play.fill").font(.system(size: box * 0.2)).foregroundStyle(.white)
                                .frame(width: box * 0.46, height: box * 0.46).background(.black.opacity(0.45), in: Circle())
                        }
                    }
            } else if item.isFolder {
                FolderGlyph().frame(width: box * 0.9, height: box * 0.9 * 46 / 56)
            } else {
                PageGlyph(label: Self.label(for: item)).frame(width: box * 0.66, height: box * 0.66 * 54 / 44)
            }
        }
        .frame(width: box, height: box)
        .accessibilityHidden(true)
    }

    /* The type as a short word on the page, from the name the person gave it. */
    static func label(for item: Opened) -> String? {
        let ext = (item.name as NSString).pathExtension.uppercased()
        return (1 ... 4).contains(ext.count) ? ext : nil
    }
}

/* The web's formatQuota: GB (TB from 1024 GB), up to two decimals and no trailing zeros, so "1 GB", "200 GB", "1.5 TB". */
func formatQuota(_ value: Int64) -> String {
    let gib = Double(value) / 1_073_741_824
    let (amount, unit) = gib >= 1024 ? (gib / 1024, "TB") : (gib, "GB")
    return amount.formatted(.number.precision(.fractionLength(0 ... 2))) + " " + unit
}

/* Space beside a quota: like the quota from 1 GB up ("2 GB", never "2.0 GB"), formatBytes below it. */
func formatSpace(_ value: Int64) -> String {
    value >= 1_073_741_824 ? formatQuota(value) : formatBytes(value)
}
