package com.hushos.app.data

import com.hushos.core.HybridPublicKey
import com.hushos.core.IdentityKeys
import com.hushos.core.PinnedKeys
import com.hushos.core.PublicIdentity
import com.hushos.core.ServedKeys
import com.hushos.core.SettingsEnvelope
import com.hushos.core.ShareContext
import com.hushos.core.SuccessionLink
import com.hushos.core.base64urlDecode
import com.hushos.core.identityFingerprintOfKeys
import com.hushos.core.identityVerifyKeys
import com.hushos.core.keyDigest
import com.hushos.core.pinVerified
import com.hushos.core.settingsOpen
import com.hushos.core.shareOpen
import com.hushos.core.successionChainVerify
import org.json.JSONArray
import org.json.JSONObject

/*
 * Someone's public identity as the server serves it (contact lookups, a share's granter, shared-by-me grantees,
 * rotation work, report operators; docs/identity-pq-design.md): all four public keys and a version 2 identity's keys
 * statement. A version 1 identity (not upgraded yet) has no ML-DSA key and no statement and is trusted with nothing;
 * only a version 3 pin vouches for any of these.
 */
data class ServedIdentity(
    /* The identity's generation: a succession raises it, and a pin remembers it. Null when the server sent none. */
    val keyVersion: ULong?,
    val encryptionPublicKey: String,
    val signingPublicKey: String,
    val mlDsaPublicKey: String? = null,
    val kemPublicKey: String? = null,
    val identityVersion: Int = 1,
    val keysSignature: String? = null,
) {
    /*
     * Whether this is a version 2 identity whose keys statement holds (both halves of its hybrid signature, over all
     * four keys, the account and the key version): the only kind words can be compared over. Not by itself a reason
     * to trust anyone; a words check over the version 3 fingerprint is.
     */
    fun keysHold(userId: String): Boolean {
        if (identityVersion != 2) return false
        val version = keyVersion ?: return false
        val mlDsa = mlDsaPublicKey ?: return false
        val kem = kemPublicKey ?: return false
        val signature = keysSignature ?: return false
        return runCatching { identityVerifyKeys(userId, PublicIdentity(version, encryptionPublicKey, signingPublicKey, mlDsa, kem, signature)) }.getOrDefault(false)
    }

    /* As the API serves it, for code that takes the wire shape (planReseal). */
    fun toJson(): JSONObject = JSONObject().put("keyVersion", keyVersion?.toLong() ?: JSONObject.NULL).put("identityVersion", identityVersion)
        .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey)
        .put("mlDsaPublicKey", mlDsaPublicKey ?: JSONObject.NULL).put("kemPublicKey", kemPublicKey ?: JSONObject.NULL)
        .put("keysSignature", keysSignature ?: JSONObject.NULL)

    companion object {
        private fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).ifEmpty { null }

        fun from(json: JSONObject) = ServedIdentity(
            if (!json.has("keyVersion") || json.isNull("keyVersion")) null else json.optLong("keyVersion").takeIf { it >= 1 }?.toULong(),
            json.optString("encryptionPublicKey"), json.optString("signingPublicKey"),
            json.text("mlDsaPublicKey"), json.text("kemPublicKey"),
            json.optInt("identityVersion", 1), json.text("keysSignature"),
        )
    }
}

/* A person as `POST /api/auth/contacts/lookup` describes them. */
data class Contact(val userId: String, val name: String, val email: String, val served: ServedIdentity) {
    val encryptionPublicKey: String get() = served.encryptionPublicKey
    val signingPublicKey: String get() = served.signingPublicKey
    val keyVersion: ULong? get() = served.keyVersion

    /*
     * Whether their identity is version 2 with a keys statement that holds: false for someone who has not signed in
     * since the post-quantum release, whose words cannot be compared yet.
     */
    val upgraded: Boolean by lazy { served.keysHold(userId) }

    /* The version 3 fingerprint over their four keys, to compare over another channel; null until they upgraded. */
    val fingerprint: String? by lazy {
        if (!upgraded) null else runCatching {
            identityFingerprintOfKeys(base64urlDecode(served.encryptionPublicKey), base64urlDecode(served.signingPublicKey),
                base64urlDecode(served.mlDsaPublicKey!!), base64urlDecode(served.kemPublicKey!!))
        }.getOrNull()
    }
}

/*
 * What a pin keeps of a contact, as the settings document stores it. A version 3 pin (docs/identity-pq-design.md 2)
 * holds the X25519 and Ed25519 keys, the SHA-256 (hex) of the ML-DSA and ML-KEM keys, and the version 3 fingerprint
 * over all four; it is version 3 exactly when it carries `mlDsaPublicKeyHash`. Pins made before trust nothing.
 */
data class ContactPin(
    val userId: String, val email: String, val name: String, val encryptionPublicKey: String, val signingPublicKey: String,
    val fingerprint: String, val pinnedAt: String, val kemPublicKeyHash: String?, val mlDsaPublicKeyHash: String?,
    /* The identity version the pin was made or last followed at; null on pins made before successions. */
    val keyVersion: ULong? = null,
    /* Signing keys this person held before, each vouched for by a checked succession: what they signed then still verifies. */
    val previousSigningKeys: List<String> = emptyList(),
    /* When the pin followed a signed succession to new keys, until the words are compared again: People says so. */
    val keysReplacedAt: String? = null,
) {
    /*
     * Whether the words were compared over all four keys: a version 3 pin whose stored fingerprint is the version 3 one
     * over its X25519 and Ed25519 keys and the two digests. A pin from before the release (no ML-DSA digest), or one
     * whose fingerprint is not the current one over the pinned keys, vouches for nothing.
     */
    val verified: Boolean by lazy { pinVerified(encryptionPublicKey, signingPublicKey, mlDsaPublicKeyHash, kemPublicKeyHash, fingerprint) }

    val displayName: String get() = name.ifEmpty { email }

    /* Writes the pin's fields into `json`, leaving any field another client added as it was. */
    fun writeInto(json: JSONObject): JSONObject {
        json.put("userId", userId).put("email", email).put("name", name)
            .put("encryptionPublicKey", encryptionPublicKey).put("signingPublicKey", signingPublicKey).put("fingerprint", fingerprint)
            .put("pinnedAt", pinnedAt).put("kemPublicKeyHash", kemPublicKeyHash ?: JSONObject.NULL)
            .put("keyVersion", keyVersion?.toLong() ?: JSONObject.NULL)
        if (mlDsaPublicKeyHash == null) json.remove("mlDsaPublicKeyHash") else json.put("mlDsaPublicKeyHash", mlDsaPublicKeyHash)
        if (previousSigningKeys.isEmpty()) json.remove("previousSigningKeys") else json.put("previousSigningKeys", JSONArray(previousSigningKeys))
        if (keysReplacedAt == null) json.remove("keysReplacedAt") else json.put("keysReplacedAt", keysReplacedAt)
        return json
    }

    companion object {
        fun from(json: JSONObject) = ContactPin(
            json.getString("userId"), json.optString("email"), json.optString("name"), json.getString("encryptionPublicKey"),
            json.optString("signingPublicKey"), json.optString("fingerprint"), json.optString("pinnedAt"),
            if (json.isNull("kemPublicKeyHash")) null else json.optString("kemPublicKeyHash").ifEmpty { null },
            if (json.isNull("mlDsaPublicKeyHash")) null else json.optString("mlDsaPublicKeyHash").ifEmpty { null },
            if (!json.has("keyVersion") || json.isNull("keyVersion")) null else json.optLong("keyVersion").takeIf { it >= 1 }?.toULong(),
            json.optJSONArray("previousSigningKeys")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } }.orEmpty(),
            if (json.isNull("keysReplacedAt")) null else json.optString("keysReplacedAt").ifEmpty { null },
        )

        /*
         * The version 3 pin of keys whose words were just compared: their X25519 and Ed25519 keys, the digests of their
         * ML-DSA and ML-KEM keys, and the fingerprint over all four. Null when the served identity has no ML-DSA or
         * ML-KEM key (not upgraded): words are never compared over fewer than four keys.
         */
        fun ofServed(userId: String, email: String, name: String, served: ServedIdentity, pinnedAt: String): ContactPin? {
            val mlDsa = served.mlDsaPublicKey ?: return null
            val kem = served.kemPublicKey ?: return null
            val print = runCatching {
                identityFingerprintOfKeys(base64urlDecode(served.encryptionPublicKey), base64urlDecode(served.signingPublicKey), base64urlDecode(mlDsa), base64urlDecode(kem))
            }.getOrNull() ?: return null
            return ContactPin(userId, email, name, served.encryptionPublicKey, served.signingPublicKey, print, pinnedAt,
                keyDigest(base64urlDecode(kem)), keyDigest(base64urlDecode(mlDsa)), served.keyVersion)
        }
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
 * The lookup's verdict against the pin: `changed` when the served keys differ from it and no signed chain explains it,
 * `recheck` when the pin itself vouches for nothing over keys that did not change ("Check words again"), `followed`
 * when the keys changed by a succession the old keys signed and the pin now holds the new ones. `upgraded` says whether
 * words can be compared at all (see Contact.upgraded).
 */
data class Lookup(val contact: Contact, val pinned: ContactPin?, val changed: Boolean, val recheck: Boolean = false, val followed: Boolean = false) {
    val upgraded: Boolean get() = contact.upgraded
}

/* SHA-256 (hex) of a base64url public key, or null when it does not decode. */
private fun digestOf(publicKey: String): String? = runCatching { keyDigest(base64urlDecode(publicKey)) }.getOrNull()

/*
 * What a pin says about the keys the server serves for that person now (docs/identity-pq-design.md 2), as
 * packages/drive's comparePin:
 * - SAME: a version 3 pin, the served X25519 and Ed25519 keys are the pinned ones, and the served ML-DSA and ML-KEM
 *   keys match its digests;
 * - RECHECK: a pin from before the release (or one whose words never covered its keys) over the same X25519 and
 *   Ed25519 keys: only comparing words again trusts them; until then, nothing is trusted;
 * - SUCCESSION: other keys at a higher key version, which a signed chain from a version 3 pin may explain;
 * - CHANGED: anything else, including a served identity with no ML-DSA key, or one whose ML-DSA or ML-KEM key
 *   differs, beside the pinned classical keys.
 */
enum class PinComparison { SAME, RECHECK, SUCCESSION, CHANGED }

fun comparePin(pin: ContactPin, served: ServedIdentity): PinComparison {
    val sameKeys = pin.encryptionPublicKey == served.encryptionPublicKey && pin.signingPublicKey == served.signingPublicKey
    if (sameKeys) {
        if (!pin.verified) return PinComparison.RECHECK
        val mlDsa = served.mlDsaPublicKey ?: return PinComparison.CHANGED
        val kem = served.kemPublicKey ?: return PinComparison.CHANGED
        return if (digestOf(mlDsa) == pin.mlDsaPublicKeyHash && digestOf(kem) == pin.kemPublicKeyHash) PinComparison.SAME else PinComparison.CHANGED
    }
    // A succession is always to a version 2 identity, and only a version 3 pin passes trust on.
    if (served.mlDsaPublicKey == null || served.kemPublicKey == null) return PinComparison.CHANGED
    val version = served.keyVersion ?: return PinComparison.CHANGED
    // A pin with no version: the chain is then looked for from 1.
    if (version > (pin.keyVersion ?: 1uL) && pin.verified) return PinComparison.SUCCESSION
    return PinComparison.CHANGED
}

/*
 * The key version a chain is asked for from: always the first, so the request says nothing of the version a pin is
 * at (docs/integrity-design.md, "Who sees whom"). The core finds where the pinned keys enter the chain by keys.
 */
const val CHAIN_FROM: ULong = 1uL

/*
 * The pin after a succession, or null when the chain does not carry it from the pinned keys to the served ones (the
 * core checks every link, version 2 only: continuity by keys, ML-DSA included, each signed with both halves by the
 * keys it replaces, versions rising, the served four keys at the end). A pin that follows becomes the version 3 pin of
 * the served keys, keeps every signing key the chain passed through (what they signed before still verifies), and is
 * marked so People can suggest comparing words again: a succession made with stolen keys is still a change the person
 * did not make.
 */
fun followSuccession(pin: ContactPin, served: ServedIdentity, links: List<SuccessionLink>, now: String): ContactPin? {
    if (comparePin(pin, served) != PinComparison.SUCCESSION) return null
    val mlDsaHash = pin.mlDsaPublicKeyHash ?: return null
    val version = served.keyVersion ?: return null
    val mlDsa = served.mlDsaPublicKey ?: return null
    val kem = served.kemPublicKey ?: return null
    val holds = runCatching {
        successionChainVerify(pin.userId, PinnedKeys(pin.keyVersion, pin.encryptionPublicKey, pin.signingPublicKey, mlDsaHash),
            ServedKeys(version, served.encryptionPublicKey, served.signingPublicKey, mlDsa, kem), links)
    }.getOrDefault(false)
    if (!holds) return null
    val next = ContactPin.ofServed(pin.userId, pin.email, pin.name, served, pin.pinnedAt) ?: return null
    val start = links.indexOfFirst { it.oldEncryptionPublicKey == pin.encryptionPublicKey && it.oldSigningPublicKey == pin.signingPublicKey }
    val passed = links.drop(start).map { it.oldSigningPublicKey }
    return next.copy(
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

    /* The document to seal: always version 2, whatever was read (the core raises it too). */
    fun text(): String = json.put("version", 2).toString()

    companion object {
        fun parse(text: String, version: ULong) = Settings(JSONObject(text), version)
        /* Version 2, the only document version written (docs/identity-pq-design.md 2): it may hold version 3 pins. */
        fun empty(version: ULong = 0uL) = Settings(JSONObject().put("version", 2).put("contacts", JSONObject()), version)
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
    class Changed(name: String) : GranterTrust("$name’s keys have changed since you checked them. Check it’s them in People you share with before opening what they shared.")
    /*
     * Pinned, but the pin vouches for nothing: one made before the words covered all four keys (or one whose fingerprint
     * isn't the current one). Shares from them open once both people have compared words again.
     */
    class Recheck(name: String) : GranterTrust("$name’s keys were upgraded. Compare words with them again in People you share with; shares from $name open once you’ve both done it.")
    /*
     * Other keys served at a newer version than the pin's: maybe a succession, but only checking says so (the server
     * picks the version), and a pin follows only when the person checks them again, never on its own.
     */
    class Replaced(name: String) : GranterTrust("$name’s sharing keys changed since you checked them. Check them again in People you share with to open what they shared.")
    /* Sealed under keys the granter has since replaced, which vouch for nothing now: it waits for their re-seal. */
    class Reshare(name: String) : GranterTrust("$name replaced their sharing keys since sharing this. Ask $name to share it again.")
}

/*
 * The keys a granter's share must be signed with: the pin's current Ed25519 key, and the served ML-DSA key only if its
 * digest is the pin's (packages/drive's granterKeysOf). Null when the pin has no ML-DSA digest or the served key is not
 * the pinned one.
 */
fun granterKeysOf(pin: ContactPin, served: ServedIdentity): HybridPublicKey? {
    val pinned = pin.mlDsaPublicKeyHash ?: return null
    val mlDsa = served.mlDsaPublicKey ?: return null
    if (digestOf(mlDsa) != pinned) return null
    return runCatching { HybridPublicKey(base64urlDecode(pin.signingPublicKey), base64urlDecode(mlDsa)) }.getOrNull()
}

/* The keys a share from this granter opens under, and whether the pin followed keys they replaced (so an older share may wait for a re-seal). */
class GranterKey(val keys: HybridPublicKey, val replacedKeys: Boolean) {
    val signingPublicKey: ByteArray get() = keys.signingPublicKey
}

/*
 * The keys to open a share from this granter with: the pinned current Ed25519 key and the served ML-DSA key whose
 * digest the pin holds, and only when the pin is version 3 and the server serves the pinned keys
 * (docs/identity-pq-design.md 2 and 3). Keys the granter replaced open nothing: a share sealed under one waits for
 * their re-seal. Newer keys served than the pin's are not followed here; the person checks them again. Taking the
 * served keys of someone not pinned would let a server fake a share "from" anyone with keys of its own, so that is
 * refused, and nothing is pinned here.
 */
fun granterKey(granterId: String, granterName: String, served: ServedIdentity, pins: Map<String, ContactPin>): GranterKey {
    val pin = pins[granterId] ?: throw GranterTrust.Unverified(granterName)
    when (comparePin(pin, served)) {
        PinComparison.SAME -> Unit
        PinComparison.RECHECK -> throw GranterTrust.Recheck(granterName)
        PinComparison.SUCCESSION -> throw GranterTrust.Replaced(granterName)
        // A pin that vouches for nothing, served other keys: still a words check first.
        PinComparison.CHANGED -> throw if (!pin.verified) GranterTrust.Recheck(granterName) else GranterTrust.Changed(granterName)
    }
    val keys = granterKeysOf(pin, served) ?: throw GranterTrust.Changed(granterName)
    return GranterKey(keys, pin.previousSigningKeys.isNotEmpty())
}

/*
 * A received share's node key: the granter's keys against each of this account's identities, the current one first.
 * A share row does not say which identity it was sealed to, and after a succession shares sealed to earlier keys open
 * only with them. Suite 4 checks both halves of the granter's signature before anything is decapsulated, so a share
 * signed by anyone else, under a key the granter replaced, or in an older suite never opens; the first refusal is what
 * is said, unless the granter replaced keys, when the share is waiting for their re-seal.
 */
fun openShare(envelope: ByteArray, granter: GranterKey, granterName: String, identities: List<IdentityKeys>, ctx: ShareContext): ByteArray {
    var refusal: Exception? = null
    for (identity in identities) {
        try {
            return shareOpen(envelope, granter.keys, identity, ctx)
        } catch (error: Exception) {
            if (refusal == null) refusal = error
        }
    }
    if (granter.replacedKeys) throw GranterTrust.Reshare(granterName)
    throw refusal ?: ShareRefused("This share could not be opened.")
}

/*
 * The ML-KEM key a share to `pin` is sealed to, checked against the pin before anything is sealed to them: on share,
 * on rotation, on the re-seal pass, never falling back to X25519 alone (packages/drive's trustGrantee). The pin must be
 * version 3 and the served keys the pinned ones, the ML-KEM key by its digest; anything else is refused with what to do.
 */
fun granteeKem(pin: ContactPin, served: ServedIdentity): ByteArray {
    val name = pin.displayName
    if (!pin.verified) throw SharingRefused("Check $name’s words again in People you share with: this pin was made before the words covered all their keys.")
    when (comparePin(pin, served)) {
        PinComparison.SAME -> Unit
        PinComparison.RECHECK -> throw SharingRefused("$name’s keys were upgraded. Compare words with them again in People you share with.")
        PinComparison.SUCCESSION -> throw SharingRefused("$name’s sharing keys changed since you checked them. Check them again in People you share with.")
        PinComparison.CHANGED -> throw SharingRefused("$name’s keys have changed since you checked them. Check it’s them in People you share with.")
    }
    // comparePin said SAME: the served ML-KEM key is the one the version 3 pin's digest names.
    val kem = served.kemPublicKey ?: throw SharingRefused("$name hasn’t got post-quantum keys yet. They get them the next time they sign in.")
    return base64urlDecode(kem)
}

fun settingsEnvelope(json: JSONObject) = SettingsEnvelope(
    json.getInt("version").toUInt(), json.getLong("settingsVersion").toULong(), json.getString("nonce"), json.getString("ciphertext"),
)

/* One row of "shared by me": a share or a link, and the item it points at once its name is opened. */
data class SharedByMe(val id: String, val item: Opened?, val node: NodeView, val share: OwnedShare?, val link: LinkView?)
