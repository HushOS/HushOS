import Foundation
import Testing
@testable import HushOSKit

/* The words two people read to each other must be the web's words for the same fingerprint. */
struct FingerprintWordsTests {
    // Expected values printed by packages/crypto's fingerprintWords for the same inputs.
    @Test func theWordsMatchTheWebForTheSameFingerprint() {
        #expect(FingerprintWords.words("0123 4567 89ab cdef 0011 2233 4455 6677 8899 aabb")
            == ["abuse", "boss", "fly", "battle", "rubber", "wasp", "able", "cattle", "crew", "cargo", "flower", "upper"])
    }

    @Test func onlyTheFirst132BitsCount() {
        // The last 28 bits are not shown: a fingerprint differing only there reads the same.
        #expect(FingerprintWords.words("0000 0000 0000 0000 0000 0000 0000 0000 0000 0001") == Array(repeating: "abandon", count: 12))
        #expect(FingerprintWords.words("ffff ffff ffff ffff ffff ffff ffff ffff ffff ffff") == Array(repeating: "zoo", count: 12))
    }

    @Test func anythingButFortyHexDigitsIsRefused() {
        #expect(FingerprintWords.words("0123 4567") == nil)
        #expect(FingerprintWords.words("zz23 4567 89ab cdef 0011 2233 4455 6677 8899 aabb") == nil)
    }

    @Test func theListIsTheCoresList() throws {
        // A drifted copy would draw different words from the same key.
        let here = URL(fileURLWithPath: #filePath)
        let crate = here.deletingLastPathComponent().appendingPathComponent("../../../../../../crates/hushos-core/src/bip39-english.txt").standardized
        let core = try String(contentsOf: crate, encoding: .utf8).split(whereSeparator: \.isNewline).map(String.init)
        #expect(FingerprintWords.wordlist == core)
    }
}
