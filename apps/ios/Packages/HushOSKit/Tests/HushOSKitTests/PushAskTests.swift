import Testing
@testable import HushOSKit

/*
 * Asking once: each test fails on a question asked twice, one asked where nothing could arrive, or
 * a registration made after the person said no (to iOS, or with the Account switch).
 */
@Suite struct PushAskTests {
    let relay = "https://push.hushos.com"

    @Test func aFirstSignInOnAServerWithARelayAsks() {
        #expect(PushAsk.step(available: true, registered: false, asked: false, relay: relay, permission: .undecided) == .ask)
    }

    @Test func onceAskedItNeverAsksAgainWhateverTheAnswerWas() {
        for permission in [PushAsk.Permission.undecided, .allowed, .denied] {
            #expect(PushAsk.step(available: true, registered: false, asked: true, relay: relay, permission: permission) == .nothing)
        }
    }

    @Test func aPhoneAlreadyRegisteredIsLeftAsItIs() {
        #expect(PushAsk.step(available: true, registered: true, asked: false, relay: relay, permission: .undecided) == .nothing)
    }

    @Test func noRelayOrNoPushesMeansNoQuestion() {
        #expect(PushAsk.step(available: true, registered: false, asked: false, relay: nil, permission: .undecided) == .nothing)
        #expect(PushAsk.step(available: false, registered: false, asked: false, relay: relay, permission: .undecided) == .nothing)
    }

    @Test func iOSAllowedAlreadyRegistersWithoutAQuestion() {
        #expect(PushAsk.step(available: true, registered: false, asked: false, relay: relay, permission: .allowed) == .register)
    }

    @Test func iOSDeniedOnlyRecordsThatItWasAsked() {
        #expect(PushAsk.step(available: true, registered: false, asked: false, relay: relay, permission: .denied) == .markOnly)
    }
}
