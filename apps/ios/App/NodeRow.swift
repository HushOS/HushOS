import HushOSKit
import SwiftUI
import UniformTypeIdentifiers

/* One node in a list: a thumbnail or a type icon, the name, size and date. */
struct NodeRow: View {
    @Environment(DriveStore.self) private var store
    let item: Opened

    var body: some View {
        HStack(spacing: 12) {
            icon.frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).lineLimit(1)
                Text(subtitle).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                let tags = store.tags.tags(of: item.id)
                if !tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(tags.prefix(3)) { tag in TagPill(tag: tag) }
                        if tags.count > 3 { Text("+\(tags.count - 3)").font(.caption2).foregroundStyle(.secondary) }
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .task { store.thumbnail(for: item) }
    }

    @ViewBuilder private var icon: some View {
        if let data = store.thumbnails[item.id], let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: item.isFolder ? "folder.fill" : Self.symbol(for: item))
                .font(.title2)
                .foregroundStyle(item.isFolder ? Color.accentColor : Color.secondary)
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let modified = item.modified { parts.append(modified.formatted(date: .abbreviated, time: .shortened)) }
        if let size = item.size { parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
        if item.isFolder { parts.append("Folder") }
        return parts.joined(separator: " · ")
    }

    static func type(for item: Opened) -> UTType {
        if let mime = item.metadata.mime, let type = UTType(mimeType: mime) { return type }
        return UTType(filenameExtension: (item.name as NSString).pathExtension) ?? .data
    }

    static func symbol(for item: Opened) -> String {
        let type = type(for: item)
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .movie) { return "film" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .archive) { return "doc.zipper" }
        if type.conforms(to: .text) || type.conforms(to: .sourceCode) { return "doc.text" }
        if type.conforms(to: .spreadsheet) { return "tablecells" }
        if type.conforms(to: .presentation) { return "rectangle.on.rectangle" }
        return "doc"
    }
}

/* A tag as a small named pill in its colour. */
struct TagPill: View {
    let tag: Tag
    var selected = false

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let base = TagColour.swiftUI(tag.colour)
        // Dark sheets need a lighter ink and a stronger wash, or a deep blue tag vanishes.
        let ink = scheme == .dark ? base.mix(with: .white, by: 0.45) : base
        Text(tag.name)
            .font(.caption2.weight(.medium))
            .foregroundStyle(selected ? Color.white : ink)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(selected ? base : ink.opacity(scheme == .dark ? 0.22 : 0.14), in: Capsule())
    }
}
