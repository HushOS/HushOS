import Foundation
import HushOSCore

/*
 * The recovery kit as a file, word for word what the web writes
 * (apps/web/src/lib/recovery-kit.ts kitText), so a kit saved on the phone opens in
 * the web's recovery: the account, the phrase numbered four to a line, the same
 * phrase on one line (what the web reads back), and the wrapped key.
 */
public enum RecoveryKit {
    public static let fileName = "hushos-recovery-kit.txt"

    public static func text(email: String, accountId: String, phrase: String, recovery: [String: Any], madeOn: Date = .now) -> String {
        let words = phrase.split(whereSeparator: \.isWhitespace).map(String.init)
        let numbered = words.enumerated().map { index, word in
            let number = String(index + 1)
            return (String(repeating: " ", count: max(0, 2 - number.count)) + number + ". " + word).padding(toLength: 16, withPad: " ", startingAt: 0)
        }
        var lines: [String] = []
        for start in stride(from: 0, to: numbered.count, by: 4) {
            let row = numbered[start ..< min(start + 4, numbered.count)].joined()
            lines.append(String(row.reversed().drop(while: { $0 == " " }).reversed()))
        }
        let day = ISO8601DateFormatter().string(from: madeOn).prefix(10)
        return ([
            "HushOS recovery kit",
            "Saved \(day)",
            "",
            "Keep this file private, and keep it somewhere you will find it again.",
            "Anyone who has it can get into your account. If you lose it and forget",
            "your password, nobody can get you back in, including HushOS.",
            "",
            "YOUR ACCOUNT",
            "Email:       \(email)",
            "Account ID:  \(accountId)",
            "",
            "YOUR RECOVERY PHRASE (\(words.count) words, in this order)",
            "This is what unlocks your account if you forget your password.",
            "",
        ] + lines + [
            "",
            "The same phrase on one line, for pasting:",
            words.joined(separator: " "),
            "",
            "HOW TO USE IT",
            "1. Open HushOS and choose \"Forgot your password?\".",
            "2. Confirm your email with the link we send.",
            "3. Choose this file when asked for your kit, or type the words above in order.",
            "",
            "WHEN THIS KIT STOPS WORKING",
            "Resetting your password with this phrase, making a new recovery phrase,",
            "or resetting sharing keys in Settings makes a new phrase. Save a new kit then.",
            "Changing your password in Settings keeps this phrase as it is.",
            "",
            "FOR RECOVERY TOOLS",
            "The block below is your account key, locked with the phrase above. You do",
            "not need it to reset your password in HushOS. It is here so the phrase can",
            "open your key even without the service.",
            "",
            json(recovery),
        ]).joined(separator: "\n")
    }

    /* The phrase back from a kit, as the web's phraseFromKit reads it; nil for anything that isn't a kit. */
    public static func phrase(from text: String) -> [String]? {
        guard text.drop(while: \.isWhitespace).hasPrefix("HushOS recovery kit") else { return nil }
        let lines = text.components(separatedBy: .newlines)
        guard let at = lines.firstIndex(where: { $0.hasPrefix("The same phrase on one line") }), at + 1 < lines.count else { return nil }
        let words = lines[at + 1].trimmingCharacters(in: .whitespaces).lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        return words.count == 24 && words.allSatisfy({ $0.allSatisfy { $0 >= "a" && $0 <= "z" } }) ? words : nil
    }

    /* JSON.stringify(value, null, 4) for the envelope: four-space indents, keys as given. */
    static func json(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        // Foundation indents by two; the web's kit by four.
        return text.components(separatedBy: "\n").map { line in
            let spaces = line.prefix(while: { $0 == " " }).count
            return String(repeating: " ", count: spaces * 2) + line.dropFirst(spaces)
        }.joined(separator: "\n").replacingOccurrences(of: "\" : ", with: "\": ")
    }
}

extension Auth {
    /* The recovery envelope as the server keeps it, for the kit's last block. */
    public static func recoveryEnvelopeJSON() async throws -> [String: Any] {
        let reply = try await call("/api/auth/recovery-key")
        guard let json = reply["recovery"] as? [String: Any] else { throw AuthError.message("This account has no recovery key.") }
        return json
    }
}

/*
 * The check before a phrase counts as saved, as the web asks it (apps/web/src/lib/recovery-kit.ts
 * checkQuestions): three different positions, each offered with two other words of the same
 * phrase, shuffled so the answer isn't always first.
 */
public enum RecoveryCheck {
    public struct Question: Equatable, Sendable {
        /* 1-based, as the kit numbers the words. */
        public let position: Int
        public let options: [String]
    }

    public static func questions(_ words: [String], random: (Int) -> Int = { Int.random(in: 0 ..< $0) }) -> [Question] {
        guard !words.isEmpty else { return [] }
        var positions = Set<Int>()
        while positions.count < min(3, words.count) { positions.insert(random(words.count)) }
        return positions.sorted().map { index in
            let answer = words[index]
            var others: [String] = []
            for word in words where word != answer && !others.contains(word) { others.append(word) }
            var decoys: [String] = []
            while decoys.count < min(2, others.count) {
                let pick = others[random(others.count)]
                if !decoys.contains(pick) { decoys.append(pick) }
            }
            var options = [answer] + decoys
            for i in stride(from: options.count - 1, to: 0, by: -1) { options.swapAt(i, random(i + 1)) }
            return Question(position: index + 1, options: options)
        }
    }
}

extension Auth {
    /* The phrase is saved: what the web and Android send after the check; the server refuses an older phrase's version. */
    public static func confirmRecovery(recoveryVersion: UInt64) async throws {
        _ = try await call("/api/auth/recovery-key/confirm", method: "POST", body: ["recoveryVersion": recoveryVersion])
    }
}
