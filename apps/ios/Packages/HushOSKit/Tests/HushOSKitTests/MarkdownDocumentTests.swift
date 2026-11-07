import Foundation
import Testing
@testable import HushOSKit

/* The Markdown viewer's rules: what a document may make the phone do, and what it says. */
struct MarkdownDocumentTests {
    private func paragraph(_ source: String) -> MarkdownInline? {
        if case .paragraph(let inline) = MarkdownDocument.parse(source).first { return inline }
        return nil
    }

    private func links(_ inline: MarkdownInline) -> [URL] {
        inline.runs.flatMap { run -> [URL] in
            guard case .text(let text) = run else { return [] }
            return text.runs.compactMap { $0.link }
        }
    }

    @Test func onlyWebAndMailLinksAreLinks() throws {
        let inline = try #require(paragraph("[a](https://example.com) [b](javascript:alert(1)) [c](file:///etc/passwd) [d](./notes.md) [e](mailto:sam@example.com)"))
        #expect(links(inline).map(\.absoluteString) == ["https://example.com", "mailto:sam@example.com"])
        // The words of a refused link stay, without the link.
        #expect(inline.plainText.contains("b"))
    }

    @Test func anImageIsNamedNotFetched() throws {
        let inline = try #require(paragraph("Look ![the tracker](https://tracker.example/pixel.png) here"))
        #expect(inline.runs.contains(.image(alt: "the tracker", source: "https://tracker.example/pixel.png")))
        // Nothing about the image is a link the viewer would open or load.
        #expect(links(inline).isEmpty)
    }

    @Test func rawHTMLIsDroppedNotShown() {
        let blocks = MarkdownDocument.parse("<script>alert(1)</script>\n\nSafe <img src=x onerror=alert(1)> text")
        #expect(blocks.count == 1)
        guard case .paragraph(let inline) = blocks.first else { Issue.record("expected a paragraph"); return }
        #expect(!inline.plainText.contains("<"))
        #expect(inline.plainText.contains("Safe"))
    }

    @Test func taskListsKeepTheirBoxes() {
        guard case .list(let list) = MarkdownDocument.parse("- [x] done\n- [ ] to do\n- plain").first else {
            Issue.record("expected a list"); return
        }
        #expect(list.items.map(\.check) == [true, false, nil])
    }

    @Test func tablesKeepCellsAndAlignment() {
        guard case .table(let table) = MarkdownDocument.parse("| Name | Size |\n| :-- | --: |\n| a.txt | 2 KB |").first else {
            Issue.record("expected a table"); return
        }
        #expect(table.head.map(\.plainText) == ["Name", "Size"])
        #expect(table.alignments == [.leading, .trailing])
        #expect(table.rows.map { $0.map(\.plainText) } == [["a.txt", "2 KB"]])
    }

    @Test func orderedListsKeepTheirStart() {
        guard case .list(let list) = MarkdownDocument.parse("3. three\n4. four").first else { Issue.record("expected a list"); return }
        #expect(list.ordered && list.start == 3 && list.items.count == 2)
    }

    @Test func deepNestingKeepsItsWordsWithoutCrashing() {
        // Nesting past what a stack holds comes back as the file's text, never a crash.
        let source = String(repeating: "> ", count: 50_000) + "hello"
        #expect(asText(MarkdownDocument.parse(source)) == source)
        let emphasis = String(repeating: "*a ", count: 20_000) + "deep" + String(repeating: " a*", count: 20_000)
        #expect(asText(MarkdownDocument.parse(emphasis)) == emphasis)
        // The check parses as swift-markdown does: an autolink (which it doesn't make) mustn't hide the emphasis inside.
        let linked = "https://example.com/" + String(repeating: "*a/", count: 5000) + "deep" + String(repeating: "/a*", count: 5000)
        #expect(asText(MarkdownDocument.parse(linked)) == linked)
        // Empty headings before the nesting mustn't throw the measure off.
        let headed = String(repeating: "#\n\n", count: 5000) + String(repeating: "> ", count: 5000) + "x"
        #expect(asText(MarkdownDocument.parse(headed)) == headed.filter { $0 != "\n" })

        // Within the limit it is drawn, and past the drawing budget the words come as plain text.
        var level = MarkdownDocument.parse(String(repeating: "> ", count: 40) + "hello")
        var depth = 0
        while case .quote(let inner) = level.first { depth += 1; level = inner }
        #expect(depth == MarkdownDocument.blockDepth)
        guard case .paragraph(let words) = level.first else { Issue.record("expected the words"); return }
        #expect(words.plainText == "hello")
    }

    /* Code blocks only, joined as they were cut: what a too-deep file shows. Nil if anything else came back. */
    private func asText(_ blocks: [MarkdownBlock]) -> String? {
        var pieces: [String] = []
        for block in blocks { guard case .code(_, let text) = block else { return nil }; pieces.append(text) }
        // Pieces cut at a line lose the break between them (they are drawn one under the other), so lines don't count.
        return pieces.joined().filter { $0 != "\n" }
    }

    @Test func bigBlocksComeInPiecesTheViewerCanLayOutOneAtATime() {
        // A 1.5 MB paragraph as one text held the main thread: it comes as paragraphs of at most the limit, cut between
        // words, with every word kept.
        let words = (0..<150_000).map { "word\($0)" }
        var paragraphs: [MarkdownInline] = []
        for block in MarkdownDocument.parse(words.joined(separator: " ")) {
            guard case .paragraph(let inline) = block else { Issue.record("expected paragraphs"); return }
            paragraphs.append(inline)
        }
        #expect(paragraphs.count > 1)
        #expect(paragraphs.allSatisfy { $0.plainText.count <= MarkdownDocument.paragraphChars })
        #expect(paragraphs.flatMap { $0.plainText.split(separator: " ").map(String.init) } == words)

        let code = MarkdownDocument.parse("```\n" + (1...1000).map { "line \($0)" }.joined(separator: "\n") + "\n```")
        #expect(code.count == 5)
        let line = MarkdownDocument.parse("```\n" + String(repeating: "y", count: 300_000) + "\n```")
        #expect(line.allSatisfy { if case .code(_, let text) = $0 { text.count <= MarkdownDocument.paragraphChars } else { false } })
        #expect(asText(line)?.count == 300_000)

        let tables = MarkdownDocument.parse("| A | B |\n| - | - |\n" + (1...450).map { "| \($0) | x |" }.joined(separator: "\n"))
        var sizes: [Int] = []
        for block in tables {
            guard case .table(let table) = block else { Issue.record("expected tables"); return }
            // Each piece keeps the head, so a column is never left unnamed.
            #expect(table.head.map(\.plainText) == ["A", "B"])
            sizes.append(table.rows.count)
        }
        #expect(sizes == [200, 200, 50])

        guard case .table(let wide) = MarkdownDocument.parse("| A |\n| - |\n| " + String(repeating: "x", count: 300_000) + " |").first,
              let cell = wide.rows.first?.first else { Issue.record("expected a table"); return }
        #expect(cell.plainText.count <= MarkdownDocument.cellChars + 2 && cell.plainText.hasSuffix("…"))

        // A heading is cut as a paragraph is, every piece at its level.
        let heading = MarkdownDocument.parse("## " + words.prefix(20_000).joined(separator: " "))
        #expect(heading.count > 1)
        #expect(heading.allSatisfy { if case let .heading(2, inline) = $0 { inline.length <= MarkdownDocument.paragraphChars } else { false } })

        // A long image description followed by text crashed the cutting (an index before the run's start); now the
        // description is shortened and every piece stays within the limit.
        let pictured = MarkdownDocument.parse("![" + String(repeating: "a", count: 5000) + "](x.png) " + words.prefix(2000).joined(separator: " "))
        #expect(pictured.allSatisfy { if case .paragraph(let inline) = $0 { inline.length <= MarkdownDocument.paragraphChars } else { false } })
        guard case .paragraph(let first) = pictured.first, case .image(let alt, _) = first.runs.first else { Issue.record("expected an image"); return }
        #expect(alt.hasSuffix("…"))

        // Images without words are each drawn as a mark: 10,000 of them aren't one paragraph.
        let marks = MarkdownDocument.parse(String(repeating: "![](x) ", count: 10_000))
        #expect(marks.count > 1)
        #expect(marks.allSatisfy { if case .paragraph(let inline) = $0 { inline.length <= MarkdownDocument.paragraphChars } else { false } })

        // A 1,000-column table: 50 columns and a "…" one, in pieces of a bounded number of cells.
        let wideTable = MarkdownDocument.parse("|" + String(repeating: " c |", count: 1000) + "\n|" + String(repeating: " - |", count: 1000) + "\n" + String(repeating: "| x |\n", count: 200))
        var rowsSeen = 0
        for block in wideTable {
            guard case .table(let table) = block else { Issue.record("expected tables"); return }
            #expect(table.head.count == MarkdownDocument.tableColumns + 1 && table.head.last?.plainText == "…")
            #expect((table.rows.count + 1) * table.head.count <= MarkdownDocument.tableCells + table.head.count)
            rowsSeen += table.rows.count
        }
        #expect(rowsSeen == 200)
    }

    @Test func bigListsAndQuotesComeInPiecesNumberedOn() {
        // 100,000 items as one list would lay out every row at once; in pieces, each no heavier than the limit, numbered on.
        let lists = MarkdownDocument.parse((1...100_000).map { "\($0). item \($0)" }.joined(separator: "\n")).compactMap { block -> MarkdownList? in
            if case .list(let list) = block { list } else { nil }
        }
        #expect(lists.count > 1)
        #expect(lists.allSatisfy { MarkdownDocument.weight(.list($0)) <= MarkdownDocument.blockWeight })
        let numbered = lists.flatMap { list in
            list.items.enumerated().map { index, item -> String in
                guard case .paragraph(let inline) = item.blocks.first else { return "?" }
                return "\(list.start + index):\(inline.plainText)"
            }
        }
        #expect(numbered == (1...100_000).map { "\($0):item \($0)" })

        // One item holding a huge list: its rest goes on in later pieces, unmarked, and the next item keeps its number.
        let nested = MarkdownDocument.parse("1. outer\n" + (1...5000).map { "   - inner \($0)" }.joined(separator: "\n") + "\n2. after")
            .compactMap { block -> MarkdownList? in if case .list(let list) = block { list } else { nil } }
        #expect(nested.count > 1)
        #expect(nested.allSatisfy { MarkdownDocument.weight(.list($0)) <= MarkdownDocument.blockWeight + 2 * MarkdownDocument.blockDepth })
        #expect(nested.dropFirst().allSatisfy { $0.items.first?.continued == true })
        #expect(nested.allSatisfy { !$0.items.dropFirst().contains(where: \.continued) })
        if let last = nested.last, let after = last.items.firstIndex(where: { !$0.continued }) { #expect(last.start + after == 2) }
        else { Issue.record("expected the second item") }

        // A quote of many paragraphs, likewise.
        let quotes = MarkdownDocument.parse((1...5000).map { "> line \($0)" }.joined(separator: "\n>\n"))
        #expect(quotes.count > 1)
        #expect(quotes.allSatisfy { if case .quote = $0 { MarkdownDocument.weight($0) <= MarkdownDocument.blockWeight } else { false } })
        let lines = quotes.flatMap { block -> [String] in
            guard case .quote(let inner) = block else { return [] }
            return inner.compactMap { if case .paragraph(let inline) = $0 { inline.plainText } else { nil } }
        }
        #expect(lines == (1...5000).map { "line \($0)" })
    }

    @Test func markdownFilesByNameOrType() {
        #expect(MarkdownDocument.handles(name: "README.md", mime: nil))
        #expect(MarkdownDocument.handles(name: "notes.MARKDOWN", mime: nil))
        #expect(MarkdownDocument.handles(name: "notes", mime: "text/markdown"))
        #expect(!MarkdownDocument.handles(name: "notes.txt", mime: "text/plain"))
    }
}
