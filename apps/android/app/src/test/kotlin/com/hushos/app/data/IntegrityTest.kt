package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.identityFingerprint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * What a row shows for who wrote it (docs/integrity-design.md, "Reading"). The node, its version and both
 * signatures are the web's fixture, signed by the fixture identity, so a verdict here is a verdict on the
 * web's bytes. The server only names the writer: a record is verified only under keys this device trusts
 * for that name, and a server that relabels, replays or rewrites a record gets it marked, never passed.
 */
class IntegrityTest {
    private val fixture = WebFixture.json
    private val signatures = fixture.getJSONObject("signatures")
    private val metadata = signatures.getJSONObject("metadata")
    private val version = signatures.getJSONObject("version")
    private val writerKey = signatures.getString("signingPublicKey")
    private val identity = fixture.getJSONObject("share").getJSONObject("identity")
    private val writerEncryption = identity.getString("encryptionPublicKey")
    private val me = "11111111-1111-4111-8111-111111111111"
    private val maya = Signer("22222222-2222-4222-8222-222222222222", "Maya Lindqvist", "maya@example.org")
    private val sam = Signer("33333333-3333-4333-8333-333333333333", "Sam", "sam@example.org")

    private fun node(
        metadataSigner: Signer? = maya, metadataSignature: String? = metadata.getString("signature"),
        versionSigner: Signer? = maya, versionSignature: String? = version.getString("signature"),
        metadataVersion: ULong = 3uL, metadataEnvelope: String = metadata.getString("envelope"),
    ): NodeView {
        val statement = metadata.getJSONObject("statement")
        val v = version.getJSONObject("statement")
        return NodeView(
            statement.getString("nodeId"), statement.getString("workspaceId"), "parent", "file", 9uL, 4uL, "k", metadataVersion, metadataEnvelope,
            VersionView(v.getString("versionId"), v.getString("objectId"), version.getString("envelope"), "ready", 3u, 1, "n", null, versionSigner, versionSignature),
            null, null, null, metadataSigner = metadataSigner, metadataSignature = metadataSignature,
        )
    }

    private fun pin(userId: String, signing: String, encryption: String = writerEncryption, fingerprint: String? = null, previous: List<String> = emptyList()) =
        ContactPin(userId, "x@example.org", "X", encryption, signing,
            fingerprint ?: identityFingerprint(base64urlDecode(encryption), base64urlDecode(signing)), "2026-10-01T00:00:00Z", null, previousSigningKeys = previous)

    private fun trust(vararg pins: ContactPin) = Trust.of(me, emptyList(), pins.associateBy { it.userId })

    @Test
    fun aRecordSignedByAContactWhoseWordsWereCheckedShowsNothing() {
        assertNull(unverifiedOf(node(), trust(pin(maya.id, writerKey))))
    }

    @Test
    fun ownRecordsVerifyUnderOwnKeysCurrentOrEarlier() {
        val mine = node(Signer(me, "Me", "me@example.org"), versionSigner = Signer(me, "Me", "me@example.org"))
        assertNull(unverifiedOf(mine, Trust.of(me, listOf(ByteArray(32) { 9 }, base64urlDecode(writerKey)), emptyMap())))
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(mine, Trust.of(me, listOf(ByteArray(32) { 9 }), emptyMap()))?.integrity)
    }

    @Test
    fun someoneNotCheckedIsAnUnknownSignerNamedAsTheServerNamesThem() {
        val unknown = unverifiedOf(node(), trust())!!
        assertEquals(Integrity.UNKNOWN_SIGNER, unknown.integrity)
        assertEquals(maya, unknown.signer)
        assertEquals("Added or last changed by Maya Lindqvist (maya@example.org), whom you haven’t checked yet.", unknown.explanation())
    }

    @Test
    fun aPinWhoseWordsWereNeverCheckedOverBothKeysVouchesForNothing() {
        val stale = pin(maya.id, writerKey, fingerprint = identityFingerprint(base64urlDecode(writerEncryption), ByteArray(32) { 7 }))
        assertEquals(Integrity.UNKNOWN_SIGNER, unverifiedOf(node(), trust(stale))?.integrity)
        assertEquals(Integrity.UNKNOWN_SIGNER, unverifiedOf(node(), trust(stale.copy(signingPublicKey = "", fingerprint = "")))?.integrity)
    }

    @Test
    fun aServerThatNamesSomeoneElseAsTheWriterGetsABadSignatureNotAPass() {
        // Sam is checked, with keys of his own; Maya's signature does not hold under them.
        val relabelled = node(metadataSigner = sam, versionSigner = sam)
        val result = unverifiedOf(relabelled, trust(pin(sam.id, base64urlEncode(ByteArray(32) { 5 }))))!!
        assertEquals(Integrity.BAD_SIGNATURE, result.integrity)
        assertEquals("The signature doesn’t match Sam’s keys. Don’t trust this item.", result.explanation())
    }

    @Test
    fun aRewrittenOrReplayedRecordIsABadSignature() {
        val checked = trust(pin(maya.id, writerKey))
        // Another sealed name under Maya's signature: the digest no longer matches.
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(node(metadataEnvelope = version.getString("envelope")), checked)?.integrity)
        // The same envelope and signature served at a later metadata version (a replayed rename).
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(node(metadataVersion = 4uL), checked)?.integrity)
        // Garbage where a signature should be checks as no valid one, not as none at all.
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(node(metadataSignature = "%%%"), checked)?.integrity)
    }

    @Test
    fun theWorseOfTheNameAndTheContentIsWhatTheRowShows() {
        val checked = trust(pin(maya.id, writerKey))
        // The name verifies but the content was never signed.
        assertEquals(Integrity.UNSIGNED, unverifiedOf(node(versionSigner = null, versionSignature = null), checked)?.integrity)
        assertEquals("Made before HushOS signed changes.", unverifiedOf(node(versionSigner = null, versionSignature = null), checked)!!.explanation())
        // An unknown writer of the name, and content under a checked name that doesn't hold: the bad signature wins, and names its signer.
        val mixed = unverifiedOf(node(metadataSigner = sam, versionSigner = maya, versionSignature = metadata.getString("signature")), checked)!!
        assertEquals(Integrity.BAD_SIGNATURE, mixed.integrity)
        assertEquals(maya, mixed.signer)
    }

    @Test
    fun aKeyAContactReplacedStillVerifiesWhatItSignedWhenTheirSuccessionVouchedForIt() {
        val newKey = base64urlEncode(ByteArray(32) { 6 }.also { it[0] = 1 })
        assertNull(unverifiedOf(node(), trust(pin(maya.id, newKey, previous = listOf(writerKey)))))
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(node(), trust(pin(maya.id, newKey)))?.integrity)
    }
}
