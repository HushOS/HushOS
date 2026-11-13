package com.hushos.app.ui

import android.app.Activity
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import com.hushos.app.data.HeldSheet
import com.hushos.app.data.KeySheet
import com.hushos.app.data.Shared
import com.hushos.core.KeyAssertion
import com.hushos.core.KeyCreation
import com.hushos.core.KeyRegistration
import com.hushos.core.StepKeyRequest
import com.hushos.core.keyAssertionRead
import com.hushos.core.keyCreationJson
import com.hushos.core.keyRegistrationRead
import com.hushos.core.keyRequestJson
import kotlinx.coroutines.CancellationException

/*
 * The system's sheet for a passkey or security key, through Credential Manager
 * (docs/two-step-design.md 3, 6, 12). The core writes what the key is asked (`keyRequestJson`,
 * `keyCreationJson`) and cuts its answer down to what the server checks (`keyAssertionRead`,
 * `keyRegistrationRead`); this only carries the two across.
 *
 * - It needs the Activity, and is called only from a button's press (`KeySheet`).
 * - No `origin` is set on a request: this app is not a browser. Android reports the app itself
 *   (`android:apk-key-hash:…`, from the certificate the build was signed with), which the server
 *   accepts for the certificates in its `ANDROID_APP_CERT_SHA256` (or its `WEBAUTHN_ANDROID_ORIGINS`,
 *   when set), and the RP's `assetlinks.json` names the app.
 * - Whatever ends without a key's answer is null: the sheet closed
 *   (`GetCredentialCancellationException`, `CreateCredentialCancellationException`), no key for this
 *   account on the phone (`NoCredentialException`), no provider, an interruption, or an answer that
 *   is not a key's. Nothing was sent, and the caller says the key wasn't used. A cancelled coroutine
 *   (the screen left) is thrown on, and ends the sheet's request.
 */
class PasskeySheet(private val activity: Activity) : KeySheet {
    override suspend fun assertion(request: StepKeyRequest): KeyAssertion? = try {
        assertionOf(CredentialManager.create(activity).getCredential(activity, getRequest(request)))
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        null
    }

    override suspend fun registration(creation: KeyCreation): KeyRegistration? = try {
        registrationOf(CredentialManager.create(activity).createCredential(activity, createRequest(creation)))
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        null
    }

    companion object {
        /* What the sheet is asked at a step: the account's keys for this challenge, and nothing else (no passwords, no other sign-in). */
        internal fun getRequest(request: StepKeyRequest): GetCredentialRequest =
            GetCredentialRequest(listOf(GetPublicKeyCredentialOption(keyRequestJson(request))))

        /* What the sheet is asked when a key is added. */
        internal fun createRequest(creation: KeyCreation): CreatePublicKeyCredentialRequest =
            CreatePublicKeyCredentialRequest(keyCreationJson(creation))

        /* The key's answer to a step; null when what came back is not a key's assertion. */
        internal fun assertionOf(response: GetCredentialResponse): KeyAssertion? =
            (response.credential as? PublicKeyCredential)?.authenticationResponseJson?.let(::keyAssertionRead)

        /* The new key's registration; null when what came back is not one. */
        internal fun registrationOf(response: CreateCredentialResponse): KeyRegistration? =
            (response as? CreatePublicKeyCredentialResponse)?.registrationResponseJson?.let(::keyRegistrationRead)
    }
}

/* A window with no Activity under it has no sheet to show: no key answers. */
private object NoSheet : KeySheet {
    override suspend fun assertion(request: StepKeyRequest): KeyAssertion? = null
    override suspend fun registration(creation: KeyCreation): KeyRegistration? = null
}

/*
 * The sheet for the Activity this screen is drawn in, held to the session it is asked under
 * (`HeldSheet`): signed out while it was open, the key's answer is not sent. Making it asks
 * nothing: only a press does.
 */
@Composable
internal fun rememberKeySheet(): KeySheet {
    val activity = LocalActivity.current
    return remember(activity) {
        activity?.let { HeldSheet(PasskeySheet(it)) { Shared.session(it.applicationContext)?.let { s -> Triple(s.origin, s.userId, s.token) } } } ?: NoSheet
    }
}
