import Foundation
import Markdown
import cmark_gfm
import cmark_gfm_extensions

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

    /*
     * How deep quotes and lists, and emphasis and links, are drawn as such. A file nested deeper (a few KB of "> " does
     * it) would overflow the stack in the recursive steps below and in the view; past this its words come as plain text.
     */
    static let blockDepth = 16
    static let inlineDepth = 32

    /*
     * Deeper than this and the file is shown as its text. swift-markdown builds its tree by recursion, and a background
     * thread's stack holds a few thousand levels: a few KB of "> " crashed the app before any of our code ran. cmark
     * itself parses without recursion, so the depth is measured on its tree first, with its iterator.
     */
    static let maxDepth = 64

    public static func parse(_ text: String) -> [MarkdownBlock] {
        if depth(of: text) > maxDepth { return [.code(language: nil, text: text)] }
        return blocks(of: Document(parsing: text).children, depth: 0)
    }

    /*
     * The deepest a node sits in the file's tree, parsed exactly as swift-markdown 0.9.0's `Document(parsing:)` parses it
     * (CommonMarkConverter.parseString: these options, these three extensions and no others). Any difference lets the
     * two trees differ: with autolink here, a link that swallows `*` measured 3 deep while swift-markdown built 5,002.
     * Check this again whenever swift-markdown moves (Package.swift pins it exactly).
     */
    static func depth(of text: String) -> Int {
        cmark_gfm_core_extensions_ensure_registered()
        guard let parser = cmark_parser_new(CMARK_OPT_TABLE_SPANS | CMARK_OPT_SMART | CMARK_OPT_SOURCEPOS) else { return .max }
        defer { cmark_parser_free(parser) }
        for name in ["table", "strikethrough", "tasklist"] {
            if let extensionPointer = cmark_find_syntax_extension(name) { cmark_parser_attach_syntax_extension(parser, extensionPointer) }
        }
        var utf8 = Array(text.utf8)
        utf8.withUnsafeMutableBufferPointer { buffer in
            buffer.baseAddress.map { $0.withMemoryRebound(to: CChar.self, capacity: buffer.count) { cmark_parser_feed(parser, $0, buffer.count) } }
        }
        guard let root = cmark_parser_finish(parser) else { return .max }
        defer { cmark_node_free(root) }
        guard let iterator = cmark_iter_new(root) else { return .max }
        defer { cmark_iter_free(iterator) }
        var depth = 0, deepest = 0
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            // A node with children is entered and exited; a leaf is only entered.
            if event == CMARK_EVENT_ENTER, cmark_node_first_child(cmark_iter_get_node(iterator)) != nil {
                depth += 1
                deepest = max(deepest, depth)
            } else if event == CMARK_EVENT_EXIT {
                depth -= 1
            }
        }
        return deepest
    }

    private static func blocks(of children: MarkupChildren, depth: Int) -> [MarkdownBlock] {
        children.compactMap { block($0, depth: depth) }
    }

    private static func block(_ markup: Markup, depth: Int) -> MarkdownBlock? {
        if depth >= blockDepth {
            let words = flatText(markup)
            return words.isEmpty ? nil : .paragraph(MarkdownInline(runs: [.text(AttributedString(words))]))
        }
        switch markup {
        case let heading as Heading: return .heading(level: heading.level, inline(heading.children))
        case let paragraph as Paragraph: return .paragraph(inline(paragraph.children))
        case let list as OrderedList: return .list(MarkdownList(ordered: true, start: Int(list.startIndex), items: items(list.listItems, depth: depth)))
        case let list as UnorderedList: return .list(MarkdownList(ordered: false, start: 1, items: items(list.listItems, depth: depth)))
        case let quote as BlockQuote: return .quote(blocks(of: quote.children, depth: depth + 1))
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

    private static func items(_ items: some Sequence<ListItem>, depth: Int) -> [MarkdownListItem] {
        items.map { item in
            MarkdownListItem(check: item.checkbox.map { $0 == .checked }, blocks: blocks(of: item.children, depth: depth + 1))
        }
    }

    /* The words under a node, walked with a stack of our own, not recursion: what a too-deep part shows. Raw HTML stays out. */
    static func flatText(_ root: Markup) -> String {
        var words = ""
        var stack: [Markup] = [root]
        while let node = stack.popLast() {
            switch node {
            case let plain as Markdown.Text: words += plain.string
            case let code as InlineCode: words += code.code
            case let code as CodeBlock: words += code.code
            case is SoftBreak, is LineBreak: words += " "
            case is InlineHTML, is HTMLBlock: break
            default:
                // Children pushed last-first, so they come off the stack in order; blocks are kept apart by a space.
                if node is BlockMarkup, !words.isEmpty, !words.hasSuffix(" ") { words += " " }
                stack.append(contentsOf: node.children.reversed())
            }
        }
        return words
    }

    /* A paragraph's runs: styled text, with images named in their own runs. */
    private static func inline(_ children: MarkupChildren) -> MarkdownInline {
        var runs: [MarkdownInline.Run] = []
        var text = AttributedString()
        func flush() {
            if !text.characters.isEmpty { runs.append(.text(text)) }
            text = AttributedString()
        }
        func walk(_ markup: Markup, _ intent: InlinePresentationIntent, _ link: URL?, _ depth: Int) {
            func styled(_ string: String, _ extra: InlinePresentationIntent = []) {
                var piece = AttributedString(string)
                let all = intent.union(extra)
                if !all.isEmpty { piece.inlinePresentationIntent = all }
                if let link { piece.link = link }
                text.append(piece)
            }
            if depth >= inlineDepth { styled(flatText(markup)); return }
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
                for child in anchor.children { walk(child, intent, target ?? link, depth + 1) }
            case is Emphasis: for child in markup.children { walk(child, intent.union(.emphasized), link, depth + 1) }
            case is Strong: for child in markup.children { walk(child, intent.union(.stronglyEmphasized), link, depth + 1) }
            case is Strikethrough: for child in markup.children { walk(child, intent.union(.strikethrough), link, depth + 1) }
            default: for child in markup.children { walk(child, intent, link, depth + 1) }
            }
        }
        for child in children { walk(child, [], nil, 0) }
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
