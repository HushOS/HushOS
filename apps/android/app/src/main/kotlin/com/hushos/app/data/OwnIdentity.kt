package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.IdentityKeys
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprintOfKeys
import com.hushos.core.identityOpen
import com.hushos.core.identityUpgrade

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
