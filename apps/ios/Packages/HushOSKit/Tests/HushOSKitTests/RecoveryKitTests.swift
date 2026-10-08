import Foundation
import Testing
@testable import HushOSKit

/* A kit saved on the phone must open in the web's recovery, and carry the key block intact. */
struct RecoveryKitTests {
    let words = (1 ... 24).map { "word" + String(UnicodeScalar(UInt8(96 + ($0 - 1) % 26 + 1))) }.map { $0.filter(\.isLetter) }
    let recovery: [String: Any] = ["version": 1, "keyVersion": 3, "encryptedKey": "abc_DEF-123", "publicKey": "pk"]

    @Test func thePhraseReadsBackExactlyAsTheWebReadsIt() {
        let text = RecoveryKit.text(email: "a@b.c", accountId: "id-1", phrase: words.joined(separator: " "), recovery: recovery)
        #expect(RecoveryKit.phrase(from: text) == words)
        // The line the web's phraseFromKit looks for, and the heading it checks first.
        #expect(text.hasPrefix("HushOS recovery kit\n"))
        #expect(text.contains("The same phrase on one line, for pasting:\n" + words.joined(separator: " ") + "\n"))
    }

    @Test func numberedLinesMatchTheWebsLayout() {
        let text = RecoveryKit.text(email: "a@b.c", accountId: "id-1", phrase: words.joined(separator: " "), recovery: recovery)
        // " 1. worda       " is 16 wide; four to a line, the last trimmed.
        #expect(text.contains("\n 1. \(words[0])".padding(toLength: 17, withPad: " ", startingAt: 0) + " 2. \(words[1])"))
        #expect(text.contains("\n21. \(words[20])"))
    }

    @Test func theKeyBlockIsTheEnvelopeAsJSON() throws {
        let text = RecoveryKit.text(email: "a@b.c", accountId: "id-1", phrase: words.joined(separator: " "), recovery: recovery)
        let block = String(text[text.range(of: "{")!.lowerBound...])
        let parsed = try JSONSerialization.jsonObject(with: Data(block.utf8)) as? [String: Any]
        #expect(parsed?["encryptedKey"] as? String == "abc_DEF-123")
        #expect(parsed?["keyVersion"] as? Int == 3)
        #expect(block.contains("\n    \"encryptedKey\": "))
    }

    @Test func theKitIsTheWebsKitByteForByte() {
        // Printed by apps/web/src/lib/recovery-kit.ts kitText for the same account, words, envelope and day.
        let web = "HushOS recovery kit\nSaved 2026-10-05\n\nKeep this file private, and keep it somewhere you will find it again.\nAnyone who has it can get into your account. If you lose it and forget\nyour password, nobody can get you back in, including HushOS.\n\nYOUR ACCOUNT\nEmail:       a@b.c\nAccount ID:  id-1\n\nYOUR RECOVERY PHRASE (24 words, in this order)\nThis is what unlocks your account if you forget your password.\n\n 1. worda        2. wordb        3. wordc        4. wordd\n 5. worde        6. wordf        7. wordg        8. wordh\n 9. wordi       10. wordj       11. wordk       12. wordl\n13. wordm       14. wordn       15. wordo       16. wordp\n17. wordq       18. wordr       19. words       20. wordt\n21. wordu       22. wordv       23. wordw       24. wordx\n\nThe same phrase on one line, for pasting:\nworda wordb wordc wordd worde wordf wordg wordh wordi wordj wordk wordl wordm wordn wordo wordp wordq wordr words wordt wordu wordv wordw wordx\n\nHOW TO USE IT\n1. Open HushOS and choose \"Forgot your password?\".\n2. Confirm your email with the link we send.\n3. Choose this file when asked for your kit, or type the words above in order.\n\nWHEN THIS KIT STOPS WORKING\nResetting your password with this phrase, making a new recovery phrase,\nor resetting sharing keys in Settings makes a new phrase. Save a new kit then.\nChanging your password in Settings keeps this phrase as it is.\n\nFOR RECOVERY TOOLS\nThe block below is your account key, locked with the phrase above. You do\nnot need it to reset your password in HushOS. It is here so the phrase can\nopen your key even without the service.\n\n{\n    \"encryptedKey\": \"abc_DEF-123\",\n    \"keyVersion\": 3,\n    \"publicKey\": \"pk\",\n    \"version\": 1\n}"
        let fixed = ["encryptedKey": "abc_DEF-123", "keyVersion": 3, "publicKey": "pk", "version": 1] as [String: Any]
        let day = ISO8601DateFormatter().date(from: "2026-10-05T00:00:00Z")!
        #expect(RecoveryKit.text(email: "a@b.c", accountId: "id-1", phrase: words.joined(separator: " "), recovery: fixed, madeOn: day) == web)
    }

    @Test func somethingThatIsNotAKitGivesNoWords() {
        #expect(RecoveryKit.phrase(from: "Hello\nThe same phrase on one line, for pasting:\n" + words.joined(separator: " ")) == nil)
        let short = RecoveryKit.text(email: "a@b.c", accountId: "id-1", phrase: words.dropLast().joined(separator: " "), recovery: recovery)
        #expect(RecoveryKit.phrase(from: short) == nil)
    }
}
