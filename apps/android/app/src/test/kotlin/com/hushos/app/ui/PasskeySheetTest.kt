package com.hushos.app.ui

import android.content.Context
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import com.hushos.app.data.Shared
import com.hushos.app.data.StepAdverts
import com.hushos.app.data.sameJson
import com.hushos.core.KeyAssertion
import com.hushos.core.KeyOptionsReply
import com.hushos.core.KeyRegistration
import com.hushos.core.StepReply
import com.hushos.core.keyOptionsReplyRead
import com.hushos.core.stepChallengeReplyRead
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/*
 * The system's sheet, as far as a machine without one can hold it: what Credential Manager is handed
 * is exactly what a browser's key is asked (crates/hushos-core/fixtures/two-step-keys.json), with no
 * origin claimed; and what it hands back becomes exactly the fields the server checks. The ceremony
 * itself needs a real phone (apps/android/AGENTS.md). Under Robolectric: the requests are Android
 * bundles. Here too, since it needs a Context: what a server said of `twoStepMethods` is kept.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PasskeySheetTest {
    private val fixture = JSONObject(File("../../../crates/hushos-core/fixtures/two-step-keys.json").readText())

    @Test
    fun theSheetIsAskedWhatABrowsersKeyIsAndNoOriginIsClaimed() {
        val challenge = (stepChallengeReplyRead(200u, fixture.getJSONObject("step").toString()) as StepReply.Step).challenge
        val request = PasskeySheet.getRequest(challenge.keyRequest!!)
        // A key, and only a key: no saved password or other sign-in is ever asked for at the step.
        val option = request.credentialOptions.single() as GetPublicKeyCredentialOption
        assertTrue(option.requestJson, sameJson(fixture.getJSONObject("request"), JSONObject(option.requestJson)))
        // The app is not a browser: Android reports the app itself, and the server checks that against its own list.
        assertNull(request.origin)
        assertNull(option.clientDataHash)

        val creation = (keyOptionsReplyRead(200u, fixture.getJSONObject("options").toString()) as KeyOptionsReply.Options).creation
        val create = PasskeySheet.createRequest(creation)
        val asked = JSONObject(create.requestJson)
        val served = fixture.getJSONObject("options").getJSONObject("options")
        for (same in listOf("challenge", "rp", "user", "pubKeyCredParams", "excludeCredentials"))
            assertTrue("$same: ${asked.opt(same)}", sameJson(served.get(same), asked.get(same)))
        // A second step needs no attestation, no resident key and no user verification, whatever a reply says.
        assertEquals("none", asked.getString("attestation"))
        assertEquals("discouraged", asked.getJSONObject("authenticatorSelection").getString("userVerification"))
        assertEquals("discouraged", asked.getJSONObject("authenticatorSelection").getString("residentKey"))
        assertNull(create.origin)
        assertNull(create.clientDataHash)
    }

    @Test
    fun whatTheSheetHandsBackBecomesExactlyWhatTheServerChecks() {
        val handed = fixture.getJSONObject("handedAssertion")
        val sent = fixture.getJSONObject("answer").getJSONObject("proof").getJSONObject("response")
        assertEquals(
            KeyAssertion(sent.getString("id"), sent.getJSONObject("response").getString("clientDataJSON"), sent.getJSONObject("response").getString("authenticatorData"), sent.getJSONObject("response").getString("signature")),
            PasskeySheet.assertionOf(GetCredentialResponse(PublicKeyCredential(handed.toString()))),
        )
        // Anything that is not a key's assertion is no answer: the caller says the key wasn't used, and sends nothing.
        assertNull(PasskeySheet.assertionOf(GetCredentialResponse(PasswordCredential("maya@example.org", "a password"))))
        assertNull(PasskeySheet.assertionOf(GetCredentialResponse(PublicKeyCredential("""{"id":"a2V5","rawId":"a2V5","type":"public-key","response":{}}"""))))

        val made = fixture.getJSONObject("handedRegistration")
        val body = fixture.getJSONObject("registrationBody").getJSONObject("response")
        assertEquals(
            KeyRegistration(body.getString("id"), body.getJSONObject("response").getString("clientDataJSON"), body.getJSONObject("response").getString("attestationObject"), listOf("internal", "hybrid")),
            PasskeySheet.registrationOf(CreatePublicKeyCredentialResponse(made.toString())),
        )
        assertNull(PasskeySheet.registrationOf(CreatePasswordResponse()))
        assertNull(PasskeySheet.registrationOf(CreatePublicKeyCredentialResponse("""{"id":"a2V5","type":"public-key","response":{}}""")))
    }

    @Test
    fun whatAServerSaidOfTheFieldIsKeptPerServerForTheNextLaunch() {
        val context = RuntimeEnvironment.getApplication()
        // Shared's own preferences are Keystore-backed, which a JVM has none of: plain ones stand in.
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }.set(null, context.getSharedPreferences("passkey-sheet-test", Context.MODE_PRIVATE))
        // Never heard: neither yes nor no.
        assertNull(StepAdverts.stored(context).read("https://hushos.com"))
        StepAdverts.stored(context).write("https://hushos.com", true)
        StepAdverts.stored(context).write("https://drive.example.org/", false)
        // Read back by what the next launch makes, each server its own answer, however the address was typed.
        val next = StepAdverts.stored(context)
        assertEquals(true, next.read("https://HushOS.com/"))
        assertEquals(false, next.read("https://drive.example.org"))
        assertNull(next.read("https://other.example"))
        // A rollback is remembered over the advert.
        next.write("https://hushos.com", false)
        assertEquals(false, StepAdverts.stored(context).read("https://hushos.com"))
        assertEquals(false, StepAdverts.stored(context).read("https://drive.example.org"))
    }
}
