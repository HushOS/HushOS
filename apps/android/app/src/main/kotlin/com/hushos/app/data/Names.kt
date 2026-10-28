package com.hushos.app.data

import com.hushos.core.NodeMetadata
import com.hushos.core.checkName

/*
 * Names on their way to the core. A Kotlin String may hold a lone surrogate (half of a pair, as a
 * file name from Windows can), which the bindings refuse with a CharacterCodingException, an
 * IOException the app would show as being offline, and which the web's reader refuses as damage.
 */

/*
 * `text` with each lone surrogate replaced by U+FFFD, pairs kept: the web's `wellFormed`
 * (packages/crypto/src/drive.ts). For names the platform hands over (a display name, a shared
 * file's, a picked folder's): such a file uploads under a readable name rather than failing.
 */
fun wellFormed(text: String): String {
    val out = StringBuilder(text.length)
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1])) {
            out.append(c).append(text[i + 1])
            i += 2
            continue
        }
        out.append(if (Character.isSurrogate(c)) '�' else c)
        i++
    }
    return out.toString()
}

const val NAME_CANT_BE_SAVED = "This name has a character that can’t be saved. Type the name again."

class NameCantBeSaved : Refused("That name won’t work", NAME_CANT_BE_SAVED)

/* A name someone typed (a rename, a new folder), checked as the web checks it: a lone surrogate is refused in words. */
fun typedName(name: String): String {
    if (wellFormed(name) != name) throw NameCantBeSaved()
    return checkName(name)
}

/* A new file's record from what the platform handed over: its name and type made well formed first, as the web's uploads are. */
internal fun newFileMetadata(name: String, mime: String?, size: ULong?, modified: String?, attributes: Map<String, String>) =
    NodeMetadata(typedName(wellFormed(name)), mime?.let(::wellFormed), size, modified, attributes)
