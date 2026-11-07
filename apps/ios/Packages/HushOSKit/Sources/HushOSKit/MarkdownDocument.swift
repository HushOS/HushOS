import Foundation
import Markdown

/*
 * A Markdown file as data, for the viewer to draw: the web's rules (apps/web/src/lib/markdown.ts,
 * components/drive/rich-text.tsx) on Apple's parser. CommonMark plus GitHub's tables, task lists
 * and strikethrough. Raw HTML in the document is dropped, not shown and never run. A link is a
 * link only to http, https or mailto, and only on a tap; an image is named, never fetched, so
 * opening a file loads nothing from anywhere. Android's MarkdownDocument does the same.
 */
public enum MarkdownDocument {
    /* Past this the file opens as it did before (QuickLook): the web's MARKDOWN_LIMIT. */
    public static let limit = 2 * 1024 * 1024

    /* Opened in the Markdown viewer: the web's previewKind rule. */
    public static func handles(name: String, mime: String?) -> Bool {
        if mime?.lowercased() == "text/markdown" { return true }
        let ext = (name as NSString).pathExtension.lowercased()
        return ["md", "markdown", "mdx"].contains(ext)
    }

    public static func parse(_ text: String) -> [MarkdownBlock] {
        blocks(of: Document(parsing: text).children)
    }

    private static func blocks(of children: MarkupChildren) -> [MarkdownBlock] {
        children.compactMap(block)
    }

    private static func block(_ markup: Markup) -> MarkdownBlock? {
        switch markup {
        case let heading as Heading: return .heading(level: heading.level, inline(heading.children))
        case let paragraph as Paragraph: return .paragraph(inline(paragraph.children))
        case let list as OrderedList: return .list(MarkdownList(ordered: true, start: Int(list.startIndex), items: items(list.listItems)))
        case let list as UnorderedList: return .list(MarkdownList(ordered: false, start: 1, items: items(list.listItems)))
        case let quote as BlockQuote: return .quote(blocks(of: quote.children))
        case let code as CodeBlock: return .code(language: code.language, text: code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code)
        case is ThematicBreak: return .rule
        case let table as Table:
            return .table(MarkdownTable(
                alignments: table.columnAlignments.map { alignment in
                    switch alignment {
                    case .center: .center
                    case .right: .trailing
                    default: .leading
                    }
                },
                head: Array(table.head.cells).map { inline($0.children) },
                rows: Array(table.body.rows).map { row in Array(row.cells).map { inline($0.children) } }
            ))
        // Raw HTML is dropped, as on the web: not drawn, not run, not shown as text.
        case is HTMLBlock: return nil
        // Nothing else is parsed without asking (block directives, Doxygen commands).
        default: return nil
        }
    }

    private static func items(_ items: some Sequence<ListItem>) -> [MarkdownListItem] {
        items.map { item in
            MarkdownListItem(check: item.checkbox.map { $0 == .checked }, blocks: blocks(of: item.children))
        }
    }

    /* A paragraph's runs: styled text, with images named in their own runs. */
    private static func inline(_ children: MarkupChildren) -> MarkdownInline {
        var runs: [MarkdownInline.Run] = []
        var text = AttributedString()
        func flush() {
            if !text.characters.isEmpty { runs.append(.text(text)) }
            text = AttributedString()
        }
        func walk(_ markup: Markup, _ intent: InlinePresentationIntent, _ link: URL?) {
            func styled(_ string: String, _ extra: InlinePresentationIntent = []) {
                var piece = AttributedString(string)
                let all = intent.union(extra)
                if !all.isEmpty { piece.inlinePresentationIntent = all }
                if let link { piece.link = link }
                text.append(piece)
            }
            switch markup {
            case let plain as Markdown.Text: styled(plain.string)
            case let code as InlineCode: styled(code.code, .code)
            case is SoftBreak: styled(" ")
            case is LineBreak: styled("\n")
            // Dropped, as on the web.
            case is InlineHTML: break
            case let image as Markdown.Image:
                flush()
                runs.append(.image(alt: image.plainText, source: image.source))
            case let anchor as Markdown.Link:
                let target = anchor.destination.flatMap(safeLink)
                for child in anchor.children { walk(child, intent, target ?? link) }
            case is Emphasis: for child in markup.children { walk(child, intent.union(.emphasized), link) }
            case is Strong: for child in markup.children { walk(child, intent.union(.stronglyEmphasized), link) }
            case is Strikethrough: for child in markup.children { walk(child, intent.union(.strikethrough), link) }
            default: for child in markup.children { walk(child, intent, link) }
            }
        }
        for child in children { walk(child, [], nil) }
        flush()
        return MarkdownInline(runs: runs)
    }

    /* A link the viewer may open on a tap: http, https or mailto only, as the web's sanitiser allows. */
    public static func safeLink(_ destination: String) -> URL? {
        guard let url = URL(string: destination.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }
}

public indirect enum MarkdownBlock: Sendable, Equatable {
    case heading(level: Int, MarkdownInline)
    case paragraph(MarkdownInline)
    case list(MarkdownList)
    case quote([MarkdownBlock])
    case code(language: String?, text: String)
    case rule
    case table(MarkdownTable)
}

public struct MarkdownInline: Sendable, Equatable {
    public enum Run: Sendable, Equatable {
        case text(AttributedString)
        /* Named, never fetched: the viewer shows the alt text with an image mark, and the source only as text. */
        case image(alt: String, source: String?)
    }

    public let runs: [Run]

    /* The words alone, for accessibility and tests. */
    public var plainText: String {
        runs.map { run in
            switch run {
            case .text(let text): String(text.characters)
            case .image(let alt, _): alt
            }
        }.joined()
    }
}

public struct MarkdownList: Sendable, Equatable {
    public let ordered: Bool
    public let start: Int
    public let items: [MarkdownListItem]
}

public struct MarkdownListItem: Sendable, Equatable {
    /* nil for a plain item; true or false for a task list's checkbox. */
    public let check: Bool?
    public let blocks: [MarkdownBlock]
}

public struct MarkdownTable: Sendable, Equatable {
    public enum Alignment: Sendable, Equatable { case leading, center, trailing }
    public let alignments: [Alignment]
    public let head: [MarkdownInline]
    public let rows: [[MarkdownInline]]
}
