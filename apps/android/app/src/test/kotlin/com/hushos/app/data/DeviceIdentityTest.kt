package com.hushos.app.data

import com.hushos.core.base64urlDecode
import com.hushos.core.deviceEmailHash
import com.hushos.core.deviceSessionVerify
import com.hushos.core.deviceSigningCreate
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The device key at sign-in (docs/devices-design.md, step 1): the proof the app sends is the web's bytes for the web's
 * inputs, goes only with the account the key was made for, and holds for its own attempt only; the session reply
 * tells a removed device from one whose session merely ended.
 */
class DeviceIdentityTest {
    private val session = WebFixture.json.getJSONObject("deviceSession")

    @Test
    fun theProofIsTheWebsSignatureForTheWebsInputs() {
        val identity = Shared.DeviceIdentity(
            session.getString("userId"), deviceEmailHash(session.getString("email")), session.getString("deviceId"),
            base64urlDecode(session.getString("seed")),
        )
        val proof = Auth.deviceProof(identity, session.getString("email"), session.getString("attemptToken"))!!
        assertEquals(session.getString("deviceId"), proof.getString("id"))
        // Ed25519 is deterministic: the same seed, the same statement, the same bytes as libsodium wrote.
        assertEquals(session.getString("signature"), proof.getString("signature"))
        assertEquals(session.getString("emailDigest"), identity.emailHash)
    }

    @Test
    fun aKeyMadeForAnotherEmailSendsNoProofAndAProofHoldsForItsAttemptOnly() {
        val key = deviceSigningCreate()
        val user = "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"
        val device = "5b1c0d9e-8f7a-4c3b-9a2d-1e0f2a3b4c5d"
        val identity = Shared.DeviceIdentity(user, deviceEmailHash("maya@example.com"), device, key.seed)
        assertNull(Auth.deviceProof(identity, "sam@example.com", "attempt-1"))
        assertNull(Auth.deviceProof(null, "maya@example.com", "attempt-1"))
        val proof = Auth.deviceProof(identity, " Maya@Example.com ", "attempt-1")!!
        val signature = base64urlDecode(proof.getString("signature"))
        assertTrue(deviceSessionVerify(key.publicKey, user, device, "attempt-1", signature))
        assertFalse(deviceSessionVerify(key.publicKey, user, device, "attempt-2", signature))
    }

    @Test
    fun theSessionReplyTellsARemovedDeviceFromAnEndedSession() {
        val signedIn = SessionCheck.from(JSONObject("""{"user":{"id":"u","name":"Maya","email":"m@x","credentialVersion":2},"device":{"id":"d","registered":false}}"""))
        assertEquals(SessionDevice("d", false), (signedIn as SessionCheck.SignedIn).device)
        assertEquals(SessionCheck.Removed, SessionCheck.from(JSONObject("""{"user":null,"device":null,"removed":true}""")))
        assertEquals(SessionCheck.Ended, SessionCheck.from(JSONObject("""{"user":null,"device":null}""")))
    }

    @Test
    fun aLateRemovedAnswerClearsNothingOnceSomeoneHasSignedInAgain() {
        val user = "0b7f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"
        val ended = Shared.Session("https://hush.example", "old", user)
        // Nobody signed in since, and the phone still holds that account: the removal may clear it.
        assertTrue(Auth.mayForgetRemoved(ended, null, user.uppercase()))
        // The same person signed in again while the check was out: their new session stays.
        assertFalse(Auth.mayForgetRemoved(ended, Shared.Session("https://hush.example", "new", user), user))
        // Someone else signed in and claimed the phone, then signed out: their data stays.
        assertFalse(Auth.mayForgetRemoved(ended, null, "9d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6"))
        // Nothing recorded as the phone's: nothing is known to be that account's.
        assertFalse(Auth.mayForgetRemoved(ended, null, null))
    }
}
