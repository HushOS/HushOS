package com.hushos.app.data

import com.hushos.core.SettingsEnvelope
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprint
import com.hushos.core.kemBindingVerify
import com.hushos.core.keyDigest
import org.json.JSONObject

/* A person as `GET /api/auth/contacts/lookup` describes them. */
data class Contact(
    val userId: String, val name: String, val email: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val kemPublicKey: String?, val kemSignature: String?,
) {
    /* Ten groups of four hex digits, to compare over another channel. */
    val fingerprint: String get() = identityFingerprint(base64urlDecode(encryptionPublicKey))
    /* Whether the post-quantum key carries a signature by this identity. */
    val kemSigned: Boolean get() = kemPublicKey != null && kemSignature != null &&
        kemBindingVerify(userId, encryptionPublicKey, signingPublicKey, kemPublicKey, kemSignature)
    val kemHash: String? get() = kemPublicKey?.let { keyDigest(base64urlDecode(it)) }
}

/* What a pin keeps of a contact, as the settings document stores it. */
data class ContactPin(
    val userId: String, val email: String, val name: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val fingerprint: String, val pinnedAt: String, val kemPublicKeyHash: String?,
) {
    fun toJson(): JSONObject = JSONObject().put("userId", userId).put("email", email).put("name", name)
        .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey).put("fingerprint", fingerprint)
        .put("pinnedAt", pinnedAt).put("kemPublicKeyHash", kemPublicKeyHash ?: JSONObject.NULL)

    companion object {
        fun from(json: JSONObject) = ContactPin(
            json.getString("userId"), json.optString("email"), json.optString("name"), json.getString("encryptionPublicKey"),
            json.optString("signingPublicKey"), json.optString("fingerprint"), json.optString("pinnedAt"),
            if (json.isNull("kemPublicKeyHash")) null else json.optString("kemPublicKeyHash"),
        )
    }
}

/* A share as the owner sees it. */
data class OwnedShare(val id: String, val role: String, val keyEpoch: ULong, val createdAt: String, val suite: Int, val granteeId: String, val granteeName: String, val granteeEmail: String) {
    companion object {
        fun from(json: JSONObject): OwnedShare {
            val grantee = json.getJSONObject("grantee")
            return OwnedShare(json.getString("id"), json.getString("role"), json.getLong("keyEpoch").toULong(), json.getString("createdAt"),
                json.optInt("suite"), grantee.getString("id"), grantee.optString("name"), grantee.optString("email"))
        }
    }
}

/* The lookup's verdict against the pin. */
data class Lookup(val contact: Contact, val pinned: ContactPin?, val changed: Boolean)

/* The settings document, opened: the pins by user id and the version the server holds. */
data class Settings(val contacts: MutableMap<String, ContactPin>, val version: ULong)

class ContactChanged : Exception("This contact's key changed since you pinned it. Check the fingerprint and pin it again.")

fun settingsEnvelope(json: JSONObject) = SettingsEnvelope(
    json.getInt("version").toUInt(), json.getLong("settingsVersion").toULong(), json.getString("nonce"), json.getString("ciphertext"),
)

/* One row of "shared by me": a share or a link, and the item it points at once its name is opened. */
data class SharedByMe(val id: String, val item: Opened?, val node: NodeView, val share: OwnedShare?, val link: LinkView?)
