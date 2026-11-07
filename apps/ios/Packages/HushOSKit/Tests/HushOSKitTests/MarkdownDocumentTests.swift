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
        #expect(MarkdownDocument.parse(source) == [.code(language: nil, text: source)])
        let emphasis = String(repeating: "*a ", count: 20_000) + "deep" + String(repeating: " a*", count: 20_000)
        #expect(MarkdownDocument.parse(emphasis) == [.code(language: nil, text: emphasis)])

        // Within the limit it is drawn, and past the drawing budget the words come as plain text.
        var level = MarkdownDocument.parse(String(repeating: "> ", count: 40) + "hello")
        var depth = 0
        while case .quote(let inner) = level.first { depth += 1; level = inner }
        #expect(depth == MarkdownDocument.blockDepth)
        guard case .paragraph(let words) = level.first else { Issue.record("expected the words"); return }
        #expect(words.plainText == "hello")
    }

    @Test func markdownFilesByNameOrType() {
        #expect(MarkdownDocument.handles(name: "README.md", mime: nil))
        #expect(MarkdownDocument.handles(name: "notes.MARKDOWN", mime: nil))
        #expect(MarkdownDocument.handles(name: "notes", mime: "text/markdown"))
        #expect(!MarkdownDocument.handles(name: "notes.txt", mime: "text/plain"))
    }
}
