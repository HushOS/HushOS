import Testing
@testable import HushOSKit

/* The server never sees the password (OPAQUE), so these checks are the only thing between a short one and an account. */
struct SignupRulesTests {
    @Test func aPasswordNeedsTwelveToOneHundredTwentyEightCharacters() {
        #expect(SignupRules.password(String(repeating: "a", count: 11)) != nil)
        #expect(SignupRules.password(String(repeating: "a", count: 12)) == nil)
        #expect(SignupRules.password(String(repeating: "a", count: 128)) == nil)
        #expect(SignupRules.password(String(repeating: "a", count: 129)) != nil)
    }

    /* Counted as the web counts (UTF-16): six emoji are twelve units there and here; Swift's own count says six. */
    @Test func aPasswordIsCountedAsTheWebCountsIt() {
        #expect(SignupRules.password(String(repeating: "🔑", count: 6)) == nil)
        #expect(SignupRules.password(String(repeating: "🔑", count: 5) + "a") != nil)
        // Eleven letters each carrying a combining accent: 22 units, so the web takes it and so must the app.
        #expect(SignupRules.password(String(repeating: "e\u{301}", count: 11)) == nil)
    }

    @Test func theConfirmationMustMatch() {
        #expect(SignupRules.confirm("correct horse battery", "correct horse battery") == nil)
        #expect(SignupRules.confirm("correct horse battery", "correct horse battery ") != nil)
        #expect(SignupRules.confirm("correct horse battery", "Correct horse battery") != nil)
    }

    @Test func aNameIsTrimmedAndBetweenOneAndOneHundredCharacters() {
        #expect(SignupRules.name("   ") != nil)
        #expect(SignupRules.name(" Maya ") == nil)
        #expect(SignupRules.name(" " + String(repeating: "m", count: 100) + " ") == nil)
        #expect(SignupRules.name(String(repeating: "m", count: 101)) != nil)
    }

    @Test func anEmailNeedsAnAtAndADomain() {
        #expect(SignupRules.email(" maya@example.com ") == nil)
        #expect(SignupRules.email("maya") != nil)
        #expect(SignupRules.email("maya@example") != nil)
        #expect(SignupRules.email("ma ya@example.com") != nil)
    }
}
