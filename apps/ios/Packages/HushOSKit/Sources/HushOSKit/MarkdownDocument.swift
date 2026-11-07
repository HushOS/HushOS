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
        if depth(of: text) > maxDepth { return cut(.code(language: nil, text: text)) }
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
        // Depth by ancestry, not by counting enters and exits: cmark exits empty containers (a bare `#`) it never
        // reported as having children, so a counter drifts. Entered nodes still open form a stack; each new node pops
        // back to its own parent first.
        var open: [UnsafeMutablePointer<cmark_node>] = []
        var deepest = 0
        while true {
            let event = cmark_iter_next(iterator)
            if event == CMARK_EVENT_DONE { break }
            guard event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator) else { continue }
            let parent = cmark_node_parent(node)
            while let top = open.last, top != parent { open.removeLast() }
            open.append(node)
            deepest = max(deepest, open.count)
        }
        return deepest
    }

    private static func blocks(of children: MarkupChildren, depth: Int) -> [MarkdownBlock] {
        children.compactMap { block($0, depth: depth) }.flatMap(cut)
    }

    /*
     * The most one block holds before it is cut into consecutive ones: the viewer lays out a block at a time and only
     * those on screen, and one 1.5 MB paragraph as a single text held the main thread. A table chunk repeats its head;
     * a cell past cellChars is shortened with "…" (Share shows the file whole). Android cuts at the same places.
     */
    static let paragraphChars = 4000
    static let codeLines = 200
    static let tableRows = 200
    static let cellChars = 2000
    /*
     * The most a list or quote holds before it is cut into consecutive ones, in weight (one per block, one per table row,
     * one per charsPerWeight characters): its children are laid out together, so 100,000 `- item` lines as one list
     * would freeze the viewer as one paragraph had. An item too heavy for one piece goes on in the next without its marker.
     */
    static let blockWeight = 200
    static let charsPerWeight = 200
    /*
     * A table piece holds at most tableCells cells (tableRows rows of a narrow table, fewer of a wide one), and a table
     * shows at most tableColumns columns, the rest standing as one "…" column: its grid is laid out whole, and a 9 KB
     * file of 1,000 empty columns makes hundreds of thousands of cells. An image counts as at least imageChars, so a
     * paragraph of empty-alt images (each drawn as a mark and a word) is cut too.
     */
    static let tableCells = 4000
    static let tableColumns = 50
    static let imageChars = 20

    static func cut(_ block: MarkdownBlock) -> [MarkdownBlock] {
        switch block {
        case .paragraph(let inline): return cutInline(inline).map { .paragraph($0) }
        case let .heading(level, inline): return cutInline(inline).map { .heading(level: level, $0) }
        case .quote(let blocks): return weight(block) <= blockWeight ? [block] : pack(blocks, room: blockWeight - 1).map { .quote($0) }
        case .list(let list): return weight(block) <= blockWeight ? [block] : cutList(list)
        case let .code(language, text): return cutCode(text).map { .code(language: language, text: $0) }
        case .table(let table):
            let narrow = narrow(table)
            let short = MarkdownTable(alignments: narrow.alignments, head: narrow.head.map(shortCell), rows: narrow.rows.map { $0.map(shortCell) })
            let rows = min(tableRows, max(1, tableCells / max(1, short.head.count)))
            guard short.rows.count > rows else { return [.table(short)] }
            return stride(from: 0, to: short.rows.count, by: rows).map { start in
                .table(MarkdownTable(alignments: short.alignments, head: short.head, rows: Array(short.rows[start..<min(start + rows, short.rows.count)])))
            }
        default: return [block]
        }
    }

    /* At most tableColumns columns: past that, one "…" column stands for the rest (Share shows the file whole). */
    private static func narrow(_ table: MarkdownTable) -> MarkdownTable {
        guard table.head.count > tableColumns else { return table }
        let more = MarkdownInline(runs: [.text(AttributedString("…"))])
        func keep(_ cells: [MarkdownInline]) -> [MarkdownInline] { Array(cells.prefix(tableColumns)) + [more] }
        return MarkdownTable(alignments: Array(table.alignments.prefix(tableColumns)) + [.leading], head: keep(table.head), rows: table.rows.map(keep))
    }

    /* How much laying a block out costs, roughly: see blockWeight. Its children were cut first, so each is bounded. */
    static func weight(_ block: MarkdownBlock) -> Int {
        switch block {
        case .heading(_, let inline), .paragraph(let inline): return 1 + inline.length / charsPerWeight
        case .code(_, let text): return 1 + text.count / charsPerWeight
        case .table(let table): return 1 + (table.rows.count + 1) * table.head.count / 20
        case .quote(let blocks): return 1 + blocks.reduce(0) { $0 + weight($1) }
        case .list(let list): return 1 + list.items.reduce(0) { $0 + weight($1) }
        case .rule: return 1
        }
    }

    private static func weight(_ item: MarkdownListItem) -> Int { 1 + item.blocks.reduce(0) { $0 + weight($1) } }

    /* Consecutive blocks in groups of at most `room` (a heavier block alone): the room a container leaves past its own 1. */
    private static func pack(_ blocks: [MarkdownBlock], room: Int) -> [[MarkdownBlock]] {
        var groups: [[MarkdownBlock]] = []
        var current: [MarkdownBlock] = []
        var total = 0
        for block in blocks {
            let each = weight(block)
            if !current.isEmpty, total + each > room { groups.append(current); current = []; total = 0 }
            current.append(block)
            total += each
        }
        if !current.isEmpty { groups.append(current) }
        return groups
    }

    /*
     * A list in pieces of at most blockWeight, numbered on. A heavy item's blocks go into several items, the later ones
     * `continued` (no marker); greedy packing never lets two parts of one item share a piece, so a continued item only
     * ever comes first, and each piece's items number from its start.
     */
    private static func cutList(_ list: MarkdownList) -> [MarkdownBlock] {
        let parts = list.items.flatMap { item -> [MarkdownListItem] in
            if weight(item) <= blockWeight - 1 { return [item] }
            return pack(item.blocks, room: blockWeight - 2).enumerated().map { index, blocks in
                MarkdownListItem(check: index == 0 ? item.check : nil, blocks: blocks, continued: index > 0)
            }
        }
        var pieces: [MarkdownBlock] = []
        var current: [MarkdownListItem] = []
        var total = 0
        var number = list.start
        var start = number
        for part in parts {
            let each = weight(part)
            if !current.isEmpty, total + each > blockWeight - 1 {
                pieces.append(.list(MarkdownList(ordered: list.ordered, start: start, items: current))); current = []; total = 0
            }
            if current.isEmpty { start = part.continued ? number - 1 : number }
            current.append(part)
            total += each
            if !part.continued { number += 1 }
        }
        if !current.isEmpty { pieces.append(.list(MarkdownList(ordered: list.ordered, start: start, items: current))) }
        return pieces
    }

    /* A paragraph's runs in pieces of at most paragraphChars, cut at a space where there is one; linear in its length. */
    private static func cutInline(_ inline: MarkdownInline) -> [MarkdownInline] {
        guard inline.length > paragraphChars else { return [inline] }
        var pieces: [MarkdownInline] = []
        var current: [MarkdownInline.Run] = []
        var length = 0
        func close() {
            if !current.isEmpty { pieces.append(MarkdownInline(runs: current)) }
            current = []
            length = 0
        }
        for run in inline.runs {
            guard case .text(let text) = run else {
                if case let .image(alt, _) = run {
                    let cost = max(alt.count, imageChars)
                    if length + cost > paragraphChars { close() }
                    current.append(run)
                    length += cost
                }
                continue
            }
            let characters = text.characters
            var start = characters.startIndex
            var remaining = characters.count
            while length + remaining > paragraphChars {
                let limit = characters.index(start, offsetBy: paragraphChars - length)
                var space: AttributedString.Index?
                var index = limit
                while index > start {
                    let before = characters.index(before: index)
                    if characters[before] == " " { space = before; break }
                    index = before
                }
                // No space to cut at in this run: a whole new piece if this one has words, else a hard cut.
                let at = space ?? (length > 0 ? start : limit)
                if at > start { current.append(.text(AttributedString(text[start..<at]))) }
                var next = at
                while next < characters.endIndex, characters[next] == " " { next = characters.index(after: next) }
                remaining -= characters.distance(from: start, to: next)
                start = next
                close()
            }
            if start < characters.endIndex {
                current.append(.text(AttributedString(text[start...])))
                length += remaining
            }
        }
        close()
        return pieces
    }

    /* Code in pieces of at most codeLines lines and paragraphChars characters; a longer line is cut where it must be. */
    private static func cutCode(_ text: String) -> [String] {
        var pieces: [String] = []
        var piece = ""
        var count = 0, lines = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var segments: [Substring] = []
            var rest = line[...]
            repeat {
                let end = rest.index(rest.startIndex, offsetBy: paragraphChars, limitedBy: rest.endIndex) ?? rest.endIndex
                segments.append(rest[rest.startIndex..<end])
                rest = rest[end...]
            } while !rest.isEmpty
            for segment in segments {
                if lines > 0, lines >= codeLines || count + 1 + segment.count > paragraphChars {
                    pieces.append(piece); piece = ""; count = 0; lines = 0
                }
                if lines > 0 { piece += "\n"; count += 1 }
                piece += segment
                count += segment.count
                lines += 1
            }
        }
        if lines > 0 { pieces.append(piece) }
        return pieces
    }

    private static func shortCell(_ cell: MarkdownInline) -> MarkdownInline {
        guard cell.length > cellChars else { return cell }
        var runs: [MarkdownInline.Run] = []
        var left = cellChars
        for run in cell.runs where left > 0 {
            switch run {
            case .text(let text):
                let characters = text.characters
                let end = characters.index(characters.startIndex, offsetBy: left, limitedBy: characters.endIndex) ?? characters.endIndex
                runs.append(.text(AttributedString(text[characters.startIndex..<end])))
                left -= characters.distance(from: characters.startIndex, to: end)
            case let .image(alt, _):
                runs.append(run)
                left -= max(alt.count, imageChars)
            }
        }
        runs.append(.text(AttributedString(" …")))
        return MarkdownInline(runs: runs)
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
                // Its alt text bounded, so a paragraph's pieces stay bounded too (cutInline never cuts inside an image).
                let alt = image.plainText
                runs.append(.image(alt: alt.count > cellChars ? String(alt.prefix(cellChars)) + " …" : alt, source: image.source))
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

    /* Its length as cutting counts it: characters, and an image at least MarkdownDocument.imageChars. */
    public var length: Int {
        runs.reduce(0) { total, run in
            switch run {
            case .text(let text): total + text.characters.count
            case .image(let alt, _): total + max(alt.count, MarkdownDocument.imageChars)
            }
        }
    }

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
    /* The rest of the item before it, cut off with its list (MarkdownDocument.cutList): drawn without a marker, not numbered. */
    public var continued = false
}

public struct MarkdownTable: Sendable, Equatable {
    public enum Alignment: Sendable, Equatable { case leading, center, trailing }
    public let alignments: [Alignment]
    public let head: [MarkdownInline]
    public let rows: [[MarkdownInline]]
}
