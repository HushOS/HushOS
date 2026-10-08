import Foundation

/*
 * A contact's fingerprint as twelve words to read aloud, exactly as the web's
 * `fingerprintWords` (packages/crypto/src/fingerprint.ts) draws them: the first
 * 132 bits of the 40-hex-digit fingerprint, eleven bits at a time, most
 * significant first, each naming a word in the BIP-39 English list. Every client
 * must draw the same words from the same fingerprint, or two people comparing
 * them would be told a true match is false (or worse, the reverse).
 */
public enum FingerprintWords {
    public static let count = 12

    static let wordlist: [String] = {
        guard let url = Bundle.module.url(forResource: "bip39-english", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }()

    /* Nil for anything that isn't 40 hex digits (spaces allowed), or if the list failed to load. */
    public static func words(_ fingerprint: String) -> [String]? {
        let hex = fingerprint.replacingOccurrences(of: " ", with: "").lowercased()
        guard hex.count == 40, hex.allSatisfy(\.isHexDigit), wordlist.count == 2048 else { return nil }
        // 160 bits as five 32-bit words; take the top 132 (drop the last 28).
        var bits: [Bool] = []
        for char in hex {
            guard let nibble = Int(String(char), radix: 16) else { return nil }
            for shift in stride(from: 3, through: 0, by: -1) { bits.append((nibble >> shift) & 1 == 1) }
        }
        return (0 ..< count).map { index in
            let slice = bits[(index * 11) ..< (index * 11 + 11)]
            return wordlist[slice.reduce(0) { $0 << 1 | ($1 ? 1 : 0) }]
        }
    }
}
