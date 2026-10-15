package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.IdentityKeys
import com.hushos.core.IdentitySuccession
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprintOfKeys
import com.hushos.core.identityOpen
import com.hushos.core.identitySucceed
import com.hushos.core.identityUpgrade

/* The identity served for a succession is not the one this device opened: nothing is signed over it. */
class IdentityMoved : Refused("Nothing was changed", "Your keys changed on another device. Try again.")

/*
 * Opens this account's identity under the account key, upgrading a version 1 identity to version 2 before anything
 * is signed with it (docs/identity-pq-design.md 2), as the web's openIdentity does:
 * - the served identity is opened (which proves every half against the account key) and held to this device's marks:
 *   a lower key version than one opened before, or the version 1 form where version 2 was seen, is a rollback;
 * - a version 1 identity is upgraded in the core (the same X25519, Ed25519 and ML-KEM keys and key version, a new
 *   ML-DSA seed that must open again to the same public key, the keys statement signed with both halves) and stored
 *   through `store`; a 409 means another device stored its upgrade first, and the identity `served` gives now is
 *   opened instead, so the account never ends with two ML-DSA keys;
 * - only a version 2 identity with all four keys is returned, and the marks rise to it.
 * `upgraded` is called once this device's upgrade was stored (not when another device's was adopted).
 */
fun openOwnIdentity(
    userId: String,
    accountKey: ByteArray,
    marks: SettingsMark,
    served: () -> IdentityEnvelope,
    store: (IdentityEnvelope) -> IdentityEnvelope,
    upgraded: () -> Unit = {},
): IdentityKeys {
    val envelope = served()
    var opened = identityOpen(userId, accountKey, envelope)
    marks.checkIdentity(userId, opened.keyVersion, opened.identityVersion)
    if (opened.identityVersion == 1u) {
        val next = identityUpgrade(userId, accountKey, envelope)
        val (stored, ours) = try {
            store(next) to true
        } catch (error: AuthFailure) {
            if (error.status != 409) throw error
            served() to false
        }
        opened = identityOpen(userId, accountKey, stored)
        marks.checkIdentity(userId, opened.keyVersion, opened.identityVersion)
        if (ours && opened.identityVersion == 2u) upgraded()
    }
    if (opened.identityVersion != 2u || opened.mlDsaPublicKey == null || opened.kemPublicKey == null)
        throw AuthFailure("Your keys could not be upgraded. Try again.")
    marks.recordIdentity(userId, opened.keyVersion, opened.identityVersion)
    return opened
}

/*
 * The person's own twelve words: the version 3 fingerprint over the four public keys the core re-derived from the
 * private halves it opened, never the served ones.
 */
fun ownFingerprint(keys: IdentityKeys): String {
    val mlDsa = keys.mlDsaPublicKey ?: throw AuthFailure("Your keys could not be upgraded. Try again.")
    val kem = keys.kemPublicKey ?: throw AuthFailure("Your keys could not be upgraded. Try again.")
    return identityFingerprintOfKeys(base64urlDecode(keys.encryptionPublicKey), base64urlDecode(keys.signingPublicKey), base64urlDecode(mlDsa), base64urlDecode(kem))
}

/*
 * Whether a served envelope is the identity this device opened: the same four public keys, key version and identity
 * version. The core opens whatever envelope it is handed under the account key, so an older identity of the account
 * (one it replaced) would open too.
 */
fun isOpened(opened: IdentityKeys, envelope: IdentityEnvelope): Boolean =
    envelope.encryptionPublicKey == opened.encryptionPublicKey && envelope.signingPublicKey == opened.signingPublicKey &&
        envelope.mlDsa?.publicKey == opened.mlDsaPublicKey && envelope.kem?.publicKey == opened.kemPublicKey &&
        envelope.keyVersion == opened.keyVersion && envelope.version == opened.identityVersion

/*
 * The succession of the identity this device opened (docs/identity-pq-design.md 2): signed over the envelope the server
 * serves now only when it is that identity, since the core signs over whichever envelope it is given. Anything else
 * (an identity the account replaced, served again, or another device's newer one) is refused before anything is signed.
 */
fun succeedOwnIdentity(userId: String, accountKey: ByteArray, opened: IdentityKeys, served: IdentityEnvelope): IdentitySuccession {
    if (!isOpened(opened, served)) throw IdentityMoved()
    return identitySucceed(userId, accountKey, served)
}

/*
 * This account's identity in use and the earlier ones a succession left, opened once and kept for the process. Both are
 * read without the lock (the fast path) and written only under it: `open` runs under it, so callers that arrive
 * meanwhile wait rather than upgrade twice, and `forget` waits for an open under way and then forgets what it cached,
 * rather than that open caching the replaced identity again after it. The history is read outside the lock (it can
 * take a while) and is kept, or returned, only beside the identity it was read with: forgotten meanwhile, both are read
 * again, so no caller gets one identity's history paired with another's current key.
 */
internal class OpenedIdentities(private val open: () -> IdentityKeys, private val history: () -> List<IdentityKeys>) {
    @Volatile private var identity: IdentityKeys? = null
    /* Newest first; null until asked (shares sealed to earlier keys need them). */
    @Volatile private var earlier: List<IdentityKeys>? = null
    private val lock = Any()

    /* The identity in use (see openOwnIdentity). */
    fun current(): IdentityKeys = identity ?: synchronized(lock) { identity ?: open().also { identity = it } }

    /* After a succession, or a signature the server refused: the next caller opens what the server serves now. */
    fun forget() = synchronized(lock) {
        identity = null
        earlier = null
    }

    /*
     * Every identity this account has held, the current one first, then the earlier ones newest first. Without the
     * network the earlier ones are left out this time, not forgotten; `strict` fails instead, for a caller that would
     * misread their absence.
     */
    fun all(strict: Boolean = false): List<IdentityKeys> {
        while (true) {
            // The identity and the history kept beside it, taken together: never a cached history from after a forget.
            val (current, kept) = synchronized(lock) { (identity ?: open().also { identity = it }) to earlier }
            val loaded = kept ?: (if (strict) history() else runCatching(history).getOrNull())
            // Forgotten while it was read (and perhaps opened again since): it may be the history before a succession.
            val consistent = synchronized(lock) {
                (identity === current).also { same -> if (same && kept == null && loaded != null) earlier = loaded }
            }
            if (!consistent) continue
            return listOf(current) + loaded.orEmpty().filter { it.signingPublicKey != current.signingPublicKey }
        }
    }
}
