import Foundation

/* The checkout's files the suites read (the core's fixtures, e2e's, this package's): found by walking up from this file to the folder that holds `crates/hushos-core`, so a suite's own depth never matters. */
enum Checkout {
    static let root: URL = {
        var folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: folder.appendingPathComponent("crates/hushos-core").path) {
            let parent = folder.deletingLastPathComponent()
            precondition(parent.path != folder.path, "No checkout above \(#filePath)")
            folder = parent
        }
        return folder
    }()

    static func file(_ path: String) -> URL { root.appendingPathComponent(path) }
}
