import Foundation

/*
 * Text shared to Save to HushOS with no file attached: a browser's page (its link, with the
 * page title) or a few lines from a note. It is saved as a small .txt named after the title,
 * holding the title and the link, so it opens anywhere. Android's SharedText, rule for rule.
 */
enum SharedText {
    struct Saved {
        let name: String
        let body: String
        let link: Bool
    }

    static func of(text: String?, subject: String?) -> Saved? {
        let shared = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !shared.isEmpty else { return nil }
        if let found = shared.firstMatch(of: /(?i)https?:\/\/[^\s<>"]+/) {
            var url = String(found.output)
            while let last = url.last, ".,;!?".contains(last) { url.removeLast() }
            // Safari gives the page title beside the link; other apps put it in the text.
            let beside = shared.replacingOccurrences(of: url, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-–—:|\"“”")).trimmingCharacters(in: .whitespacesAndNewlines)
            let subject = subject?.trimmingCharacters(in: .whitespacesAndNewlines)
            let title = subject.flatMap { $0.isEmpty || $0 == url ? nil : $0 }
                ?? (beside.isEmpty || beside.count > 200 || beside.contains("\n") ? nil : beside)
                ?? host(url)
            return Saved(name: fileName(title, fallback: "Link"), body: "\(title)\n\(url)\n", link: true)
        }
        let first = shared.split(separator: "\n", omittingEmptySubsequences: false).first.map { String($0.prefix(60)) } ?? ""
        let title = subject.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } ?? first
        return Saved(name: fileName(title, fallback: "Note"), body: shared + "\n", link: false)
    }

    private static func host(_ url: String) -> String {
        guard let host = URL(string: url)?.host() else { return "Link" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /* A title as a file name: no characters a drive or a phone refuses, not too long, never empty. */
    static func fileName(_ title: String, fallback: String) -> String {
        var clean = title.replacing(/[\\\/:*?"<>|\p{Cc}]/, with: " ").replacing(/\s+/, with: " ")
            .trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        clean = String(clean.prefix(80)).trimmingCharacters(in: .whitespaces)
        return (clean.isEmpty ? fallback : clean) + ".txt"
    }
}
