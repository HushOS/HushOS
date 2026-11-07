import HushOSKit
import SwiftUI

/*
 * A Markdown file, drawn as a document rather than QuickLook's raw text: MarkdownDocument's
 * blocks (the web's rules: raw HTML dropped, links to http, https or mailto only and only on a
 * tap, images named and never fetched) in HushOS's type and colours. Text can be selected.
 * Android's MarkdownViewer draws the same blocks.
 */
struct MarkdownView: View {
    let url: URL
    @State private var blocks: [MarkdownBlock]?

    var body: some View {
        ScrollView {
            if let blocks {
                LazyVStack(alignment: .leading, spacing: Alpine.Space.s4) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        MarkdownBlockView(block: block)
                    }
                }
                .padding(.horizontal, Alpine.Space.s4)
                .padding(.vertical, Alpine.Space.s6)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity)
                .textSelection(.enabled)
            } else {
                ProgressView().tint(Alpine.primary).padding(.top, Alpine.Space.s12)
            }
        }
        .background(Alpine.ground)
        .tint(Alpine.primary)
        .task(id: url) {
            let url = url
            // The last file's words go at once: paging to the next shows it loading, never the last one under the new name.
            blocks = nil
            // Read and parsed off the main thread: a long file shouldn't hold up the viewer's bars.
            let parsed = await Task.detached(priority: .userInitiated) {
                let data = (try? Data(contentsOf: url)) ?? Data()
                return MarkdownDocument.parse(String(decoding: data, as: UTF8.self))
            }.value
            // Paged on while it parsed: a slower earlier file must not land over the one now shown.
            guard !Task.isCancelled else { return }
            blocks = parsed
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    /* A quote's words are muted, all the way down. */
    var muted = false
    private var ink: Color { muted ? Alpine.inkMuted : Alpine.ink }

    var body: some View {
        switch block {
        case .heading(let level, let inline):
            MarkdownText(inline: inline)
                .font(Self.heading(level))
                .foregroundStyle(ink)
                .padding(.top, level <= 2 ? Alpine.Space.s2 : 0)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let inline):
            MarkdownText(inline: inline).font(Theme.Text.body).foregroundStyle(ink)
        case .list(let list):
            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: Alpine.Space.s2) {
                        marker(list, index: index, check: item.check)
                        VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                            ForEach(Array(item.blocks.enumerated()), id: \.offset) { _, inner in MarkdownBlockView(block: inner, muted: muted) }
                        }
                    }
                }
            }
        case .quote(let blocks):
            HStack(alignment: .top, spacing: Alpine.Space.s3) {
                RoundedRectangle(cornerRadius: 1.5).fill(Alpine.rule).frame(width: 3)
                VStack(alignment: .leading, spacing: Alpine.Space.s3) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, inner in MarkdownBlockView(block: inner, muted: true) }
                }
            }
        case .code(_, let text):
            ScrollView(.horizontal) {
                Text(text).font(.system(.callout, design: .monospaced)).foregroundStyle(ink)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(Alpine.Space.s3)
            }
            .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .rule:
            Rectangle().fill(Alpine.rule).frame(height: 1).padding(.vertical, Alpine.Space.s2)
        case .table(let table):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: Alpine.Space.s4, verticalSpacing: Alpine.Space.s2) {
                    GridRow {
                        ForEach(Array(table.head.enumerated()), id: \.offset) { column, cell in
                            MarkdownText(inline: cell).font(Theme.Text.callout.weight(.semibold))
                                .gridColumnAlignment(Self.alignment(table, column))
                        }
                    }
                    Rectangle().fill(Alpine.rule).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                    ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in MarkdownText(inline: cell).font(Theme.Text.callout) }
                        }
                    }
                }
                .foregroundStyle(ink)
                .padding(Alpine.Space.s3)
            }
            .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    @ViewBuilder private func marker(_ list: MarkdownList, index: Int, check: Bool?) -> some View {
        if let check {
            Image(systemName: check ? "checkmark.square.fill" : "square")
                .foregroundStyle(check ? Alpine.primary : Alpine.inkMuted)
                .accessibilityLabel(check ? "Done" : "Not done")
        } else if list.ordered {
            Text("\(list.start + index).").font(Theme.Text.body.monospacedDigit()).foregroundStyle(Alpine.inkMuted)
        } else {
            Text("•").font(Theme.Text.body).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
        }
    }

    private static func heading(_ level: Int) -> Font {
        switch level {
        case 1: .title.weight(.bold)
        case 2: .title2.weight(.bold)
        case 3: .title3.weight(.semibold)
        default: .headline
        }
    }

    private static func alignment(_ table: MarkdownTable, _ column: Int) -> HorizontalAlignment {
        switch table.alignments.indices.contains(column) ? table.alignments[column] : .leading {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

/* A run of styled text; an image is its mark and its words, never the picture. */
private struct MarkdownText: View {
    let inline: MarkdownInline

    var body: some View {
        inline.runs.reduce(Text(verbatim: "")) { text, run in
            switch run {
            case .text(let words):
                return Text("\(text)\(Text(words))")
            case .image(let alt, _):
                let name = Text("\(Image(systemName: "photo")) \(alt.isEmpty ? "Image" : alt)").foregroundStyle(Alpine.inkMuted)
                return Text("\(text)\(name)")
            }
        }
    }
}
