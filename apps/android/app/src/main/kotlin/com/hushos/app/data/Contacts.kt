package com.hushos.app.data

import com.hushos.core.IdentityKeys
import com.hushos.core.PinnedKeys
import com.hushos.core.ServedKeys
import com.hushos.core.SettingsEnvelope
import com.hushos.core.ShareContext
import com.hushos.core.SuccessionLink
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprint
import com.hushos.core.kemBindingVerify
import com.hushos.core.keyDigest
import com.hushos.core.settingsOpen
import com.hushos.core.shareOpen
import com.hushos.core.successionChainVerify
import org.json.JSONArray
import org.json.JSONObject

/* A person as `POST /api/auth/contacts/lookup` describes them. */
data class Contact(
    val userId: String, val name: String, val email: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val kemPublicKey: String?, val kemSignature: String?,
    /* The identity's generation: a succession raises it, and a pin remembers it to ask for the chain from there. */
    val keyVersion: ULong? = null,
) {
    val served: ServedIdentity get() = ServedIdentity(keyVersion, encryptionPublicKey, signingPublicKey, kemPublicKey)

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
    /* The identity version the pin was made or last followed at; null on pins made before successions. */
    val keyVersion: ULong? = null,
    /* Signing keys this person held before, each vouched for by a checked succession: what they signed then still verifies. */
    val previousSigningKeys: List<String> = emptyList(),
    /* When the pin followed a signed succession to new keys, until the words are compared again: People says so. */
    val keysReplacedAt: String? = null,
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

    /* Whether the keys served now are the pinned ones; a pin from before signing keys were kept compares its X25519 key alone. */
    fun matches(served: ServedIdentity): Boolean =
        encryptionPublicKey == served.encryptionPublicKey && (signingPublicKey.isEmpty() || served.signingPublicKey.isEmpty() || signingPublicKey == served.signingPublicKey)

    /* Writes the pin's fields into `json`, leaving any field another client added as it was. */
    fun writeInto(json: JSONObject): JSONObject {
        json.put("userId", userId).put("email", email).put("name", name)
            .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey).put("fingerprint", fingerprint)
            .put("pinnedAt", pinnedAt).put("kemPublicKeyHash", kemPublicKeyHash ?: JSONObject.NULL)
            .put("keyVersion", keyVersion?.toLong() ?: JSONObject.NULL)
        if (previousSigningKeys.isEmpty()) json.remove("previousSigningKeys") else json.put("previousSigningKeys", JSONArray(previousSigningKeys))
        if (keysReplacedAt == null) json.remove("keysReplacedAt") else json.put("keysReplacedAt", keysReplacedAt)
        return json
    }

    companion object {
        fun from(json: JSONObject) = ContactPin(
            json.getString("userId"), json.optString("email"), json.optString("name"), json.getString("encryptionPublicKey"),
            json.optString("signingPublicKey"), json.optString("fingerprint"), json.optString("pinnedAt"),
            if (json.isNull("kemPublicKeyHash")) null else json.optString("kemPublicKeyHash"),
            if (!json.has("keyVersion") || json.isNull("keyVersion")) null else json.optLong("keyVersion").takeIf { it >= 1 }?.toULong(),
            json.optJSONArray("previousSigningKeys")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } }.orEmpty(),
            if (json.isNull("keysReplacedAt")) null else json.optString("keysReplacedAt").ifEmpty { null },
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

/*
 * The lookup's verdict against the pin: `changed` when a key differs from it, `recheck` when the pin itself vouches for
 * nothing, `followed` when the keys changed by a succession the old keys signed and the pin now holds the new ones.
 */
data class Lookup(val contact: Contact, val pinned: ContactPin?, val changed: Boolean, val recheck: Boolean = false, val followed: Boolean = false)

/* An identity as the server serves it (lookup, shared-with-me, rotation work): what a pin is checked against. */
data class ServedIdentity(val keyVersion: ULong?, val encryptionPublicKey: String, val signingPublicKey: String, val kemPublicKey: String?) {
    companion object {
        fun from(json: JSONObject) = ServedIdentity(
            if (!json.has("keyVersion") || json.isNull("keyVersion")) null else json.getLong("keyVersion").toULong(),
            json.optString("encryptionPublicKey"), json.optString("signingPublicKey"),
            json.optJSONObject("kem")?.optString("publicKey")?.ifEmpty { null },
        )
    }
}

/*
 * Whether the served keys are worth a succession chain: the pin vouches for its keys, and other keys are served at a
 * higher version than the pin's (any version, for a pin from before successions). Anything else is the changed-key
 * warning without asking.
 */
fun needsChain(pin: ContactPin, served: ServedIdentity): Boolean {
    val version = served.keyVersion ?: return false
    return pin.verified && !pin.matches(served) && version > (pin.keyVersion ?: 0uL)
}

/*
 * The key version a chain is asked for from: always the first, so the request says nothing of the version a pin is
 * at (docs/integrity-design.md, "Who sees whom"). The core finds where the pinned keys enter the chain by keys.
 */
const val CHAIN_FROM: ULong = 1uL

/*
 * The pin after a succession, or null when the chain does not carry it from the pinned keys to the served ones (the
 * core checks every link: continuity by keys, each signed by the key it replaces, versions rising, the served keys at
 * the end). A pin that follows takes the new keys, fingerprint, post-quantum key and version, keeps every signing key
 * the chain passed through (what they signed before still verifies), and is marked so People can suggest comparing
 * words again: a succession made with a stolen key is still a change the person did not make.
 */
fun followSuccession(pin: ContactPin, served: ServedIdentity, links: List<SuccessionLink>, now: String): ContactPin? {
    if (!needsChain(pin, served)) return null
    // Shared-with-me serves no post-quantum key: the last link's is the one its signed statement names (by digest).
    val kem = served.kemPublicKey ?: links.lastOrNull()?.newKemPublicKey ?: return null
    val version = served.keyVersion ?: return null
    val holds = runCatching {
        successionChainVerify(pin.userId, PinnedKeys(pin.keyVersion, pin.encryptionPublicKey, pin.signingPublicKey),
            ServedKeys(version, served.encryptionPublicKey, served.signingPublicKey, kem), links)
    }.getOrDefault(false)
    if (!holds) return null
    val start = links.indexOfFirst { it.oldEncryptionPublicKey == pin.encryptionPublicKey && it.oldSigningPublicKey == pin.signingPublicKey }
    val passed = links.drop(start).map { it.oldSigningPublicKey }
    return pin.copy(
        encryptionPublicKey = served.encryptionPublicKey, signingPublicKey = served.signingPublicKey,
        fingerprint = identityFingerprint(base64urlDecode(served.encryptionPublicKey), base64urlDecode(served.signingPublicKey)),
        kemPublicKeyHash = keyDigest(base64urlDecode(kem)), keyVersion = version,
        previousSigningKeys = (pin.previousSigningKeys + passed).distinct().filter { it != served.signingPublicKey },
        keysReplacedAt = now,
    )
}

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
        fun empty(version: ULong = 0uL) = Settings(JSONObject().put("version", 1).put("contacts", JSONObject()), version)
    }
}

/*
 * The settings out of a served envelope: version 2 under the settings key. Version 1 (sealed under a key off the
 * identity, which a stolen identity key opened) no longer opens: it is no settings at all, at the envelope's version,
 * so the next save (always version 2) goes over it and starts afresh.
 */
/*
 * The settings as served, held to this device's marks (SettingsMark.checkSettings) and opened. No document is empty
 * settings at the stored sequence (0 for no row, above 0 for a version 1 row served as none), so the next save names
 * that sequence as expectedVersion and seals at one above it, the version the server stores it at. A document's own
 * sequence (bound into its seal) is what counts when there is one.
 */
fun readServedSettings(userId: String, envelope: SettingsEnvelope?, sequence: ULong, mark: SettingsMark, settingsKey: () -> ByteArray): Settings {
    if (envelope == null) {
        mark.checkSettings(userId, sequence, present = false)
        if (sequence > 0uL) mark.recordSettings(userId, sequence, sealedV2 = false)
        return Settings.empty(sequence)
    }
    mark.checkSettings(userId, envelope.settingsVersion, present = true)
    val settings = openSettingsText(userId, if (envelope.version == 2u) settingsKey() else null, envelope)
    mark.recordSettings(userId, envelope.settingsVersion, sealedV2 = envelope.version == 2u)
    return settings
}

fun openSettingsText(userId: String, settingsKey: ByteArray?, envelope: SettingsEnvelope): Settings =
    settingsOpen(userId, settingsKey, envelope)?.let { Settings.parse(it, envelope.settingsVersion) } ?: Settings.empty(envelope.settingsVersion)

class ContactChanged : Exception("This contact's key changed since you pinned it. Check the fingerprint and pin it again.")

/* Why sharing to a pinned person is refused: the sentence says what to do. */
class SharingRefused(message: String) : Refused("Nothing was shared", message)

/* Why a received share stays shut until the person acts in People you share with. */
sealed class GranterTrust(message: String) : Exception(message) {
    class Unverified(name: String) : GranterTrust("Add $name in People you share with and check their words to open what they shared.")
    class Changed(name: String) : GranterTrust("$name’s key has changed since you added them. Check it’s them in People you share with before opening what they shared.")
    /* Pinned, but the pin vouches for nothing (an old pin, or a fingerprint that isn't the current one): treated like Unverified. */
    class Recheck(name: String) : GranterTrust("Check $name’s words again in People you share with to open what they shared.")
    /*
     * Other keys served at a newer version than the pin's: maybe a succession, but only checking says so (the server
     * picks the version), and a pin follows only when the person checks them again, never on its own.
     */
    class Replaced(name: String) : GranterTrust("$name’s sharing keys changed since you checked them. Check them again in People you share with to open what they shared.")
    /* Sealed under keys the granter has since replaced, which vouch for nothing now: it waits for their re-seal. */
    class Reshare(name: String) : GranterTrust("$name replaced their sharing keys since sharing this. Ask $name to share it again.")
}

/* The one key a share from this granter opens under, and whether the pin followed keys they replaced (so an older share may wait for a re-seal). */
class GranterKey(val signingPublicKey: ByteArray, val replacedKeys: Boolean)

/*
 * The key to open a share from this granter with: the pinned current signing key, and only when the server served
 * those same keys and the pin was checked against both (docs/integrity-design.md, "Retired keys"). Keys the granter
 * replaced open nothing: a share sealed under one waits for their re-seal. Newer keys served than the pin's are not
 * followed here; the person checks them again. Taking the served keys of someone not pinned would let a server fake
 * a share "from" anyone with keys of its own, so that is refused, and nothing is pinned here.
 */
fun granterKey(granterId: String, granterName: String, served: ServedIdentity, pins: Map<String, ContactPin>): GranterKey {
    val pin = pins[granterId] ?: throw GranterTrust.Unverified(granterName)
    if (!pin.verified) throw GranterTrust.Recheck(granterName)
    if (!pin.matches(served)) throw if (needsChain(pin, served)) GranterTrust.Replaced(granterName) else GranterTrust.Changed(granterName)
    return GranterKey(base64urlDecode(pin.signingPublicKey), pin.previousSigningKeys.isNotEmpty())
}

/*
 * A received share's node key: the granter's current key against each of this account's identities, the current one
 * first. A share row does not say which identity it was sealed to, and after a succession shares sealed to earlier
 * keys open only with them. Suite 3 checks the granter's signature before anything is decapsulated, so a share signed
 * by anyone else, or under a key the granter replaced, never opens; the first refusal is what is said, unless the
 * granter replaced keys, when the share is waiting for their re-seal.
 */
fun openShare(envelope: ByteArray, granter: GranterKey, granterName: String, identities: List<IdentityKeys>, ctx: ShareContext): ByteArray {
    var refusal: Exception? = null
    for (identity in identities) {
        try {
            return shareOpen(envelope, granter.signingPublicKey, identity, ctx)
        } catch (error: Exception) {
            if (refusal == null) refusal = error
        }
    }
    if (granter.replacedKeys) throw GranterTrust.Reshare(granterName)
    throw refusal ?: ShareRefused("This share could not be opened.")
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
