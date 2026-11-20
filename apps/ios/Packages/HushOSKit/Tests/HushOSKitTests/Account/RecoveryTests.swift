import CryptoKit
import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Recovery in the app. A kit read wrong resets nobody (or the wrong phrase gets used),
 * and a stray file taken for a kit fails a real recovery. The reset's signature is the
 * core's (recovery_reset_sign), tested there against the web's bytes.
 */
struct RecoveryTests {
    let phrase = "okay child donor service stable isolate melody tone tonight resist neutral assist drastic car popular phone battle welcome media film coach radar teach pair"

    private func kit(_ phrase: String) -> String {
        RecoveryKit.text(email: "a@b.c", accountId: "id", phrase: phrase, recovery: ["version": 1])
    }

    @Test func aKitTheAppsSaveReadsBackToItsWords() {
        #expect(Recovery.phrase(fromKit: kit(phrase)) == phrase.split(separator: " ").map(String.init))
    }

    @Test func aKitWithWindowsLineEndingsAndOddSpacingStillReads() {
        let text = kit(phrase).replacingOccurrences(of: "\n", with: "\r\n")
            .replacingOccurrences(of: phrase, with: "  " + phrase.replacingOccurrences(of: " ", with: "   ").uppercased() + "\t")
        #expect(Recovery.phrase(fromKit: text)?.joined(separator: " ") == phrase)
    }

    @Test func aStrayFileIsNotTakenForAKit() {
        #expect(Recovery.phrase(fromKit: "Shopping list\nThe same phrase on one line, for pasting:\n" + phrase) == nil)
        #expect(Recovery.phrase(fromKit: "HushOS recovery kit\nno phrase here") == nil)
        // 23 words, or a digit in a word, is not a phrase.
        let short = phrase.split(separator: " ").dropLast().joined(separator: " ")
        #expect(Recovery.phrase(fromKit: kit(short)) == nil)
        #expect(Recovery.phrase(fromKit: kit(phrase.replacingOccurrences(of: "okay", with: "0kay"))) == nil)
    }

    @Test func aScannedKitReadsTheNumberedWordsInOrderWhateverTheReadingOrder() {
        let words = phrase.split(separator: " ").map(String.init)
        // A camera reads the four-across grid in any order, with noise around it.
        let lines = words.indices.reversed().map { "\($0 + 1). \(words[$0])" }
        #expect(Recovery.phrase(fromScan: "YOUR RECOVERY PHRASE\n" + lines.joined(separator: "   ")) == words)
        #expect(Recovery.phrase(fromScan: lines.dropLast().joined(separator: " ")) == nil)
        // A QR code holding just the phrase.
        #expect(Recovery.phrase(fromScan: phrase) == words)
        // "okey" is one letter from both "okay" and "obey": a guess, so nothing is taken.
        #expect(Recovery.phrase(fromScan: phrase.replacingOccurrences(of: "okay", with: "okey")) == nil)
    }

    @Test func aCameraMisreadIsPutRightOnlyWhereItCanBeOneWord() {
        let words = phrase.split(separator: " ").map(String.init)
        // The kit's one-line phrase as a camera reads it: a digit for a letter, an accent,
        // capitals, a word split at the line's end, a stray bar.
        let read = "for pasting:\n0KAY child dönor service stable isolate melody | tone tonight res\nist neutral assist drastic car popular phone battle welcome media film coach radar teach pair"
        #expect(Recovery.phrase(fromScan: read) == words)
        // Every word real, two of them swapped: the checksum refuses it.
        let swapped = phrase.replacingOccurrences(of: "child donor", with: "donor child")
        #expect(Recovery.phrase(fromScan: swapped) == nil)
    }

    @Test func theKitsNumberedInstructionsAreNotTakenForGridWords() {
        let words = phrase.split(separator: " ").map(String.init)
        // "1. Open", "2. Confirm", "3. Choose": BIP-39 words after numbers, with more words after them.
        let instructions = "1. Open HushOS and choose \"Forgot your password?\".\n2. Confirm your email with the link we send.\n3. Choose this file when asked."
        let grid = words.indices.map { "\($0 + 1). \(words[$0])" }
        #expect(Recovery.numberedWords(instructions).isEmpty)
        #expect(Recovery.phrase(fromScan: instructions + "\n" + grid.joined(separator: "\n")) == words)
        // Without the grid's first three, the instructions must not fill them.
        #expect(Recovery.phrase(fromScan: instructions + "\n" + grid.dropFirst(3).joined(separator: "\n")) == nil)
        // A number read apart from its word, on the line above, still counts.
        #expect(Recovery.numberedWords("6.\ndrastic\n")[6] == "drastic")
    }

    @Test func aLiveScanTalliesTheGridAcrossFrames() {
        let words = phrase.split(separator: " ").map(String.init)
        let grid = words.indices.map { "\($0 + 1). \(words[$0])" }
        var tally = Recovery.ScanTally()
        // Each frame shows half the grid clearly.
        #expect(tally.add(grid.prefix(12).joined(separator: "\n")) == nil)
        #expect(tally.add(grid.suffix(12).joined(separator: "\n")) == words)
        // A misread number puts a real word in the wrong place: until other frames outvote it,
        // the checksum keeps the scan from finishing with it.
        var misread = Recovery.ScanTally()
        var wrong = grid
        wrong[2] = "3. \(words[6])"
        #expect(misread.add(wrong.joined(separator: "\n")) == nil)
        // Half-grid frames, so only the tally can finish: two right readings outvote the wrong one.
        _ = misread.add(grid.prefix(12).joined(separator: "\n"))
        #expect(misread.add(grid.prefix(12).joined(separator: "\n")) == words)
    }

    @Test func wordsCompleteFromTheBIP39List() {
        #expect(Recovery.completions("dras") == ["drastic"])
        #expect(Recovery.completions("ab").allSatisfy { $0.hasPrefix("ab") })
        #expect(Recovery.completions("") == [])
    }

    @Test func theEnrollmentCookieIsReadFromSetCookieAndAClearedOneIsNone() {
        #expect(Auth.enrollmentToken(setCookie: "__Host-hushos-enrollment=abc; Path=/; HttpOnly") == "abc")
        #expect(Auth.enrollmentToken(setCookie: "hushos-session=s; Path=/, hushos-enrollment=xyz; Path=/") == "xyz")
        #expect(Auth.enrollmentToken(setCookie: "hushos-enrollment=; Max-Age=0") == nil)
    }
}

extension AppLinksTests {
    @Test func theEmailedRecoveryLinkOpensTheResetWithItsToken() {
        #expect(parse("https://hushos.com/recover/complete#verify=\(token)") == .success(.recover(token: token)))
        #expect(parse("hushos://recover/complete#verify=\(token)") == .success(.recover(token: token)))
    }

    @Test func aRecoveryLinkWithoutItsTokenOrFromAnotherServerOpensNothing() {
        #expect(parse("https://hushos.com/recover/complete") == .failure(.malformed))
        #expect(parse("https://hushos.com/recover/complete#verify=\(token.dropLast(3))") == .failure(.malformed))
        #expect(parse("https://evil.example/recover/complete#verify=\(token)") == .failure(.otherServer(host: "evil.example")))
        #expect(parse("https://hushos.com/recover") == .failure(.webOnly))
    }
}
