package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.TrustedKeys
import com.hushos.core.VersionStatement
import com.hushos.core.base64urlEncode
import com.hushos.core.metadataIntegrity
import com.hushos.core.metadataSavedSign
import com.hushos.core.metadataSign
import com.hushos.core.randomBytes
import com.hushos.core.signingPublicKey
import com.hushos.core.versionIntegrity
import com.hushos.core.versionSavedSign
import com.hushos.core.versionSign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/*
 * Saved copies, by where they came from (docs/integrity-design.md): a save from a link is signed with the saved
 * statements and shows no mark, only a neutral line in Info; a copy of a verified original is clean; a copy of
 * anything else keeps its warning. Every signature is read back as another device would, under this person's key.
 */
class SavedCopyTest {
    private val me = "11111111-1111-4111-8111-111111111111"
    private val maya = "22222222-2222-4222-8222-222222222222"
    private val intruder = "44444444-4444-4444-8444-444444444444"
    private val mySeed = randomBytes(32u)
    private val myKey = signingPublicKey(mySeed)
    private val mayaSeed = randomBytes(32u)
    private val intruderSeed = randomBytes(32u)
    private val ws = "600e9d40-c3b4-49bd-8e63-9bd7b3f63dbc"
    private val statement = MetadataStatement(ws, "dc94437c-d237-4f94-bef8-9caeb51bea5e", NodeKind.FILE, 1uL)
    private val versionStatement = VersionStatement(ws, statement.nodeId, "9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d", "471517d1-c35e-4f99-83b9-067be718ecb1", 3u)
    private val envelope = randomBytes(64u)
    private val keyEnvelope = randomBytes(84u)

    private val mayaPin = randomBytes(32u).let { enc ->
        TestPins.verified(maya, "maya@example.org", "Maya", base64urlEncode(enc), base64urlEncode(signingPublicKey(mayaSeed)))
    }
    private fun trust() = Trust.of(me, myKey, emptyList(), mapOf(maya to mayaPin))

    /* A node as served: its metadata and version signed by `signer` with the given signatures. */
    private fun node(signer: String, metadataSignature: ByteArray, versionSigner: String = signer, versionSignature: ByteArray) = NodeView(
        statement.nodeId, ws, "parent", "file", 2uL, 1uL, "k", statement.metadataVersion, base64urlEncode(envelope),
        VersionView(versionStatement.versionId, versionStatement.objectId, base64urlEncode(keyEnvelope), "ready", 3u, 1, "n", null, Signer(versionSigner),
            base64urlEncode(versionSignature)),
        null, null, null, metadataSigner = Signer(signer), metadataSignature = base64urlEncode(metadataSignature),
    )

    private fun savedBy(signer: String, seed: ByteArray) =
        node(signer, metadataSavedSign(seed, statement, envelope), versionSignature = versionSavedSign(seed, versionStatement, keyEnvelope))

    /* What a copy signed under `prior` reads as on another of this person's devices. */
    private fun readBack(prior: Prior): Pair<Integrity, Integrity> {
        val mine = TrustedKeys(myKey, emptyList())
        val metadata = metadataIntegrity(mine, statement, envelope, copyMetadataSignature(mySeed, statement, envelope, prior))
        val version = versionIntegrity(mine, versionStatement, keyEnvelope, copyVersionSignature(mySeed, versionStatement, keyEnvelope, prior))
        return metadata to version
    }

    @Test
    fun aSaveFromALinkIsSignedSavedThoughNothingCouldBeChecked() {
        // A visitor never sees signatures: the prior is unchecked, yet the save goes ahead and reads as saved, not as
        // re-sealed (Unverified on something kept on purpose) and never as verified.
        assertEquals(Integrity.SAVED_FROM_LINK to Integrity.SAVED_FROM_LINK, readBack(Prior.FROM_LINK))
    }

    @Test
    fun aCopyOfAVerifiedOriginalIsClean() {
        val own = node(me, metadataSign(mySeed, statement, envelope), versionSignature = versionSign(mySeed, versionStatement, keyEnvelope))
        assertEquals(Integrity.VERIFIED to Integrity.VERIFIED, readBack(Prior.of(own, trust())))
        // A share from a checked contact is a verified original too.
        val fromMaya = node(maya, metadataSign(mayaSeed, statement, envelope), versionSignature = versionSign(mayaSeed, versionStatement, keyEnvelope))
        assertEquals(Integrity.VERIFIED to Integrity.VERIFIED, readBack(Prior.of(fromMaya, trust())))
    }

    @Test
    fun aCopyOfAnUnverifiedOriginalKeepsItsWarning() {
        val planted = node(intruder, metadataSign(intruderSeed, statement, envelope), versionSignature = versionSign(intruderSeed, versionStatement, keyEnvelope))
        assertEquals(Integrity.RESEALED to Integrity.RESEALED, readBack(Prior.of(planted, trust())))
        // Saved by someone nobody checked: as unverified as anything else they wrote, so a copy does not turn it saved.
        assertEquals(Integrity.RESEALED to Integrity.RESEALED, readBack(Prior.of(savedBy(intruder, intruderSeed), trust())))
    }

    @Test
    fun aCopyOfSomethingThisPersonSavedFromALinkStaysSaved() {
        assertEquals(Integrity.SAVED_FROM_LINK to Integrity.SAVED_FROM_LINK, readBack(Prior.of(savedBy(me, mySeed), trust())))
    }

    @Test
    fun aCopyNotFromALinkIsNotSignedWithoutTheTrustSet() {
        val prior = Prior.of(savedBy(me, mySeed), null)
        assertThrows(TrustUnavailable::class.java) { copyMetadataSignature(mySeed, statement, envelope, prior) }
        assertThrows(TrustUnavailable::class.java) { copyVersionSignature(mySeed, versionStatement, keyEnvelope, prior) }
    }

    @Test
    fun savedFromALinkShowsNoMarkAnywhereAndANeutralLineInInfo() {
        val ready = TrustState.Ready(trust())
        val mine = savedBy(me, mySeed)
        assertNull(unverifiedOf(mine, trust()))
        assertNull(markOf(mine, ready))
        assertNull(providerSummary(mine, ready))
        assertEquals("Saved from a link by you. HushOS can’t confirm who made the original.", savedLineOf(mine, ready))
        // Saved by a checked contact: named from the pin.
        assertEquals("Saved from a link by Maya. HushOS can’t confirm who made the original.", savedLineOf(savedBy(maya, mayaSeed), ready))
    }

    @Test
    fun aSavedNameNeverHidesAContentProblem() {
        // The name saved by this person, the content signed by someone nobody checked: marked, and no saved line.
        val mixed = node(me, metadataSavedSign(mySeed, statement, envelope), versionSigner = intruder, versionSignature = versionSign(intruderSeed, versionStatement, keyEnvelope))
        val ready = TrustState.Ready(trust())
        assertEquals(Integrity.UNKNOWN_SIGNER, markOf(mixed, ready)?.integrity)
        assertEquals("Unverified", providerSummary(mixed, ready))
        assertNull(savedLineOf(mixed, ready))
    }

    @Test
    fun savedBySomeoneNobodyCheckedIsMarked() {
        val ready = TrustState.Ready(trust())
        val theirs = savedBy(intruder, intruderSeed)
        assertNotNull(markOf(theirs, ready))
        assertEquals("Unverified", providerSummary(theirs, ready))
        assertNull(savedLineOf(theirs, ready))
    }

    @Test
    fun whileTrustFailedASavedCopyIsUncheckedNotQuiet() {
        val mine = savedBy(me, mySeed)
        assertEquals("Unverified: HushOS couldn’t check who wrote this", providerSummary(mine, TrustState.Failed))
        assertNull(savedLineOf(mine, TrustState.Failed))
    }
}
