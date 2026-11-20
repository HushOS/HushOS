import Foundation
import Testing
@testable import HushOSKit

/* A picked folder becomes folders made parents first and files placed in them; hidden things stay behind. */
struct FolderPickPlanTests {
    /* Where each planned path sits, failing the test when one appears twice. */
    private func positions(_ plan: [[String]]) -> [[String]: Int] {
        var at: [[String]: Int] = [:]
        for (index, path) in plan.enumerated() {
            #expect(at[path] == nil, "\(path) planned twice")
            at[path] = index
        }
        return at
    }

    @Test func everyPrefixIsPlannedOnceAndParentsComeFirst() {
        let plan = FolderPick.plan(
            files: [["Trip", "Day 1", "Evening"], ["Trip", "Day 1"], ["Trip", "Day 1", "Evening"], ["Trip", "Day 2"]],
            folders: [["Trip"], ["Trip", "Day 3", "Empty", "Deeper"], ["Trip", "Day 1"]]
        )
        let at = positions(plan)
        #expect(Set(plan) == [
            ["Trip"], ["Trip", "Day 1"], ["Trip", "Day 1", "Evening"], ["Trip", "Day 2"],
            ["Trip", "Day 3"], ["Trip", "Day 3", "Empty"], ["Trip", "Day 3", "Empty", "Deeper"],
        ])
        for path in plan where path.count > 1 {
            let parent = Array(path.dropLast())
            #expect(at[parent].map { $0 < at[path]! } == true, "\(parent) must come before \(path)")
        }
    }

    @Test func aChildListedBeforeItsParentStillWaitsForIt() {
        // Only the deepest folder is named; its parents have to be made, and made first.
        let plan = FolderPick.plan(files: [["A", "B", "C", "D"]], folders: [])
        #expect(plan == [["A"], ["A", "B"], ["A", "B", "C"], ["A", "B", "C", "D"]])
    }

    @Test func theSameNameInDifferentPlacesIsTwoFolders() {
        let plan = FolderPick.plan(files: [["A", "Notes"], ["A", "B", "Notes"]], folders: [])
        _ = positions(plan)
        #expect(plan.filter { $0.last == "Notes" }.count == 2)
    }

    @Test func nothingPickedPlansNothing() {
        #expect(FolderPick.plan(files: [], folders: []).isEmpty)
    }
}

struct FolderPickReadTests {
    /* A fresh folder in the temp directory, removed when the test is done with it. */
    private func scratch() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("folderpick-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func write(_ text: String, _ path: String, under root: URL) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    @Test func readsVisibleFilesAndFoldersAndLeavesHiddenOnesAndLinksBehind() throws {
        let base = try scratch()
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent("Holiday", isDirectory: true)
        try write("list", "Packing.txt", under: root)
        try write("x", ".DS_Store", under: root)
        try write("[core]", ".git/config", under: root)
        try write("blob", ".git/objects/ab/cdef", under: root)
        try write("notes", "Day 1/Notes.txt", under: root)
        try write("secret", "Day 1/.hidden.txt", under: root)
        try write("cached", "Day 1/.cache/inside.txt", under: root)
        try write("dinner", "Day 1/Evening/Dinner.txt", under: root)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Empty"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Packing link.txt"), withDestinationURL: root.appendingPathComponent("Packing.txt"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Day 1 link"), withDestinationURL: root.appendingPathComponent("Day 1"))
        // A link out of the pick: following it would upload what was never picked.
        try write("outside", "Elsewhere/Private.txt", under: base)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("Elsewhere"), withDestinationURL: base.appendingPathComponent("Elsewhere"))

        let found = FolderPick.read(root)

        let files = Dictionary(uniqueKeysWithValues: found.files.map { ($0.name, $0.path) })
        #expect(files == [
            "Packing.txt": ["Holiday"],
            "Notes.txt": ["Holiday", "Day 1"],
            "Dinner.txt": ["Holiday", "Day 1", "Evening"],
        ])
        #expect(Set(found.folders) == [["Holiday"], ["Holiday", "Day 1"], ["Holiday", "Day 1", "Evening"], ["Holiday", "Empty"]])
        #expect(found.folders.count == 4)
        // Each file's URL is the file itself, so staging copies the right bytes.
        let dinner = try #require(found.files.first { $0.name == "Dinner.txt" })
        #expect(try String(contentsOf: dinner.url, encoding: .utf8) == "dinner")
    }

    @Test func aHiddenPickedFolderHoldsNothing() throws {
        let base = try scratch()
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent(".config", isDirectory: true)
        try write("token", "settings.json", under: root)
        let found = FolderPick.read(root)
        #expect(found.files.isEmpty)
        #expect(found.folders.isEmpty)
    }

    @Test func anEmptyPickedFolderIsStillMade() throws {
        let base = try scratch()
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent("Nothing yet", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let found = FolderPick.read(root)
        #expect(found.files.isEmpty)
        #expect(found.folders == [["Nothing yet"]])
    }
}
