import Foundation

/*
 * What an item is when search's kind words ("photos", "videos", "documents", "folders") and the
 * search type chips ask: the web's split (`nodeKind` in apps/web/src/lib/previews.ts, over
 * `previewKind`), copied list for list so all three clients count the same files. An image or a
 * video is what the web previews as one; a document is what it opens as a PDF, an Office file,
 * Markdown or text. Audio and anything else is none of them. A change to the web's lists comes
 * here and to Android's `ItemKind`.
 */
public enum ItemKind: Sendable, Equatable {
    case folder, image, video, document

    /* The kind a query word names, or nil for an ordinary word. */
    public static func named(_ word: String) -> ItemKind? { words[word.lowercased()] }

    public static func of(_ item: Opened) -> ItemKind? {
        if item.isFolder { return .folder }
        guard item.node.currentVersion != nil else { return nil }
        return file(name: item.name, mime: item.metadata.mime)
    }

    /* A file by its recorded type and, failing that, its name, in the web's order (an SVG is an image, a .ts file text). */
    public static func file(name: String, mime recorded: String?) -> ItemKind? {
        let mime = (recorded ?? "").lowercased()
        let lower = name.lowercased()
        let dot = lower.lastIndex(of: ".")
        // After the last dot; the web's extension needs a name before it, its languages don't (".env").
        let tail = dot.map { String(lower[lower.index(after: $0)...]) }
        let ext = dot.map { $0 > lower.startIndex } == true ? tail ?? "" : ""
        if mime.hasPrefix("image/") || imageExt.contains(ext) { return .image }
        if mime == "application/pdf" || ext == "pdf" { return .document }
        if (mime.hasPrefix("video/") && !transportStream.contains(mime)) || videoExt.contains(ext) { return .video }
        if mime.hasPrefix("audio/") || audioExt.contains(ext) { return nil }
        if mime == "text/markdown" || ["md", "markdown", "mdx"].contains(ext) { return .document }
        if officeMime.contains(mime) || officeExt.contains(ext) { return .document }
        if mime.hasPrefix("text/") || textMime.contains(mime) || textExt.contains(ext) || tail.map(languageExt.contains) == true || languageName.contains(lower) {
            return .document
        }
        return nil
    }

    private static let words: [String: ItemKind] = [
        "image": .image, "images": .image, "photo": .image, "photos": .image, "picture": .image, "pictures": .image,
        "video": .video, "videos": .video,
        "document": .document, "documents": .document, "doc": .document, "docs": .document,
        "folder": .folder, "folders": .folder,
    ]

    private static let imageExt: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"]
    private static let videoExt: Set<String> = ["mp4", "m4v", "webm", "mov", "ogv"]
    /* What browsers call a .ts file: a transport stream no video element plays, nearly always TypeScript. */
    private static let transportStream: Set<String> = ["video/mp2t", "video/vnd.dlna.mpeg-tts"]
    private static let audioExt: Set<String> = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]
    private static let officeExt: Set<String> = [
        "docx", "docm", "dotx", "xlsx", "xlsm", "xls", "ods", "numbers", "csv", "tsv", "pptx", "pptm", "potx",
    ]
    private static let officeMime: Set<String> = [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]
    private static let textMime: Set<String> = [
        "application/json", "application/xml", "application/javascript", "application/x-sh", "application/toml", "application/yaml",
    ]
    private static let textExt: Set<String> = [
        "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yaml", "yml", "toml", "ini", "env", "sh", "bash", "zsh",
        "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "py", "rb", "rs", "go", "java", "kt", "swift",
        "c", "h", "cpp", "hpp", "cs", "php", "sql", "graphql", "lock", "gitignore",
    ]
    /* The web viewer's highlighted languages, by extension and by whole name. */
    private static let languageExt: Set<String> = [
        "ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "json", "jsonc", "json5", "css", "scss", "html", "htm", "xml",
        "svg", "plist", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "md", "markdown", "mdx", "sh", "bash", "zsh",
        "fish", "py", "rb", "rs", "go", "java", "kt", "kts", "swift", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "php",
        "sql", "graphql", "gql", "dockerfile", "makefile", "mk", "diff", "patch", "lua", "dart", "ex", "exs", "hs", "zig",
        "r", "tex", "nix", "ps1", "csv", "tsv",
    ]
    private static let languageName: Set<String> = [
        "dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc",
    ]
}
