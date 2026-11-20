import Foundation

/*
 * The text editor's Markdown source and preview side by side (docs/editing-design.md, "As built: the Markdown preview"):
 * when the window is wide, the iPhone Duo's inner display or a wide window, decided from the size class and the room the
 * editor has, never the screen or the device. Narrower, the Source/Preview switch.
 */
public enum SideBySide {
    /* The narrowest editor that holds both: each pane about as wide as a phone held upright in Split View. */
    public static let minWidth: Double = 600

    public static func shows(regularWidth: Bool, width: Double) -> Bool {
        regularWidth && width >= minWidth
    }
}

/*
 * The preview's blocks by the source lines they came from (MarkdownDocument.parseLined): block i covers the lines from its
 * start up to the next block's, the blank lines after it included, and the last runs to the end of the file. A position
 * in either pane is a fractional source line (12.5: halfway down line 12); the preview's is a block and how far down it.
 */
public struct LineMap: Sendable, Equatable {
    public let starts: [Double]
    /* One past the file's last line. */
    public let end: Double

    public init(starts: [Double], lines: Int) {
        self.starts = starts
        end = max(Double(lines + 1), (starts.last ?? 1) + 1)
    }

    public init(pieces: [MarkdownPiece], lines: Int) {
        self.init(starts: pieces.map(\.start), lines: lines)
    }

    /* The block holding `line` and how far down it (0 at its first line, towards 1 at the next block's); nil with no blocks. */
    public func place(_ line: Double) -> (index: Int, fraction: Double)? {
        guard !starts.isEmpty else { return nil }
        var low = 0, high = starts.count - 1, found = 0
        if line < starts[0] { return (0, 0) }
        while low <= high {
            let middle = (low + high) / 2
            if starts[middle] <= line { found = middle; low = middle + 1 } else { high = middle - 1 }
        }
        let next = found + 1 < starts.count ? starts[found + 1] : end
        let span = next - starts[found]
        return (found, span > 0 ? min(max((line - starts[found]) / span, 0), 1) : 0)
    }

    /* The source line at `fraction` of the way down block `index`: the inverse of place. */
    public func line(index: Int, fraction: Double) -> Double? {
        guard starts.indices.contains(index) else { return nil }
        let next = index + 1 < starts.count ? starts[index + 1] : end
        return starts[index] + min(max(fraction, 0), 1) * (next - starts[index])
    }
}

/* Where each line of a text starts, in UTF-16 offsets (what a text view counts in): a line by offset and back. */
public struct TextLines: Sendable, Equatable {
    public let starts: [Int]
    public let length: Int

    public init(_ text: String) {
        var starts = [0]
        var offset = 0
        for unit in text.utf16 {
            offset += 1
            if unit == 0x0A { starts.append(offset) }
        }
        self.starts = starts
        length = offset
    }

    /* The 1-based line holding `offset`. */
    public func line(at offset: Int) -> Int {
        var low = 0, high = starts.count - 1, found = 0
        while low <= high {
            let middle = (low + high) / 2
            if starts[middle] <= offset { found = middle; low = middle + 1 } else { high = middle - 1 }
        }
        return found + 1
    }

    /* Where 1-based `line` starts, held to the text's lines. */
    public func start(of line: Int) -> Int {
        starts[min(max(line, 1), starts.count) - 1]
    }

    public var count: Int { starts.count }
}
