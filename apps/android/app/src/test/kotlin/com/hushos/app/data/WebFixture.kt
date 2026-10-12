package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.IdentityKem
import com.hushos.core.SuccessionLink
import org.json.JSONObject
import java.io.File

/* The web's own fixtures (crates/hushos-core/fixtures/web.json): what packages/crypto wrote, so these tests hold the app to the web's bytes. */
object WebFixture {
    val json = JSONObject(File("../../../crates/hushos-core/fixtures/web.json").readText())

    fun identity(json: JSONObject): IdentityEnvelope {
        val kem = json.optJSONObject("kem")?.let { IdentityKem(it.getString("publicKey"), it.getString("seedNonce"), it.getString("encryptedSeed"), it.getString("signature")) }
        return IdentityEnvelope(
            json.getInt("version").toUInt(), json.getLong("keyVersion").toULong(), json.getString("wrappingSalt"),
            json.getString("encryptionPublicKey"), json.getString("encryptionPrivateKeyNonce"), json.getString("encryptedEncryptionPrivateKey"),
            json.getString("signingPublicKey"), json.getString("signingSeedNonce"), json.getString("encryptedSigningSeed"), kem,
        )
    }

    fun link(json: JSONObject) = SuccessionLink(
        json.getLong("oldKeyVersion").toULong(), json.getLong("newKeyVersion").toULong(),
        json.getString("oldEncryptionPublicKey"), json.getString("oldSigningPublicKey"),
        json.getString("newEncryptionPublicKey"), json.getString("newSigningPublicKey"),
        json.getString("newKemPublicKey"), json.getString("signature"),
    )
}
