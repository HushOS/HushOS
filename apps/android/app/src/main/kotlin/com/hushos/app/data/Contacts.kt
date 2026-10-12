package com.hushos.app.data

import com.hushos.core.SettingsEnvelope
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprint
import com.hushos.core.kemBindingVerify
import com.hushos.core.keyDigest
import org.json.JSONArray
import org.json.JSONObject

/* A person as `POST /api/auth/contacts/lookup` describes them. */
data class Contact(
    val userId: String, val name: String, val email: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val kemPublicKey: String?, val kemSignature: String?,
) {
    /* Ten groups of four hex digits over both public keys, to compare over another channel. */
    val fingerprint: String get() = identityFingerprint(base64urlDecode(encryptionPublicKey), base64urlDecode(signingPublicKey))
    /* Whether the post-quantum key carries a signature by the signing key served with it. Vouches only for a contact
     * not pinned yet, whose words cover that signing key; for a pinned one, see `granteeKem`. */
    val kemSigned: Boolean get() = kemPublicKey != null && kemSignature != null &&
        kemBindingVerify(userId, encryptionPublicKey, signingPublicKey, kemPublicKey, kemSignature)
    val kemHash: String? get() = kemPublicKey?.let { keyDigest(base64urlDecode(it)) }
}

/* What a pin keeps of a contact, as the settings document stores it. */
data class ContactPin(
    val userId: String, val email: String, val name: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val fingerprint: String, val pinnedAt: String, val kemPublicKeyHash: String?,
) {
    /*
     * Whether the words were checked against both keys as they are now: a pin from before signing keys were
     * kept, or one whose stored fingerprint is not the current one over the pinned keys, vouches for nothing.
     */
    val verified: Boolean by lazy {
        signingPublicKey.isNotEmpty() && runCatching {
            identityFingerprint(base64urlDecode(encryptionPublicKey), base64urlDecode(signingPublicKey)) == fingerprint
        }.getOrDefault(false)
    }

    val displayName: String get() = name.ifEmpty { email }

    /* Writes the pin's fields into `json`, leaving any field another client added as it was. */
    fun writeInto(json: JSONObject): JSONObject = json.put("userId", userId).put("email", email).put("name", name)
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

/* The lookup's verdict against the pin: `changed` when a key differs from it, `recheck` when the pin itself vouches for nothing. */
data class Lookup(val contact: Contact, val pinned: ContactPin?, val changed: Boolean, val recheck: Boolean = false)

/*
 * The owner's own record of what they shared: per node, the people it was shared with; per link,
 * its node. The server's lists are only a claim; only what is here is ever sealed again.
 */
data class SharingLedger(val shares: Map<String, Set<String>>, val links: Map<String, String>) {
    fun hasShare(nodeId: String, granteeUserId: String) = shares[nodeId]?.contains(granteeUserId) == true
    fun hasLink(linkId: String, nodeId: String) = links[linkId] == nodeId
}

/*
 * The settings document, opened, as the JSON it is: the pins, the sharing ledger, and whatever
 * another client added, which every edit here keeps as it was. Edits change the JSON in place.
 */
class Settings(val json: JSONObject, val version: ULong) {
    private fun contactsJson(): JSONObject = json.optJSONObject("contacts") ?: JSONObject().also { json.put("contacts", it) }
    private fun sharingJson(): JSONObject = json.optJSONObject("sharing") ?: JSONObject().also { json.put("sharing", it) }
    private fun sharesJson(): JSONObject = sharingJson().let { s -> s.optJSONObject("shares") ?: JSONObject().also { s.put("shares", it) } }
    private fun linksJson(): JSONObject = sharingJson().let { s -> s.optJSONObject("links") ?: JSONObject().also { s.put("links", it) } }

    /* The pins by user id; one that can't be read is left out here and left alone in the document. */
    val contacts: Map<String, ContactPin> get() {
        val entries = json.optJSONObject("contacts") ?: return emptyMap()
        val out = LinkedHashMap<String, ContactPin>()
        for (key in entries.keys()) entries.optJSONObject(key)?.let { runCatching { ContactPin.from(it) }.getOrNull() }?.let { out[key] = it }
        return out
    }

    fun pin(pin: ContactPin) {
        val all = contactsJson()
        all.put(pin.userId, pin.writeInto(all.optJSONObject(pin.userId) ?: JSONObject()))
    }

    fun unpin(userId: String) { contactsJson().remove(userId) }

    /* The first post-quantum key seen signed by a pinned identity, remembered so a different one later is refused; one remembered already stays. */
    fun rememberKem(userId: String, hash: String) {
        val pin = json.optJSONObject("contacts")?.optJSONObject(userId) ?: return
        if (pin.isNull("kemPublicKeyHash")) pin.put("kemPublicKeyHash", hash)
    }

    val ledger: SharingLedger get() {
        val sharing = json.optJSONObject("sharing") ?: return SharingLedger(emptyMap(), emptyMap())
        val shares = HashMap<String, Set<String>>()
        sharing.optJSONObject("shares")?.let { all ->
            for (node in all.keys()) all.optJSONArray(node)?.let { a -> shares[node] = (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } }.toSet() }
        }
        val links = HashMap<String, String>()
        sharing.optJSONObject("links")?.let { all -> for (link in all.keys()) all.optString(link).ifEmpty { null }?.let { links[link] = it } }
        return SharingLedger(shares, links)
    }

    fun addShare(nodeId: String, granteeUserId: String) {
        val shares = sharesJson()
        val people = shares.optJSONArray(nodeId) ?: JSONArray().also { shares.put(nodeId, it) }
        if ((0 until people.length()).none { people.optString(it) == granteeUserId }) people.put(granteeUserId)
    }

    fun removeShare(nodeId: String, granteeUserId: String) {
        val shares = json.optJSONObject("sharing")?.optJSONObject("shares") ?: return
        val people = shares.optJSONArray(nodeId) ?: return
        for (index in people.length() - 1 downTo 0) if (people.optString(index) == granteeUserId) people.remove(index)
        if (people.length() == 0) shares.remove(nodeId)
    }

    fun addLink(linkId: String, nodeId: String) { linksJson().put(linkId, nodeId) }

    fun removeLink(linkId: String) { json.optJSONObject("sharing")?.optJSONObject("links")?.remove(linkId) }

    fun text(): String = json.toString()

    companion object {
        fun parse(text: String, version: ULong) = Settings(JSONObject(text), version)
        fun empty() = Settings(JSONObject().put("version", 1).put("contacts", JSONObject()), 0uL)
    }
}

class ContactChanged : Exception("This contact's key changed since you pinned it. Check the fingerprint and pin it again.")

/* Why sharing to a pinned person is refused: the sentence says what to do. */
class SharingRefused(message: String) : Refused("Nothing was shared", message)

/* Why a received share stays shut until the person acts in People you share with. */
sealed class GranterTrust(message: String) : Exception(message) {
    class Unverified(name: String) : GranterTrust("Add $name in People you share with and check their words to open what they shared.")
    class Changed(name: String) : GranterTrust("$name’s key has changed since you added them. Check it’s them in People you share with before opening what they shared.")
    /* Pinned, but the pin vouches for nothing (an old pin, or a fingerprint that isn't the current one): treated like Unverified. */
    class Recheck(name: String) : GranterTrust("Check $name’s words again in People you share with to open what they shared.")
}

/*
 * The key to open a share from this granter with: the pinned one, and only when the server served that same
 * key and the pin was checked against both keys. Taking the served key of someone not pinned would let a server
 * fake a share "from" anyone with a key of its own, so that is refused, and nothing is pinned here: pinning
 * follows a words check.
 */
fun granterKey(granterId: String, granterName: String, servedKey: String, pins: Map<String, ContactPin>): ByteArray {
    val pin = pins[granterId] ?: throw GranterTrust.Unverified(granterName)
    if (!pin.verified) throw GranterTrust.Recheck(granterName)
    if (pin.encryptionPublicKey != servedKey) throw GranterTrust.Changed(granterName)
    return base64urlDecode(pin.encryptionPublicKey)
}

/* The post-quantum key a share to `pin` is sealed to, and its digest when it is the first one the pin vouches for. */
class GranteeKem(val publicKey: ByteArray, val firstHash: String?)

/*
 * Checks the person's served post-quantum key against their pin before anything is sealed to them:
 * on share, on rotation, never falling back to X25519 alone. A pin that vouches for nothing, a missing
 * key, a key other than the one remembered, or a first key not signed by the pinned identity is refused.
 */
fun granteeKem(pin: ContactPin, kemPublicKey: String?, kemSignature: String?): GranteeKem {
    val name = pin.displayName
    if (!pin.verified) throw SharingRefused("Check $name’s words again in People you share with before you share with them.")
    if (kemPublicKey == null) throw SharingRefused("$name hasn’t set up post-quantum keys yet.")
    val bytes = base64urlDecode(kemPublicKey)
    val hash = keyDigest(bytes)
    pin.kemPublicKeyHash?.let { pinned ->
        if (pinned != hash) throw SharingRefused("$name’s post-quantum key has changed since you pinned it. Check with them before sharing.")
        return GranteeKem(bytes, null)
    }
    // Only the pinned signing key may vouch: the words compared cover it, the served one could be anyone's.
    val signed = kemSignature != null && runCatching { kemBindingVerify(pin.userId, pin.encryptionPublicKey, pin.signingPublicKey, kemPublicKey, kemSignature) }.getOrDefault(false)
    if (!signed) throw SharingRefused("$name’s post-quantum key is not signed by their identity.")
    return GranteeKem(bytes, hash)
}

fun settingsEnvelope(json: JSONObject) = SettingsEnvelope(
    json.getInt("version").toUInt(), json.getLong("settingsVersion").toULong(), json.getString("nonce"), json.getString("ciphertext"),
)

/* One row of "shared by me": a share or a link, and the item it points at once its name is opened. */
data class SharedByMe(val id: String, val item: Opened?, val node: NodeView, val share: OwnedShare?, val link: LinkView?)
