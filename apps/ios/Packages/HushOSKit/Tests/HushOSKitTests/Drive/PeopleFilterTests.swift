import Testing
@testable import HushOSKit

/*
 * "Find someone" on People. A field that appears for a short list, vanishes under
 * the text being typed, misses someone by case or a stray space, or says nobody
 * matches a blank query would each be noticed by the person looking.
 */
struct PeopleFilterTests {
    @Test func offeredFromEightPeopleAndNotBelow() {
        #expect(!PeopleFilter.offered(count: 7, query: ""))
        #expect(PeopleFilter.offered(count: 8, query: ""))
    }

    @Test func keptWhileTextIsTypedEvenBelowEight() {
        // The list shrank (someone removed) while "pri" was in the field: the field stays.
        #expect(PeopleFilter.offered(count: 3, query: "pri"))
        #expect(PeopleFilter.offered(count: 0, query: " "))
    }

    @Test func matchesNameOrEmailTrimmedAndCaseInsensitive() {
        #expect(PeopleFilter.matches(name: "Priya Shah", email: "p@example.com", query: "  SHAH "))
        #expect(PeopleFilter.matches(name: "Priya Shah", email: "Priya.Work@Example.com", query: "work@example"))
        #expect(!PeopleFilter.matches(name: "Priya Shah", email: "p@example.com", query: "sam"))
    }

    @Test func aBlankQueryShowsEveryoneRatherThanNobody() {
        let pins = [pin("Sam Lee", "sam@example.com"), pin("Priya Shah", "priya@example.com")]
        #expect(PeopleFilter.shown(pins, query: "   ").map(\.email) == ["sam@example.com", "priya@example.com"])
    }

    @Test func narrowsInListOrder() {
        let pins = [pin("Ana", "ana@one.test"), pin("Ben", "ben@two.test"), pin("Cara", "cara@one.test")]
        #expect(PeopleFilter.shown(pins, query: "ONE.test").map(\.name) == ["Ana", "Cara"])
        #expect(PeopleFilter.shown(pins, query: "zed").isEmpty)
    }

    @Test func saysWhatItFoundInTheWebsWords() {
        #expect(PeopleFilter.result(shown: 2, of: 8, query: "  sa ") == "2 of 8 shown")
        #expect(PeopleFilter.result(shown: 0, of: 8, query: " SA zz ") == "Nobody here matches “SA zz”.")
        // Nothing typed but spaces: nothing to say, and never "Nobody here matches “”.".
        #expect(PeopleFilter.result(shown: 8, of: 8, query: "   ") == nil)
    }

    @Test func accentsCountAsOnTheWeb() {
        #expect(!PeopleFilter.matches(name: "Chloé Martin", email: "c@example.com", query: "chloe"))
        #expect(PeopleFilter.matches(name: "Chloé Martin", email: "c@example.com", query: "CHLOÉ"))
    }

    @Test func aDecomposedNameMatchesWhatAKeyboardTypes() {
        // "é" stored as e + combining acute (as some systems write names), typed precomposed, and the other way round.
        #expect(PeopleFilter.matches(name: "Chloe\u{301} Martin", email: "c@example.com", query: "chlo\u{E9}"))
        #expect(PeopleFilter.matches(name: "Chlo\u{E9} Martin", email: "c@example.com", query: "chloe\u{301}"))
    }

    private func pin(_ name: String, _ email: String) -> ContactPin {
        ContactPin(userId: email, email: email, name: name, encryptionPublicKey: "", signingPublicKey: "", fingerprint: "", pinnedAt: "2026-10-15T00:00:00Z", kemPublicKeyHash: nil)
    }
}
