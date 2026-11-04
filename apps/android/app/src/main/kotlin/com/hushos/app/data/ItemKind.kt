package com.hushos.app.data

/*
 * What an item is when search's kind words ("photos", "videos", "documents", "folders") and the
 * search type chips ask: the web's split (`nodeKind` in apps/web/src/lib/previews.ts, over
 * `previewKind`), copied list for list so all three clients count the same files. An image or a
 * video is what the web previews as one; a document is what it opens as a PDF, an Office file,
 * Markdown or text. Audio and anything else is none of them. A change to the web's lists comes
 * here and to iOS's `ItemKind`.
 */
enum class ItemKind {
    FOLDER, IMAGE, VIDEO, DOCUMENT;

    companion object {
        /* The kind a query word names, or null for an ordinary word. */
        fun named(word: String): ItemKind? = WORDS[word.lowercase()]

        fun of(item: Opened): ItemKind? {
            if (item.isFolder) return FOLDER
            if (item.node.currentVersion == null) return null
            return file(item.name, item.metadata.mime)
        }

        /* A file by its recorded type and, failing that, its name, in the web's order (an SVG is an image, a .ts file text). */
        fun file(name: String, recorded: String?): ItemKind? {
            val mime = (recorded ?: "").lowercase()
            val lower = name.lowercase()
            val dot = lower.lastIndexOf('.')
            // After the last dot; the web's extension needs a name before it, its languages don't (".env").
            val tail = if (dot >= 0) lower.substring(dot + 1) else null
            val ext = if (dot > 0) tail!! else ""
            return when {
                mime.startsWith("image/") || ext in IMAGE_EXT -> IMAGE
                mime == "application/pdf" || ext == "pdf" -> DOCUMENT
                (mime.startsWith("video/") && mime !in TRANSPORT_STREAM) || ext in VIDEO_EXT -> VIDEO
                mime.startsWith("audio/") || ext in AUDIO_EXT -> null
                mime == "text/markdown" || ext in setOf("md", "markdown", "mdx") -> DOCUMENT
                mime in OFFICE_MIME || ext in OFFICE_EXT -> DOCUMENT
                mime.startsWith("text/") || mime in TEXT_MIME || ext in TEXT_EXT || (tail != null && tail in LANGUAGE_EXT) || lower in LANGUAGE_NAME -> DOCUMENT
                else -> null
            }
        }

        private val WORDS = mapOf(
            "image" to IMAGE, "images" to IMAGE, "photo" to IMAGE, "photos" to IMAGE, "picture" to IMAGE, "pictures" to IMAGE,
            "video" to VIDEO, "videos" to VIDEO,
            "document" to DOCUMENT, "documents" to DOCUMENT, "doc" to DOCUMENT, "docs" to DOCUMENT,
            "folder" to FOLDER, "folders" to FOLDER,
        )

        private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico")
        private val VIDEO_EXT = setOf("mp4", "m4v", "webm", "mov", "ogv")
        /* What browsers call a .ts file: a transport stream no video element plays, nearly always TypeScript. */
        private val TRANSPORT_STREAM = setOf("video/mp2t", "video/vnd.dlna.mpeg-tts")
        private val AUDIO_EXT = setOf("mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba")
        private val OFFICE_EXT = setOf("docx", "docm", "dotx", "xlsx", "xlsm", "xls", "ods", "numbers", "csv", "tsv", "pptx", "pptm", "potx")
        private val OFFICE_MIME = setOf(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "application/vnd.oasis.opendocument.spreadsheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )
        private val TEXT_MIME = setOf(
            "application/json", "application/xml", "application/javascript", "application/x-sh", "application/toml", "application/yaml",
        )
        private val TEXT_EXT = setOf(
            "txt", "md", "markdown", "json", "csv", "tsv", "log", "xml", "yaml", "yml", "toml", "ini", "env", "sh", "bash", "zsh",
            "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "py", "rb", "rs", "go", "java", "kt", "swift",
            "c", "h", "cpp", "hpp", "cs", "php", "sql", "graphql", "lock", "gitignore",
        )
        /* The web viewer's highlighted languages, by extension and by whole name. */
        private val LANGUAGE_EXT = setOf(
            "ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "json", "jsonc", "json5", "css", "scss", "html", "htm", "xml",
            "svg", "plist", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "md", "markdown", "mdx", "sh", "bash", "zsh",
            "fish", "py", "rb", "rs", "go", "java", "kt", "kts", "swift", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "php",
            "sql", "graphql", "gql", "dockerfile", "makefile", "mk", "diff", "patch", "lua", "dart", "ex", "exs", "hs", "zig",
            "r", "tex", "nix", "ps1", "csv", "tsv",
        )
        private val LANGUAGE_NAME = setOf("dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc")
    }
}
