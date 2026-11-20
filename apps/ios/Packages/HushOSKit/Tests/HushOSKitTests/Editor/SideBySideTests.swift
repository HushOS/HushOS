import Foundation
import Testing
@testable import HushOSKit

/*
 * The editor's Markdown source and preview side by side, and how they scroll together. Fails if the iPhone Duo's inner
 * display keeps the switch (or the outer display, or a narrow window, loses it), if a preview block names the wrong source
 * lines (the preview would sit on the wrong paragraph), or if a line maps to a place that doesn't map back to it.
 */
@Suite struct SideBySideTests {
    @Test func theInnerDisplayShowsBothAndTheOuterDisplayTheSwitch() {
        // The inner display upright (669 points) and on its side (951), regular width either way.
        #expect(SideBySide.shows(regularWidth: true, width: 669))
        #expect(SideBySide.shows(regularWidth: true, width: 951))
        // The outer display, and any iPhone upright: compact width.
        #expect(!SideBySide.shows(regularWidth: false, width: 402))
        // An iPhone on its side is wide but compact: the switch.
        #expect(!SideBySide.shows(regularWidth: false, width: 874))
        // Regular width but too narrow for two panes (a narrow window beside another app).
        #expect(!SideBySide.shows(regularWidth: true, width: 507))
    }

    @Test func eachBlockStartsAtItsSourceLine() {
        let text = """
        # Title

        A paragraph
        over two lines.

        - one
        - two

        ```
        code
        ```

        > quoted
        """
        let starts = MarkdownDocument.parseLined(text).map(\.start)
        #expect(starts == [1, 3, 6, 9, 13])
        // And the blocks are the viewer's, in the same order.
        #expect(MarkdownDocument.parseLined(text).map(\.block) == MarkdownDocument.parse(text))
    }

    @Test func aBlockCutInPiecesSharesItsLinesOut() {
        // One paragraph on line 3 too long to lay out at once: cut in three, sharing lines 3 to 4.
        let words = String(repeating: "word ", count: MarkdownDocument.paragraphChars * 2 / 5 + 10)
        let pieces = MarkdownDocument.parseLined("# Title\n\n\(words)\n")
        #expect(pieces.count == 4)
        #expect(pieces[1].start == 3)
        #expect(abs(pieces[2].start - (3 + 1.0 / 3)) < 1e-9)
        #expect(abs(pieces[3].start - (3 + 2.0 / 3)) < 1e-9)
    }

    @Test func aLineFindsItsBlockAndComesBack() throws {
        // Blocks at lines 1, 3 and 6 of a nine-line file.
        let map = LineMap(starts: [1, 3, 6], lines: 9)
        let heading = try #require(map.place(1.5))
        #expect(heading.index == 0 && heading.fraction == 0.25)
        // A blank line between two blocks belongs to the one before.
        let blank = try #require(map.place(5.5))
        #expect(blank.index == 1 && blank.fraction == 5.0 / 6)
        let last = try #require(map.place(8))
        #expect(last.index == 2 && last.fraction == 0.5)
        for line in [1.0, 2.25, 3.5, 5.9, 6, 9.5] {
            let place = try #require(map.place(line))
            #expect(abs(try #require(map.line(index: place.index, fraction: place.fraction)) - line) < 1e-9)
        }
        // Above the first block (blank lines at the top of the file): its top.
        let early = try #require(LineMap(starts: [4], lines: 6).place(2))
        #expect(early.index == 0 && early.fraction == 0)
        #expect(LineMap(starts: [], lines: 3).place(2) == nil)
    }

    @Test func textLinesCountInUTF16() {
        // An emoji is two UTF-16 units, as a text view counts.
        let lines = TextLines("a😀\nb\n\nlast")
        #expect(lines.count == 4)
        #expect(lines.start(of: 2) == 4)
        #expect(lines.line(at: 3) == 1)
        #expect(lines.line(at: 4) == 2)
        #expect(lines.line(at: 7) == 4)
        #expect(lines.start(of: 99) == 7)
    }
}
