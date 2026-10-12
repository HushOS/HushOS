package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.VersionStatement
import com.hushos.core.base64urlDecode
import com.hushos.core.metadataIntegrity
import com.hushos.core.versionIntegrity

/*
 * The signing keys this person trusts, by account (docs/integrity-design.md, "Reading"): their own,
 * current and earlier, each proven against its seed when the identity opened; and each verified
 * contact's pinned key with the earlier ones a checked succession vouched for. Anyone else has none,
 * so what they signed reads as an unknown signer, never as verified.
 */
class Trust(val userId: String, private val own: List<ByteArray>, private val contacts: Map<String, List<ByteArray>>) {
    fun keysFor(signerId: String?): List<ByteArray> = when {
        signerId == null -> emptyList()
        signerId.equals(userId, ignoreCase = true) -> own
        else -> contacts[signerId.lowercase()].orEmpty()
    }

    companion object {
        /* An unverified pin (no signing key, or a fingerprint that isn't the current one over its keys) vouches for nothing. */
        fun of(userId: String, ownSigningKeys: List<ByteArray>, pins: Map<String, ContactPin>): Trust = Trust(
            userId, ownSigningKeys,
            pins.values.filter { it.verified }.associate { pin ->
                pin.userId.lowercase() to (listOf(pin.signingPublicKey) + pin.previousSigningKeys).mapNotNull { key -> runCatching { base64urlDecode(key) }.getOrNull() }
            },
        )
    }
}

/* Why a record is not verified, and who the server says wrote it (display only). Verified records have none. */
data class Unverified(val integrity: Integrity, val signer: Signer?)

private fun severity(integrity: Integrity) = when (integrity) {
    Integrity.VERIFIED -> 0
    Integrity.UNSIGNED -> 1
    Integrity.UNKNOWN_SIGNER -> 2
    Integrity.BAD_SIGNATURE -> 3
}

/* Malformed base64 is no signature this device can check: verification fails on it as on any wrong one. */
private fun signatureBytes(value: String?): ByteArray? = value?.let { runCatching { base64urlDecode(it) }.getOrDefault(ByteArray(0)) }

/*
 * A node's metadata and its current version, each checked against the keys trusted for the account
 * the server names as its writer. The worse of the two is what the row shows: a forged version under
 * an honest name is as untrustworthy as a forged name.
 */
fun unverifiedOf(node: NodeView, trust: Trust): Unverified? {
    val metadata = metadataIntegrity(
        trust.keysFor(node.metadataSigner?.id),
        MetadataStatement(node.workspaceId, node.id, if (node.isFolder) NodeKind.FOLDER else NodeKind.FILE, node.metadataVersion),
        base64urlDecode(node.metadataEnvelope), signatureBytes(node.metadataSignature),
    )
    var worst = Unverified(metadata, node.metadataSigner)
    node.currentVersion?.takeIf { !node.isFolder }?.let { version ->
        val content = versionIntegrity(
            trust.keysFor(version.signer?.id),
            VersionStatement(node.workspaceId, node.id, version.id, version.objectId, version.contentSuite),
            base64urlDecode(version.contentKeyEnvelope), signatureBytes(version.signature),
        )
        if (severity(content) > severity(worst.integrity)) worst = Unverified(content, version.signer)
    }
    return worst.takeIf { it.integrity != Integrity.VERIFIED }
}

/* What the Unverified mark explains, per case, in the words every client uses. */
fun Unverified.explanation(): String = when (integrity) {
    Integrity.UNKNOWN_SIGNER -> signer?.let { "Added or last changed by ${it.displayName}${if (it.name.isNotEmpty() && it.email.isNotEmpty()) " (${it.email})" else ""}, whom you haven’t checked yet." }
        ?: "Added or last changed by someone you haven’t checked yet."
    Integrity.BAD_SIGNATURE -> "The signature doesn’t match ${signer?.displayName?.let { "$it’s" } ?: "the writer’s"} keys. Don’t trust this item."
    Integrity.UNSIGNED -> "Made before HushOS signed changes."
    Integrity.VERIFIED -> ""
}
