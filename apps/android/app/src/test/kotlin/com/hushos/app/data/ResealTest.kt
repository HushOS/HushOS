package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.MetadataStatement
import com.hushos.core.NodeKind
import com.hushos.core.TrustedKeys
import com.hushos.core.VersionStatement
import com.hushos.core.base64urlEncode
import com.hushos.core.identityFingerprint
import com.hushos.core.metadataIntegrity
import com.hushos.core.metadataSign
import com.hushos.core.randomBytes
import com.hushos.core.signingPublicKey
import com.hushos.core.versionIntegrity
import com.hushos.core.versionSign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/*
 * Re-sealing never launders (docs/integrity-design.md, "Re-sealing never launders"). A copy or a rotation re-signs
 * what it re-seals as the record checked before: a planted record copied by this person must read as re-locked by
 * them, never as theirs; one that verified stays verified; and without the trust set nothing is re-signed. Each
 * signature made here is read back the way another device would, under this person's current key.
 */
class ResealTest {
    private val me = "11111111-1111-4111-8111-111111111111"
    private val intruder = "44444444-4444-4444-8444-444444444444"
    private val mySeed = randomBytes(32u)
    private val myKey = signingPublicKey(mySeed)
    private val intruderSeed = randomBytes(32u)
    private val ws = "600e9d40-c3b4-49bd-8e63-9bd7b3f63dbc"
    private val source = MetadataStatement(ws, "dc94437c-d237-4f94-bef8-9caeb51bea5e", NodeKind.FILE, 1uL)
    private val sourceVersion = VersionStatement(ws, source.nodeId, "9fdf27a0-d662-4744-b7a4-9a5ae9d7ee1d", "471517d1-c35e-4f99-83b9-067be718ecb1", 3u)
    private val envelope = randomBytes(64u)
    private val keyEnvelope = randomBytes(84u)
    private val copy = MetadataStatement(ws, "7a1c7e3e-1b7e-4a40-9d2a-2a3c5b6d7e8f", NodeKind.FILE, 1uL)
    private val copyVersion = VersionStatement(ws, copy.nodeId, "0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e", sourceVersion.objectId, 3u)
    private val copyEnvelope = randomBytes(64u)
    private val copyKeyEnvelope = randomBytes(84u)

    private fun trust(): Trust = Trust.of(me, myKey, emptyList(), emptyMap())

    /* A node as the server serves it: the source record, signed by `signer` with `seed`. */
    private fun sourceNode(signer: String, seed: ByteArray) = NodeView(
        source.nodeId, ws, "parent", "file", 2uL, 1uL, "k", source.metadataVersion, base64urlEncode(envelope),
        VersionView(sourceVersion.versionId, sourceVersion.objectId, base64urlEncode(keyEnvelope), "ready", 3u, 1, "n", null, Signer(signer),
            base64urlEncode(versionSign(seed, sourceVersion, keyEnvelope))),
        null, null, null, metadataSigner = Signer(signer), metadataSignature = base64urlEncode(metadataSign(seed, source, envelope)),
    )

    private fun readBack(prior: Prior): Pair<Integrity, Integrity> {
        val mine = TrustedKeys(myKey, emptyList())
        val metadata = metadataIntegrity(mine, copy, copyEnvelope, metadataSignature(mySeed, copy, copyEnvelope, prior.metadata))
        val version = versionIntegrity(mine, copyVersion, copyKeyEnvelope, versionSignature(mySeed, copyVersion, copyKeyEnvelope, prior.version))
        return metadata to version
    }

    @Test
    fun aPlantedRecordCopiedByThisPersonReadsAsReLockedNeverAsTheirs() {
        val planted = sourceNode(intruder, intruderSeed)
        val prior = Prior.of(planted, trust())
        assertEquals(Prior(Integrity.UNKNOWN_SIGNER, Integrity.UNKNOWN_SIGNER), prior)
        assertEquals(Integrity.RESEALED to Integrity.RESEALED, readBack(prior))
    }

    @Test
    fun aRecordThatVerifiedIsReSignedWithTheOrdinaryStatement() {
        val own = sourceNode(me, mySeed)
        assertEquals(Integrity.VERIFIED to Integrity.VERIFIED, readBack(Prior.of(own, trust())))
    }

    @Test
    fun aRecordSignedUnderAKeyThisPersonReplacedIsReSealedNotRevived() {
        val earlier = randomBytes(32u)
        val old = sourceNode(me, earlier)
        val prior = Prior.of(old, Trust.of(me, myKey, listOf(signingPublicKey(earlier)), emptyMap()))
        assertEquals(Prior(Integrity.RETIRED_KEY, Integrity.RETIRED_KEY), prior)
        assertEquals(Integrity.RESEALED to Integrity.RESEALED, readBack(prior))
    }

    @Test
    fun theNameAndTheContentAreJudgedApart() {
        // An honest name over content the intruder re-keyed: only the content is re-sealed.
        val own = sourceNode(me, mySeed)
        val mixed = own.copy(currentVersion = own.currentVersion!!.copy(signer = Signer(intruder), signature = base64urlEncode(versionSign(intruderSeed, sourceVersion, keyEnvelope))))
        assertEquals(Integrity.VERIFIED to Integrity.RESEALED, readBack(Prior.of(mixed, trust())))
    }

    @Test
    fun withoutTheTrustSetNothingIsReSigned() {
        val prior = Prior.of(sourceNode(me, mySeed), null)
        assertEquals(Prior(Integrity.UNCHECKED, Integrity.UNCHECKED), prior)
        assertThrows(TrustUnavailable::class.java) { metadataSignature(mySeed, copy, copyEnvelope, prior.metadata) }
        assertThrows(TrustUnavailable::class.java) { versionSignature(mySeed, copyVersion, copyKeyEnvelope, prior.version) }
    }

    @Test
    fun aContactsReSealedRecordCopiedOnIsReSealedAgain() {
        // Maya, checked, re-locked something she didn't vouch for; copying it on must not turn it into a clean record.
        val maya = "22222222-2222-4222-8222-222222222222"
        val mayaSeed = randomBytes(32u)
        val mayaKey = signingPublicKey(mayaSeed)
        val enc = randomBytes(32u)
        val pin = ContactPin(maya, "maya@example.org", "Maya", base64urlEncode(enc), base64urlEncode(mayaKey),
            identityFingerprint(enc, mayaKey), "2026-10-01T00:00:00Z", null)
        val relocked = sourceNode(maya, mayaSeed).let { node ->
            node.copy(metadataSignature = base64urlEncode(com.hushos.core.metadataResealedSign(mayaSeed, source, envelope)))
        }
        val prior = Prior.of(relocked, Trust.of(me, myKey, emptyList(), mapOf(maya to pin)))
        assertEquals(Integrity.RESEALED, prior.metadata)
        assertEquals(Integrity.VERIFIED, prior.version)
        assertEquals(Integrity.RESEALED to Integrity.VERIFIED, readBack(prior))
    }
}
