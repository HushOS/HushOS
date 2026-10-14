package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.SuccessionLink
import com.hushos.core.base64urlEncode
import org.json.JSONObject
import java.io.File

/* The web's own fixtures (crates/hushos-core/fixtures/web.json): what packages/crypto wrote, so these tests hold the app to the web's bytes. */
object WebFixture {
    val json = JSONObject(File("../../../crates/hushos-core/fixtures/web.json").readText())

    /* An identity envelope as the server serves it, parsed the way the app parses one. */
    fun identity(json: JSONObject): IdentityEnvelope = Auth.identityEnvelope(json)

    fun link(json: JSONObject) = SuccessionLink(
        json.getLong("oldKeyVersion").toULong(), json.getLong("newKeyVersion").toULong(),
        json.getString("oldEncryptionPublicKey"), json.getString("oldSigningPublicKey"), json.getString("oldMlDsaPublicKey"),
        json.getString("newEncryptionPublicKey"), json.getString("newSigningPublicKey"), json.getString("newMlDsaPublicKey"),
        json.getString("newKemPublicKey"), json.getString("signature"),
    )

    /* A version 2 envelope's public identity as the server serves it to contacts. */
    fun served(envelope: IdentityEnvelope) = ServedIdentity(
        envelope.keyVersion, envelope.encryptionPublicKey, envelope.signingPublicKey,
        envelope.mlDsa?.publicKey, envelope.kem?.publicKey, envelope.version.toInt(), envelope.keysSignature,
    )
}

/* Pins as comparing words writes them, for tests whose subject is not the lattice keys themselves. */
object TestPins {
    /* Stand-ins for the ML-DSA (1952 bytes) and ML-KEM (1184 bytes) keys: a pin keeps only their digests. */
    val mlDsa: String = base64urlEncode(ByteArray(1952) { 3 })
    val kem: String = base64urlEncode(ByteArray(1184) { 4 })

    fun served(enc: String, sig: String, keyVersion: ULong? = 2uL, mlDsa: String = this.mlDsa, kem: String = this.kem) =
        ServedIdentity(keyVersion, enc, sig, mlDsa, kem, 2, null)

    /* A version 3 pin over these keys: the X25519 and Ed25519 keys, both digests, the fingerprint over all four. */
    fun verified(
        userId: String, email: String, name: String, enc: String, sig: String,
        keyVersion: ULong? = null, previous: List<String> = emptyList(), mlDsa: String = this.mlDsa, kem: String = this.kem,
    ): ContactPin = ContactPin.ofServed(userId, email, name, served(enc, sig, keyVersion ?: 2uL, mlDsa, kem), "2026-10-01T00:00:00Z")!!
        .copy(keyVersion = keyVersion, previousSigningKeys = previous)

    /* The same keys pinned before the release: no ML-DSA digest, which alone makes it trust nothing. */
    fun preRelease(pin: ContactPin) = pin.copy(mlDsaPublicKeyHash = null)
}
