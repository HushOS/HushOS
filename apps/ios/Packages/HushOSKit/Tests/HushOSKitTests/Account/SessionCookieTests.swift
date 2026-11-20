import Testing
@testable import HushOSKit

/* The session token from Set-Cookie: sign-out's cleared cookie once crashed the app. */
struct SessionCookieTests {
    @Test func anEmptyValueIsNoSession() {
        #expect(Auth.sessionToken(setCookie: "hushos-session=; Path=/; Max-Age=0; HttpOnly") == nil)
        #expect(Auth.sessionToken(setCookie: "__Host-hushos-session=; Path=/; Secure") == nil)
    }

    @Test func aValueIsKeptAndItsAttributesIgnored() {
        #expect(Auth.sessionToken(setCookie: "hushos-session=abc.DEF_123; Path=/; HttpOnly; SameSite=Lax") == "abc.DEF_123")
        #expect(Auth.sessionToken(setCookie: "__Host-hushos-session=tok-9; Path=/; Secure; HttpOnly") == "tok-9")
    }

    @Test func otherCookiesAreIgnored() {
        // Joined as Foundation joins several Set-Cookie headers, with a date that has its own comma.
        let header = "theme=dark; Path=/, other-session=nope; Expires=Wed, 21 Oct 2026 07:28:00 GMT, hushos-session=real; Path=/"
        #expect(Auth.sessionToken(setCookie: header) == "real")
        #expect(Auth.sessionToken(setCookie: "theme=dark; Path=/") == nil)
        #expect(Auth.sessionToken(setCookie: "x-hushos-session=lookalike; Path=/") == nil)
    }

    @Test func aMalformedHeaderGivesNoSessionWithoutCrashing() {
        for header in ["", ";", "=", "hushos-session", "hushos-session;=x", ",,,", "; hushos-session=", "=value; Path=/"] {
            #expect(Auth.sessionToken(setCookie: header) == nil, "\(header)")
        }
        #expect(Auth.sessionToken(setCookie: nil) == nil)
    }
}
