import HushOSKit
import SwiftUI
import UIKit

/*
 * The text editor's Markdown preview (docs/editing-design.md, "As built: the Markdown preview"): the viewer's blocks
 * (MarkdownBlockView: raw HTML dropped, links only on a tap, images named and never fetched), not selectable (a copy
 * would skip the editor's local-only, expiring one). Each block is placed by the source lines it came from, so the
 * preview and the source scroll together (EditorScroll).
 */
struct EditorPreviewPane: View {
    let pieces: [MarkdownPiece]?
    @Binding var position: ScrollPosition
    let scroll: EditorScroll

    var body: some View {
        ScrollView {
            if let pieces {
                LazyVStack(alignment: .leading, spacing: Alpine.Space.s4) {
                    ForEach(Array(pieces.enumerated()), id: \.offset) { index, piece in
                        MarkdownBlockView(block: piece.block)
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(EditorScroll.space)) } action: { frame in
                                scroll.frames[index] = frame.minY..<max(frame.maxY, frame.minY + 1)
                            }
                    }
                }
                .padding(.horizontal, Alpine.Space.s4)
                .padding(.vertical, Alpine.Space.s6)
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity)
                .coordinateSpace(.named(EditorScroll.space))
                .textSelection(.disabled)
            } else {
                ProgressView().tint(Alpine.primary).padding(.top, Alpine.Space.s12)
            }
        }
        .scrollPosition($position)
        .onScrollPhaseChange { _, phase in scroll.previewHeld = phase == .tracking || phase == .interacting || phase == .decelerating }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, top in
            scroll.previewScrolled(to: top)
        }
        .background(Alpine.ground)
        .tint(Alpine.primary)
    }
}

/*
 * The source (the editor's UITextView) and the preview scrolled together. Only a person's scroll leads: a drag, a
 * fling's glide, or the text view keeping the cursor in view as it is typed (followed after each render). A scroll this
 * makes itself (setContentOffset, or the preview's position) is never a person's, so it never comes back to move the
 * pane that led. Positions are source lines (TextLines, LineMap in HushOSKit): the line at the top of the source, and the
 * block at the top of the preview and how far down it.
 */
@MainActor final class EditorScroll {
    nonisolated static let space = "editor-preview"

    /* The editor's text box: its text view is read when asked, since SwiftUI makes it after the text opens. */
    weak var box: TextBox?
    var textView: UITextView? { box?.view }
    /* The preview's blocks by line, from the last render. */
    var map: LineMap?
    /* Where each rendered block sits in the preview's content, as laid out so far (a lazy stack lays out what is near). */
    var frames: [Int: Range<CGFloat>] = [:]
    /* A person is scrolling the preview (dragging it, or its fling still gliding). */
    var previewHeld = false
    /* Side by side: each moves the other. Otherwise only a switch's kept place. */
    var linked = false
    /* Moves the preview: to a y when its block has been laid out, else to the block. */
    var movePreview: (PreviewTarget) -> Void = { _ in }

    enum PreviewTarget: Equatable {
        case y(CGFloat)
        case block(Int)
    }

    private var lines: TextLines?
    private var linesOf = -1
    /* Bumped by every edit: the line starts are counted again when next asked. */
    var revision = 0

    private func textLines(_ view: UITextView) -> TextLines {
        if let lines, linesOf == revision { return lines }
        let counted = TextLines(view.text)
        lines = counted
        linesOf = revision
        return counted
    }

    /* The fractional source line at the top of the text view. */
    func sourceLine() -> Double? {
        guard let view = textView else { return nil }
        let top = view.contentOffset.y + view.adjustedContentInset.top
        if top <= 0 { return 1 }
        let lines = textLines(view)
        guard let position = view.closestPosition(to: CGPoint(x: view.textContainerInset.left + 1, y: top + 1)) else { return nil }
        let line = lines.line(at: view.offset(from: view.beginningOfDocument, to: position))
        let (lineTop, nextTop) = bounds(of: line, in: view, lines: lines)
        let fraction = nextTop > lineTop ? Double((top - lineTop) / (nextTop - lineTop)) : 0
        return Double(line) + min(max(fraction, 0), 0.999)
    }

    /* Puts `line` at the top of the text view. */
    func showSource(_ line: Double) {
        guard let view = textView else { return }
        let lines = textLines(view)
        let whole = min(max(Int(line), 1), lines.count)
        let (lineTop, nextTop) = bounds(of: whole, in: view, lines: lines)
        let fraction = CGFloat(min(max(line - Double(whole), 0), 1))
        let inset = view.adjustedContentInset
        let most = max(-inset.top, view.contentSize.height - view.bounds.height + inset.bottom)
        let y = min(max(lineTop + fraction * (nextTop - lineTop) - inset.top, -inset.top), most)
        view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: false)
    }

    /* The top of a line and of the next, in the text view's content. */
    private func bounds(of line: Int, in view: UITextView, lines: TextLines) -> (CGFloat, CGFloat) {
        func top(_ offset: Int) -> CGFloat? {
            view.position(from: view.beginningOfDocument, offset: offset).map { view.caretRect(for: $0).minY }
        }
        let lineTop = top(lines.start(of: line)) ?? 0
        let nextTop = line < lines.count ? top(lines.start(of: line + 1)) ?? lineTop : view.contentSize.height
        return (lineTop, max(nextTop, lineTop))
    }

    /* The fractional source line at the preview's top `y`, from the blocks laid out there. */
    func previewLine(at y: CGFloat) -> Double? {
        guard let map, let (index, frame) = frames.filter({ $0.value.lowerBound <= y }).max(by: { $0.value.lowerBound < $1.value.lowerBound }) else {
            return y <= 0 ? 1 : nil
        }
        let height = frame.upperBound - frame.lowerBound
        return map.line(index: index, fraction: height > 0 ? Double((y - frame.lowerBound) / height) : 0)
    }

    /* Where the preview goes to show `line` at its top. */
    func previewTarget(for line: Double) -> PreviewTarget? {
        guard let map, let place = map.place(line) else { return nil }
        if line <= 1 { return .y(0) }
        guard let frame = frames[place.index] else { return .block(place.index) }
        return .y(frame.lowerBound + CGFloat(place.fraction) * (frame.upperBound - frame.lowerBound))
    }

    /* The person scrolled the source (or typed, and it kept the cursor in view): the preview follows. */
    func sourceScrolled() {
        guard linked, let line = sourceLine(), let target = previewTarget(for: line) else { return }
        movePreview(target)
    }

    /* The preview moved: when a person moved it, the source follows. */
    func previewScrolled(to y: CGFloat) {
        previewTop = y
        guard linked, previewHeld, let line = previewLine(at: y) else { return }
        showSource(line)
    }

    /* A new rendering: the old blocks' places are gone. */
    func rendered(_ pieces: [MarkdownPiece], lines: Int) {
        map = LineMap(pieces: pieces, lines: lines)
        // Blocks past the new end are gone; the rest keep their last places until laid out again.
        frames = frames.filter { $0.key < pieces.count }
    }

    /* A rendering is on its way; `again`: the text changed meanwhile, so one more follows it. */
    var rendering = false
    var again = false
    /* The preview's top, as last scrolled to. */
    var previewTop: CGFloat = 0
    /* A narrow switch's line, until the pane switched to can be put there. */
    var kept: Double?
}
