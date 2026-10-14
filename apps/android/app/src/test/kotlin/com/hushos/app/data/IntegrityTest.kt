package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.identityFingerprint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * What a row shows for who wrote it (docs/integrity-design.md, "Reading" and "Round 3"). The node, its version and
 * their signatures (ordinary and re-sealed) are the web's fixture, signed by the fixture identity, so a verdict here
 * is a verdict on the web's bytes. The server names the writer by account id alone: a record is verified only under
 * the current key this device trusts for that id, a name comes only from a pin, and anything this device could not
 * check is marked, never passed.
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
    private val maya = Signer("22222222-2222-4222-8222-222222222222")
    private val sam = Signer("33333333-3333-4333-8333-333333333333")
    private val otherKey = base64urlEncode(ByteArray(32) { 6 }.also { it[0] = 1 })

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

    private fun pin(userId: String, signing: String, encryption: String = writerEncryption, fingerprint: String? = null, previous: List<String> = emptyList(), name: String = "Maya Lindqvist") =
        TestPins.verified(userId, "x@example.org", name, encryption, signing, previous = previous).let { if (fingerprint != null) it.copy(fingerprint = fingerprint) else it }

    private fun trust(vararg pins: ContactPin) = Trust.of(me, ByteArray(32) { 9 }, emptyList(), pins.associateBy { it.userId })

    @Test
    fun aRecordSignedByAContactWhoseWordsWereCheckedShowsNothing() {
        assertNull(unverifiedOf(node(), trust(pin(maya.id, writerKey))))
    }

    @Test
    fun ownRecordsVerifyOnlyUnderTheCurrentKeyAndAnEarlierOneIsARetiredKey() {
        val mine = node(Signer(me), versionSigner = Signer(me))
        assertNull(unverifiedOf(mine, Trust.of(me, base64urlDecode(writerKey), emptyList(), emptyMap())))
        // Replaced since: what the old key signed vouches for nothing any more.
        val retired = unverifiedOf(mine, Trust.of(me, ByteArray(32) { 9 }, listOf(base64urlDecode(writerKey)), emptyMap()))!!
        assertEquals(Integrity.RETIRED_KEY, retired.integrity)
        assertEquals("Signed with keys you have since replaced.", retired.explanation())
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(mine, Trust.of(me, ByteArray(32) { 9 }, emptyList(), emptyMap()))?.integrity)
    }

    @Test
    fun aKeyAContactReplacedYieldsARetiredKeyNeverAPass() {
        // Their succession vouched for the old key; it still only says "signed with keys Maya has since replaced".
        val retired = unverifiedOf(node(), trust(pin(maya.id, otherKey, previous = listOf(writerKey))))!!
        assertEquals(Integrity.RETIRED_KEY, retired.integrity)
        assertEquals("Signed with keys Maya Lindqvist has since replaced.", retired.explanation())
        assertEquals(Integrity.BAD_SIGNATURE, unverifiedOf(node(), trust(pin(maya.id, otherKey)))?.integrity)
    }

    @Test
    fun aReSealedSignatureIsNeverVerifiedAndSaysWhoReLockedIt() {
        val resealed = node(metadataSignature = metadata.getString("resealed"), versionSignature = version.getString("resealed"))
        val byMaya = unverifiedOf(resealed, trust(pin(maya.id, writerKey)))!!
        assertEquals(Integrity.RESEALED, byMaya.integrity)
        assertEquals("Re-locked by Maya Lindqvist; HushOS couldn’t confirm who wrote it before.", byMaya.explanation())
        val mine = node(Signer(me), metadata.getString("resealed"), Signer(me), version.getString("resealed"))
        assertEquals("Re-locked by you; HushOS couldn’t confirm who wrote it before.", unverifiedOf(mine, Trust.of(me, base64urlDecode(writerKey), emptyList(), emptyMap()))!!.explanation())
    }

    @Test
    fun someoneNotCheckedIsNamedByNobodyAndAStrippedSignatureReadsTheSame() {
        val unknown = unverifiedOf(node(), trust())!!
        assertEquals(Integrity.UNKNOWN_SIGNER, unknown.integrity)
        assertEquals(Writer.Unknown(null), unknown.writer)
        assertEquals("HushOS can’t confirm who wrote this. It was added or last changed by someone you haven’t checked.", unknown.explanation())
        // A server that strips the signature gets no milder wording to hide behind.
        val stripped = unverifiedOf(node(metadataSignature = null, versionSigner = null, versionSignature = null), trust(pin(maya.id, writerKey)))!!
        assertEquals(Integrity.UNSIGNED, stripped.integrity)
        assertTrue(unknown.explanation().startsWith(stripped.explanation().removeSuffix(".")))
        // No way to check someone without an address to look up; with an unchecked pin there is one.
        assertNull(unknown.checkEmail)
        val unchecked = pin(maya.id, writerKey, fingerprint = "")
        assertEquals("x@example.org", unverifiedOf(node(), trust(unchecked))!!.checkEmail)
    }

    @Test
    fun aPinWhoseWordsWereNeverCheckedOverBothKeysVouchesForNothingAndLendsNoName() {
        val stale = pin(maya.id, writerKey, fingerprint = identityFingerprint(base64urlDecode(writerEncryption), ByteArray(32) { 7 }, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
        val result = unverifiedOf(node(), trust(stale))!!
        assertEquals(Integrity.UNKNOWN_SIGNER, result.integrity)
        assertFalse(result.explanation().contains("Maya"))
        // Pinned before the release (words over two keys): their records read as from someone not yet checked.
        val preRelease = TestPins.preRelease(pin(maya.id, writerKey))
        assertEquals(Integrity.UNKNOWN_SIGNER, unverifiedOf(node(), trust(preRelease))?.integrity)
        assertEquals("x@example.org", unverifiedOf(node(), trust(preRelease))?.checkEmail)
        assertEquals(Integrity.UNKNOWN_SIGNER, unverifiedOf(node(), trust(stale.copy(signingPublicKey = "", fingerprint = "")))?.integrity)
    }

    @Test
    fun aServerThatNamesSomeoneElseAsTheWriterGetsABadSignatureNotAPass() {
        // Sam is checked, with keys of his own; Maya's signature does not hold under them.
        val relabelled = node(metadataSigner = sam, versionSigner = sam)
        val result = unverifiedOf(relabelled, trust(pin(sam.id, otherKey, name = "Sam")))!!
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
        // An unknown writer of the name, and content under a checked name that doesn't hold: the bad signature wins, and names its signer.
        val mixed = unverifiedOf(node(metadataSigner = sam, versionSigner = maya, versionSignature = metadata.getString("signature")), checked)!!
        assertEquals(Integrity.BAD_SIGNATURE, mixed.integrity)
        assertEquals(maya.id, mixed.signerId)
        assertEquals(Writer.Contact("Maya Lindqvist"), mixed.writer)
    }

    @Test
    fun withoutATrustSetOrWhenTheCheckThrowsEveryRecordIsUncheckedNeverClean() {
        // Whom this person trusts did not load: a record that would verify is still marked.
        assertEquals(Integrity.UNCHECKED, unverifiedOf(node(), null)?.integrity)
        assertEquals(Integrity.UNCHECKED, markOf(node(), TrustState.Failed)?.integrity)
        assertEquals("HushOS couldn’t check who wrote this. Try again later.", markOf(node(), TrustState.Failed)!!.explanation())
        // An envelope that can't even be decoded makes the check throw: that is unchecked, not "no mark".
        assertEquals(Integrity.UNCHECKED, markOf(node(metadataEnvelope = "%%%"), TrustState.Ready(trust(pin(maya.id, writerKey))))?.integrity)
        // Still loading is the one state without a mark.
        assertNull(markOf(node(), TrustState.Loading))
    }

    @Test
    fun aFailedLoadFailsClosedAndOnlyALostNetworkKeepsWhatWasLoaded() {
        val ready = TrustState.Ready(trust(pin(maya.id, writerKey)))
        assertSame(ready, ready.after(Result.failure(Unreachable())))
        // Settings refused as rolled back, an identity that won't open: whatever was loaded before no longer counts.
        assertSame(TrustState.Failed, ready.after(Result.failure(SettingsRolledBack())))
        assertSame(TrustState.Failed, ready.after(Result.failure(IdentityRolledBack())))
        assertSame(TrustState.Failed, TrustState.Loading.after(Result.failure(Unreachable())))
        val fresh = trust()
        assertEquals(TrustState.Ready(fresh), TrustState.Failed.after(Result.success(fresh)))
    }
}
