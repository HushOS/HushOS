import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The device key at sign-in and the replies the device list depends on
 * (docs/devices-design.md, step 1). The proof goes only with the account the
 * key was made for and holds for its own attempt only; a removed device is told
 * apart from one whose session merely ended; a device that never described
 * itself decodes rather than failing the whole list.
 */
@Suite struct DevicesTests {
    let user = "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"
    let device = "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d"

    func identity(for email: String) throws -> (SharedKeychain.DeviceIdentity, DeviceSigningKey) {
        let key = try deviceSigningCreate()
        let stored = SharedKeychain.DeviceIdentity(
            userId: user, emailHash: deviceEmailHash(email: email), deviceId: device, seed: base64urlEncode(bytes: key.seed)
        )
        return (stored, key)
    }

    @Test func aKeyMadeForAnotherEmailSendsNoProof() throws {
        let (stored, _) = try identity(for: "maya@example.com")
        #expect(Auth.deviceProof(identity: stored, email: "sam@example.com", attemptToken: "attempt") == nil)
        #expect(Auth.deviceProof(identity: nil, email: "maya@example.com", attemptToken: "attempt") == nil)
    }

    @Test func theProofForItsOwnEmailNamesTheDeviceAndHoldsForThatAttemptOnly() throws {
        let (stored, key) = try identity(for: "maya@example.com")
        // Typed with other case and spaces: the same account.
        let proof = try #require(Auth.deviceProof(identity: stored, email: " Maya@Example.com ", attemptToken: "attempt-1"))
        #expect(proof["id"] == device)
        let signature = try base64urlDecode(value: try #require(proof["signature"]))
        #expect(deviceSessionVerify(publicKey: key.publicKey, userId: user, deviceId: device, attemptToken: "attempt-1", signature: signature))
        #expect(!deviceSessionVerify(publicKey: key.publicKey, userId: user, deviceId: device, attemptToken: "attempt-2", signature: signature))
    }

    @Test func theSessionReplyTellsARemovedDeviceFromAnEndedSession() throws {
        let signedIn = Data(#"{"user":{"id":"u","name":"Maya","email":"m@x","credentialVersion":2,"role":"member"},"device":{"id":"d","registered":false}}"#.utf8)
        #expect(try Auth.SessionCheck(body: signedIn) == .signedIn(
            SessionUser(id: "u", name: "Maya", email: "m@x", credentialVersion: 2, role: "member"), SessionDevice(id: "d", registered: false)
        ))
        #expect(try Auth.SessionCheck(body: Data(#"{"user":null,"device":null,"removed":true}"#.utf8)) == .removed)
        #expect(try Auth.SessionCheck(body: Data(#"{"user":null,"device":null}"#.utf8)) == .ended)
    }

    @Test func aDeviceThatNeverDescribedItselfDecodesAsUnknown() throws {
        let body = #"""
        [{"id":"a","kind":"ios","name":"Maya’s iPhone","approvedBy":"enrolment","approvedByDeviceId":null,"createdAt":"2026-10-16T10:00:00.000Z","lastSeenAt":"2026-10-16T10:05:00.000Z","current":true,"signedIn":true},
         {"id":"b","kind":null,"name":null,"approvedBy":"existing","approvedByDeviceId":null,"createdAt":"2026-10-01T10:00:00.000Z","lastSeenAt":"2026-10-02T10:00:00.000Z","current":false,"signedIn":false}]
        """#
        let devices = try JSONDecoder().decode([AccountDevice].self, from: Data(body.utf8))
        #expect(devices.map(\.label) == ["Maya’s iPhone", "Unknown device"])
        #expect(devices[1].approval == "Already signed in when HushOS began listing devices")
    }

    @Test func aLateRemovedAnswerClearsNothingOnceSomeoneHasSignedInAgain() {
        let ended = SharedKeychain.Session(origin: "https://hush.example", token: "old", userId: user)
        let owner = AccountOwner(ended)
        // Nobody signed in since, and the phone still holds that account: the removal may clear it.
        #expect(Devices.mayForgetRemoved(ended: ended, current: nil, owner: owner))
        // Asked the moment the 401 arrived, before the session was cleared: the same session, still that account's.
        #expect(Devices.mayForgetRemoved(ended: ended, current: ended, owner: owner))
        // The same person signed in again while the check was out: their new session stays.
        let again = SharedKeychain.Session(origin: "https://hush.example", token: "new", userId: user)
        #expect(!Devices.mayForgetRemoved(ended: ended, current: again, owner: owner))
        // Someone else signed in and claimed the phone, then signed out: their data stays.
        let other = AccountOwner(userId: "9d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6", origin: "https://hush.example")
        #expect(!Devices.mayForgetRemoved(ended: ended, current: nil, owner: other))
        // The same user id on another server is another account.
        #expect(!Devices.mayForgetRemoved(ended: ended, current: nil, owner: AccountOwner(userId: user, origin: "https://other.example")))
    }
}
