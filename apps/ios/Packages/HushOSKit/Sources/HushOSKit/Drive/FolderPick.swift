import Foundation

/*
 * A folder picked for upload, read the way the web reads a dropped one: each file with
 * the folder path it came from (the picked folder's own name first), and every folder
 * the pick holds, so an empty one is made too. Hidden files and folders (.DS_Store,
 * .git) stay behind, as Files and Finder hide them.
 */
public enum FolderPick {
    public struct File: Sendable {
        public let url: URL
        public let name: String
        /* The folders above it, the picked folder first. */
        public let path: [String]
    }

    public static func hidden(_ name: String) -> Bool { name.hasPrefix(".") }

    /* What `root` holds, walked depth first; symbolic links and other special files are left out. */
    public static func read(_ root: URL) -> (files: [File], folders: [[String]]) {
        let top = root.lastPathComponent
        var files: [File] = []
        var folders: [[String]] = [[top]]
        guard !hidden(top), let walk = FileManager.default.enumerator(atPath: root.path) else { return ([], []) }
        while let relative = walk.nextObject() as? String {
            let parts = relative.split(separator: "/").map(String.init)
            guard let name = parts.last else { continue }
            let type = walk.fileAttributes?[.type] as? FileAttributeType
            if hidden(name) {
                if type == .typeDirectory { walk.skipDescendants() }
                continue
            }
            if type == .typeDirectory {
                folders.append([top] + parts)
            } else if type == .typeRegular {
                files.append(File(url: root.appendingPathComponent(relative), name: name, path: [top] + parts.dropLast()))
            }
        }
        return (files, folders)
    }

    /* Every folder the files and folders need, each prefix included, parents before children. */
    public static func plan(files: [[String]], folders: [[String]]) -> [[String]] {
        var seen = Set<[String]>()
        var ordered: [[String]] = []
        for path in folders + files {
            for depth in stride(from: 1, through: path.count, by: 1) {
                let prefix = Array(path.prefix(depth))
                if seen.insert(prefix).inserted { ordered.append(prefix) }
            }
        }
        // A stable sort by depth: a parent always comes before anything inside it.
        return ordered.enumerated().sorted { ($0.element.count, $0.offset) < ($1.element.count, $1.offset) }.map(\.element)
    }
}
