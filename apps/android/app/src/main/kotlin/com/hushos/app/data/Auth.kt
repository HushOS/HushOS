package com.hushos.app.data

import android.content.Context
import com.hushos.core.AccountKeyEnvelope
import com.hushos.core.accountSeal
import com.hushos.core.accountUnlock
import com.hushos.core.deviceRemember
import com.hushos.core.opaqueFinishLogin
import com.hushos.core.opaqueFinishRegistration
import com.hushos.core.opaqueStartLogin
import com.hushos.core.opaqueStartRegistration
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

data class SessionUser(val id: String, val name: String, val email: String, val credentialVersion: ULong) {
    companion object {
        fun from(json: JSONObject) = SessionUser(json.getString("id"), json.optString("name"), json.optString("email"), json.optLong("credentialVersion").toULong())
    }
}

class AuthFailure(message: String) : Exception(message)

data class StorageAllowance(val quotaBytes: Long, val usedBytes: Long)
data class BillingSummary(val enabled: Boolean, val planName: String?, val periodEnd: String?, val cancelAtPeriodEnd: Boolean)

/*
 * OPAQUE sign-in against the HushOS API, entirely native: the Rust core runs
 * the client steps; the session cookie goes to the encrypted store; a device
 * bundle is made when there is none for this user and credential, so the
 * documents provider can open the account key afterwards.
 */
object Auth {
    /* The two sign-in failures a person can act on, in the words the board settles on. */
    const val MISMATCH = "That email and password don’t match. Check them and try again."
    const val UNREACHABLE = "We couldn’t reach HushOS. Check your connection, then try again."

    private class Reply(val body: JSONObject, val cookie: String?, val enrollment: String? = null)

    private fun post(origin: String, path: String, body: JSONObject, cookie: String? = null): Reply {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Origin", origin)
        connection.setRequestProperty("HushOS-Client", "android/2")
        if (cookie != null) connection.setRequestProperty("Cookie", cookie)
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        val status: Int
        val text: String
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw AuthFailure(UNREACHABLE)
        }
        val parsed = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        if (status !in 200..299) throw AuthFailure(Problems.signIn(status, parsed.optString("message")))
        var token: String? = null
        var enrollment: String? = null
        for (header in connection.headerFields["Set-Cookie"].orEmpty()) {
            val pair = header.split(";")[0].trim()
            if (pair.startsWith("hushos-session=") || pair.startsWith("__Host-hushos-session=")) token = pair.substringAfter("=")
            if (pair.startsWith("hushos-enrollment=") || pair.startsWith("__Host-hushos-enrollment=")) enrollment = pair.substringAfter("=").ifEmpty { null }
        }
        return Reply(parsed, token, enrollment)
    }

    /*
     * Account recovery, as the web's /recover: the server emails a link; the link proves the
     * address (and leaves an enrollment token, kept here in memory only); the 24 words open
     * the account key; a new password registers again and seals it; a new phrase replaces the
     * old one, signed with the old phrase's key so the server knows the words were right.
     */
    fun requestRecoveryEmail(origin: String, email: String): String =
        post(origin, "/api/auth/recover/email", JSONObject().put("email", email)).body.optString("message")

    /* The email link's token: the address it was sent to, and the enrollment the next steps need. */
    data class RecoveryEnrollment(val email: String, val token: String)

    fun verifyRecoveryLink(origin: String, verifyToken: String): RecoveryEnrollment {
        val reply = post(origin, "/api/auth/register/verify", JSONObject().put("token", verifyToken))
        val enrollment = reply.body.optJSONObject("enrollment") ?: throw AuthFailure("This link didn’t work.")
        if (enrollment.optString("purpose") != "recover") throw AuthFailure("This link belongs to a different account flow. Request a new link.")
        return RecoveryEnrollment(enrollment.getString("email"), reply.enrollment ?: throw AuthFailure("This link didn’t work."))
    }

    /* Resets the password with the phrase; returns the new phrase to save. The caller signs in with the new password. */
    fun recover(origin: String, enrollment: RecoveryEnrollment, phrase: String, password: String): String {
        val cookie = (if (origin.startsWith("https:")) "__Host-hushos-enrollment" else "hushos-enrollment") + "=" + enrollment.token
        val registration = opaqueStartRegistration(password)
        val challenge = post(origin, "/api/auth/recover/start", JSONObject().put("registrationRequest", registration.request), cookie).body
        val userId = challenge.getString("userId")
        val current = recoveryEnvelope(challenge.getJSONObject("recovery"))
        val credentialVersion = challenge.getLong("credentialVersion").toULong()
        // The phrase opens the account key (and is refused when it isn't this account's).
        val accountKey = try {
            com.hushos.core.recoveryOpen(userId, phrase, current)
        } catch (error: com.hushos.core.CoreException) {
            // The web's words for a phrase that isn't this account's (or is an older kit's).
            val said = error.message?.substringAfter(": ")?.takeIf { it.isNotBlank() }
            throw AuthFailure(if (said == null || said.startsWith("The recovery phrase does not match")) "These words didn’t open your account. Check you used your newest kit." else said)
        }
        val registered = opaqueFinishRegistration(password, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, accountKey, current.keyVersion, credentialVersion + 1uL)
        val next = com.hushos.core.recoveryCreate(userId, accountKey, current.recoveryVersion + 1uL, current.keyVersion)
        val attempt = challenge.getString("attemptToken")
        val signature = com.hushos.core.recoveryResetSign(userId, phrase, current, attempt, credentialVersion, registered.record, sealed, next.envelope)
        try {
            post(origin, "/api/auth/recover/finish", JSONObject().put("userId", userId).put("attemptToken", attempt)
                .put("credentialVersion", credentialVersion.toLong()).put("registrationRecord", registered.record)
                .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                    .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                    .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
                .put("recovery", json(next.envelope)).put("signature", signature), cookie)
        } catch (error: AuthFailure) {
            // The server may have committed before the reply was lost: say so, as the web does.
            throw AuthFailure("${error.message} If it keeps failing, try signing in with your new password first: the reset may already have been applied.")
        }
        return next.phrase
    }

    fun signIn(context: Context, origin: String, email: String, password: String): SessionUser {
        val start = opaqueStartLogin(password)
        val started = post(origin, "/api/auth/login/start", JSONObject().put("email", email).put("startLoginRequest", start.request)).body
        val attemptToken = started.optString("attemptToken").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val loginResponse = started.optString("loginResponse").ifEmpty { throw AuthFailure("HushOS didn’t answer as expected. Try again in a moment.") }
        val finish = opaqueFinishLogin(password, start.state, loginResponse) ?: throw AuthFailure(MISMATCH)
        val finished = post(origin, "/api/auth/login/finish", JSONObject().put("attemptToken", attemptToken).put("finishLoginRequest", finish.request))
        val user = finished.body.optJSONObject("user")?.let(SessionUser::from) ?: throw AuthFailure("Signed in, but the session was not returned.")
        val envelopeJson = finished.body.optJSONObject("envelope") ?: throw AuthFailure("Signed in, but the session was not returned.")
        val token = finished.cookie ?: throw AuthFailure("Signed in, but the session was not returned.")
        // Another account's data on this phone goes before this one's session exists.
        AccountStore.of(context).claim(user.id)
        Shared.writeOrigin(context, origin)
        Shared.writeSession(context, Shared.Session(origin, token, user.id, user.email))
        val envelope = AccountKeyEnvelope(
            envelopeJson.getInt("envelopeVersion").toUInt(), envelopeJson.getLong("keyVersion").toULong(), envelopeJson.getLong("credentialVersion").toULong(),
            envelopeJson.getString("wrappingSalt"), envelopeJson.getString("wrappingNonce"), envelopeJson.getString("encryptedKey"),
        )
        val existing = Shared.device(context)
        if (existing != null && existing.bundle.userId.equals(user.id, ignoreCase = true) && existing.bundle.credentialVersion == envelope.credentialVersion) return user
        val accountKey = accountUnlock(user.id, finish.exportKey, envelope)
        val memory = deviceRemember(user.id, accountKey, envelope.keyVersion, envelope.credentialVersion, UUID.randomUUID().toString())
        Shared.writeDevice(context, memory)
        return user
    }

    /* Who the stored session belongs to, null when it is gone; throws when HushOS is unreachable. */
    fun currentUser(context: Context): SessionUser? {
        val session = Shared.session(context) ?: return null
        val connection = URL(session.origin + "/api/auth/session").openConnection() as HttpURLConnection
        val cookieName = if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"
        connection.setRequestProperty("Cookie", "$cookieName=${session.token}")
        connection.setRequestProperty("Origin", session.origin)
        connection.setRequestProperty("HushOS-Client", "android/2")
        connection.connectTimeout = 20_000
        connection.readTimeout = 20_000
        if (connection.responseCode != 200) return null
        val body = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        return body.optJSONObject("user")?.let(SessionUser::from)
    }

    private fun cookie(session: Shared.Session) =
        (if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session") + "=" + session.token

    private fun call(context: Context, path: String, body: JSONObject? = null, method: String? = null): JSONObject {
        val session = Shared.session(context) ?: throw AuthFailure("Sign in first.")
        val connection = URL(session.origin + path).openConnection() as HttpURLConnection
        connection.requestMethod = method ?: if (body == null) "GET" else "POST"
        connection.setRequestProperty("Cookie", cookie(session))
        connection.setRequestProperty("Origin", session.origin)
        connection.setRequestProperty("HushOS-Client", "android/2")
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        val status: Int
        val text: String
        try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        } catch (error: java.io.IOException) {
            throw AuthFailure(UNREACHABLE)
        }
        val parsed = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        if (status == 401) throw NotAuthenticated()
        if (status !in 200..299) throw AuthFailure(Problems.signIn(status, parsed.optString("message")))
        return parsed
    }

    /* The identity envelope the server keeps for this account. */
    fun identity(context: Context): com.hushos.core.IdentityEnvelope = identityEnvelope(call(context, "/api/auth/identity").getJSONObject("identity"))

    private fun identityEnvelope(json: JSONObject): com.hushos.core.IdentityEnvelope {
        val kem = json.optJSONObject("kem")?.let { com.hushos.core.IdentityKem(it.getString("publicKey"), it.getString("seedNonce"), it.getString("encryptedSeed"), it.getString("signature")) }
        return com.hushos.core.IdentityEnvelope(
            json.getInt("version").toUInt(), json.getLong("keyVersion").toULong(), json.getString("wrappingSalt"),
            json.getString("encryptionPublicKey"), json.getString("encryptionPrivateKeyNonce"), json.getString("encryptedEncryptionPrivateKey"),
            json.getString("signingPublicKey"), json.getString("signingSeedNonce"), json.getString("encryptedSigningSeed"), kem,
        )
    }

    private fun json(identity: com.hushos.core.IdentityEnvelope): JSONObject = JSONObject()
        .put("version", identity.version.toInt()).put("keyVersion", identity.keyVersion.toLong()).put("wrappingSalt", identity.wrappingSalt)
        .put("encryptionPublicKey", identity.encryptionPublicKey).put("encryptionPrivateKeyNonce", identity.encryptionPrivateKeyNonce)
        .put("encryptedEncryptionPrivateKey", identity.encryptedEncryptionPrivateKey).put("signingPublicKey", identity.signingPublicKey)
        .put("signingSeedNonce", identity.signingSeedNonce).put("encryptedSigningSeed", identity.encryptedSigningSeed)
        .put("kem", identity.kem?.let { JSONObject().put("publicKey", it.publicKey).put("seedNonce", it.seedNonce).put("encryptedSeed", it.encryptedSeed).put("signature", it.signature) } ?: JSONObject.NULL)

    private fun recoveryEnvelope(json: JSONObject) = com.hushos.core.RecoveryEnvelope(
        json.getInt("version").toUInt(), json.getLong("keyVersion").toULong(), json.getLong("recoveryVersion").toULong(),
        json.getString("wrappingSalt"), json.getString("wrappingNonce"), json.getString("encryptedKey"),
        json.getString("backupNonce"), json.getString("encryptedRecoveryKey"), json.getString("publicKey"),
    )

    private fun json(recovery: com.hushos.core.RecoveryEnvelope): JSONObject = JSONObject()
        .put("version", recovery.version.toInt()).put("keyVersion", recovery.keyVersion.toLong()).put("recoveryVersion", recovery.recoveryVersion.toLong())
        .put("wrappingSalt", recovery.wrappingSalt).put("wrappingNonce", recovery.wrappingNonce).put("encryptedKey", recovery.encryptedKey)
        .put("backupNonce", recovery.backupNonce).put("encryptedRecoveryKey", recovery.encryptedRecoveryKey).put("publicKey", recovery.publicKey)

    private fun json(grant: com.hushos.core.WorkspaceGrant): JSONObject = JSONObject()
        .put("version", grant.version.toInt()).put("workspaceId", grant.workspaceId).put("keyVersion", grant.keyVersion.toLong())
        .put("workspaceKeyVersion", grant.workspaceKeyVersion.toLong()).put("wrappingSalt", grant.wrappingSalt)
        .put("wrappingNonce", grant.wrappingNonce).put("encryptedKey", grant.encryptedKey)

    /* A person by email, with their identity's public keys. */
    fun lookupContact(context: Context, email: String): Contact {
        val json = call(context, "/api/auth/contacts/lookup?email=" + java.net.URLEncoder.encode(email, "UTF-8")).optJSONObject("contact")
            ?: throw AuthFailure("No HushOS account uses that email.")
        val kem = json.optJSONObject("kem")
        return Contact(json.getString("userId"), json.optString("name"), json.optString("email", email), json.getString("encryptionPublicKey"),
            json.getString("signingPublicKey"), kem?.getString("publicKey"), kem?.getString("signature"))
    }

    fun settings(context: Context): com.hushos.core.SettingsEnvelope? =
        call(context, "/api/auth/settings").optJSONObject("settings")?.let(::settingsEnvelope)

    fun putSettings(context: Context, expectedVersion: ULong, envelope: com.hushos.core.SettingsEnvelope) {
        call(context, "/api/auth/settings", JSONObject().put("expectedVersion", expectedVersion.toLong()).put("nonce", envelope.nonce).put("ciphertext", envelope.ciphertext), "PUT")
    }

    /* The recovery key envelope the server keeps. */
    fun recoveryKey(context: Context): com.hushos.core.RecoveryEnvelope =
        recoveryEnvelope(call(context, "/api/auth/recovery-key").optJSONObject("recovery") ?: throw AuthFailure("This account has no recovery key."))

    /*
     * Rotates the master key, as the web's "Rotate keys" does: a fresh account
     * key replaces the old one under the same password, the identity and every
     * workspace grant are sealed again under it, and a new recovery phrase is
     * minted. The server ends every session, so the caller signs in again.
     * Returns the phrase to show once.
     */
    fun rotateKeys(context: Context, password: String): String {
        val login = opaqueStartLogin(password)
        val registration = opaqueStartRegistration(password)
        val challenge = call(context, "/api/auth/security/start", JSONObject().put("action", "master-key")
            .put("startLoginRequest", login.request).put("registrationRequest", registration.request))
        val finish = opaqueFinishLogin(password, login.state, challenge.getString("loginResponse")) ?: throw AuthFailure("The password is not right.")
        val userId = challenge.getString("userId")
        val old = envelope(challenge.getJSONObject("envelope"))
        val oldRoot = accountUnlock(userId, finish.exportKey, old)
        val newRoot = com.hushos.core.randomBytes(32u)
        val keyVersion = old.keyVersion + 1uL
        val registered = opaqueFinishRegistration(password, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, newRoot, keyVersion, old.credentialVersion + 1uL)
        val oldRecovery = recoveryEnvelope(challenge.getJSONObject("recovery"))
        val recovery = com.hushos.core.recoveryCreate(userId, newRoot, oldRecovery.recoveryVersion + 1uL, keyVersion)
        val identity = com.hushos.core.identityRewrap(userId, oldRoot, newRoot, identityEnvelope(challenge.getJSONObject("identity")), keyVersion)
        val workspaces = JSONArray()
        val grants = challenge.getJSONArray("workspaces")
        for (index in 0 until grants.length()) {
            val g = grants.getJSONObject(index)
            val grant = com.hushos.core.WorkspaceGrant(g.getInt("version").toUInt(), g.getString("workspaceId"), g.getLong("keyVersion").toULong(),
                g.getLong("workspaceKeyVersion").toULong(), g.getString("wrappingSalt"), g.getString("wrappingNonce"), g.getString("encryptedKey"))
            workspaces.put(json(com.hushos.core.workspaceGrantRewrap(userId, oldRoot, newRoot, grant, keyVersion)))
        }
        call(context, "/api/auth/security/finish", JSONObject().put("action", "master-key").put("attemptToken", challenge.getString("attemptToken"))
            .put("finishLoginRequest", finish.request).put("registrationRecord", registered.record)
            .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey))
            .put("recovery", json(recovery.envelope)).put("identity", json(identity)).put("workspaces", workspaces))
        Shared.writeDevice(context, deviceRemember(userId, newRoot, sealed.keyVersion, sealed.credentialVersion, UUID.randomUUID().toString()))
        return recovery.phrase
    }

    fun updateName(context: Context, name: String): SessionUser =
        call(context, "/api/auth/profile", JSONObject().put("name", name)).optJSONObject("user")?.let(SessionUser::from)
            ?: throw AuthFailure("HushOS returned no account.")

    /* The recovery key as the server keeps it (for the kit file) and whether its phrase was confirmed as saved. */
    fun recoveryBackup(context: Context): Pair<JSONObject, Boolean> = call(context, "/api/auth/recovery-key").let {
        (it.optJSONObject("recovery") ?: throw AuthFailure("This account has no recovery key.")) to it.optBoolean("confirmed")
    }

    /* Marks the phrase as saved, as the web does after its check; the server refuses an older phrase's version. */
    fun confirmRecovery(context: Context, recoveryVersion: Long) {
        call(context, "/api/auth/recovery-key/confirm", JSONObject().put("recoveryVersion", recoveryVersion))
    }

    fun storage(context: Context): StorageAllowance = call(context, "/api/auth/storage").getJSONObject("storage").let {
        StorageAllowance(it.getString("quotaBytes").toLong(), it.getString("usedBytes").toLong())
    }

    fun billing(context: Context): BillingSummary = call(context, "/api/billing").let {
        val subscription = it.optJSONObject("subscription")
        BillingSummary(it.optBoolean("enabled"), subscription?.optString("productName"), subscription?.optString("currentPeriodEnd"), subscription?.optBoolean("cancelAtPeriodEnd") ?: false)
    }

    private fun envelope(json: JSONObject) = AccountKeyEnvelope(
        json.getInt("envelopeVersion").toUInt(), json.getLong("keyVersion").toULong(), json.getLong("credentialVersion").toULong(),
        json.getString("wrappingSalt"), json.getString("wrappingNonce"), json.getString("encryptedKey"),
    )

    /* The old password opens the account key; the new one seals it again one credential version up. */
    fun changePassword(context: Context, current: String, new: String) {
        val login = opaqueStartLogin(current)
        val registration = opaqueStartRegistration(new)
        val challenge = call(context, "/api/auth/security/start", JSONObject().put("action", "password")
            .put("startLoginRequest", login.request).put("registrationRequest", registration.request))
        val finish = opaqueFinishLogin(current, login.state, challenge.getString("loginResponse")) ?: throw AuthFailure("The current password is not right.")
        val userId = challenge.getString("userId")
        val old = envelope(challenge.getJSONObject("envelope"))
        val accountKey = accountUnlock(userId, finish.exportKey, old)
        val registered = opaqueFinishRegistration(new, registration.state, challenge.getString("registrationResponse"))
        val sealed = accountSeal(userId, registered.exportKey, accountKey, old.keyVersion, old.credentialVersion + 1uL)
        call(context, "/api/auth/security/finish", JSONObject().put("action", "password").put("attemptToken", challenge.getString("attemptToken"))
            .put("finishLoginRequest", finish.request).put("registrationRecord", registered.record)
            .put("envelope", JSONObject().put("envelopeVersion", sealed.envelopeVersion.toInt()).put("keyVersion", sealed.keyVersion.toLong())
                .put("credentialVersion", sealed.credentialVersion.toLong()).put("wrappingSalt", sealed.wrappingSalt)
                .put("wrappingNonce", sealed.wrappingNonce).put("encryptedKey", sealed.encryptedKey)))
        Shared.writeDevice(context, deviceRemember(userId, accountKey, sealed.keyVersion, sealed.credentialVersion, UUID.randomUUID().toString()))
    }

    /* Proves the password once more, then the server removes the account; every local trace goes with it. */
    fun deleteAccount(context: Context, password: String) {
        val login = opaqueStartLogin(password)
        val started = call(context, "/api/auth/delete/start", JSONObject().put("startLoginRequest", login.request))
        val finish = opaqueFinishLogin(password, login.state, started.getString("loginResponse")) ?: throw AuthFailure("The password is not right.")
        call(context, "/api/auth/delete/finish", JSONObject().put("attemptToken", started.getString("attemptToken")).put("finishLoginRequest", finish.request))
        Shared.clearSession(context)
        Shared.clearDevice(context)
        AccountStore.of(context).wipe()
    }

    /* Ends the session on the server, then removes it, the remembered account key and every file of the account from this phone. */
    fun signOut(context: Context) {
        Shared.session(context)?.let { session ->
            val cookieName = if (session.origin.startsWith("https:")) "__Host-hushos-session" else "hushos-session"
            runCatching { post(session.origin, "/api/auth/logout", JSONObject(), "$cookieName=${session.token}") }
        }
        Shared.clearSession(context)
        Shared.clearDevice(context)
        AccountStore.of(context).wipe()
    }
}
