package com.hushos.app.data

import com.hushos.core.MetadataContext
import com.hushos.core.checkName
import com.hushos.core.metadataOpen
import com.hushos.core.metadataSeal
import com.hushos.core.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.CharacterCodingException

/*
 * Names with a lone surrogate, as the web treats them: one the platform hands over is made well
 * formed (each lone half becomes U+FFFD, pairs kept) and uploads under a readable name; one a person
 * typed is refused in the web's words. Without either, the bindings throw a CharacterCodingException,
 * an IOException the app would show as being offline.
 */
class NamesTest {
    private val ctx = MetadataContext("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", 1uL)

    @Test
    fun wellFormedKeepsPairsAndReplacesOnlyLoneHalves() {
        assertEquals("a�b😀�", wellFormed("a\uD800b😀\uDC00"))
        // Halves in the wrong order are two lone ones; a high half at the end has no partner.
        assertEquals("��", wellFormed("\uDE00\uD83D"))
        assertEquals("x�", wellFormed("x\uD800"))
        assertEquals("plain é 😀", wellFormed("plain é 😀"))
    }

    @Test
    fun anUploadNameWithALoneSurrogateIsCleanedBeforeSealingAndOpens() {
        val metadata = newFileMetadata("a\uD800b", "text/plain", 3uL, null, emptyMap())
        assertEquals("a�b", metadata.name)
        val key = randomBytes(32u)
        assertEquals("a�b", metadataOpen(ctx, key, metadataSeal(ctx, key, metadata)).name)
    }

    @Test
    fun aTypedNameWithALoneSurrogateIsRefusedInWordsNotAsACodingError() {
        // What reaching the core directly does: the bindings refuse to encode it.
        assertThrows(CharacterCodingException::class.java) { checkName("x\uD800") }
        val refused = assertThrows(NameCantBeSaved::class.java) { typedName("x\uD800") }
        assertEquals(NAME_CANT_BE_SAVED, Problems.of(refused).body)
        assertEquals("x😀", typedName("x😀"))
    }

    @Test
    fun aSharedTextsNameCutAtEightyNeverEndsInHalfAPair() {
        val name = SharedText.fileName("a".repeat(79) + "😀", "Note")
        assertEquals(wellFormed(name), name)
        assertEquals("a".repeat(79) + "�.txt", name)
    }
}
