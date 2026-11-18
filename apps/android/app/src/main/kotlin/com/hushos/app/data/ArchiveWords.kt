package com.hushos.app.data

import com.hushos.app.ui.formatBytes
import com.hushos.core.toolFailedMessage

/*
 * What the archive screen says: the web's words (apps/web/src/lib/archives/words.ts, from
 * docs/file-tools-design.md section 1 (a), used as written) and iOS's (ArchiveWords.swift).
 * Change them together.
 */
object ArchiveWords {
    const val NEEDS_PASSWORD = "Needs a password"
    const val LINK = "Link, not opened"
    const val NESTED = "Extract it first, or download it."
    const val METHOD = "This item uses a kind of compression HushOS can’t open. Download the archive to open it on your computer."
    const val ENCRYPTION = "This item uses a kind of encryption HushOS can’t open. Download the archive to open it on your computer."
    const val ENCRYPTED_DIRECTORY = "This archive’s list of contents is encrypted. HushOS can’t open it."
    const val EMPTY = "This folder in the archive is empty."
    const val PASSWORD_LABEL = "Password"
    const val OPEN = "Open"
    const val WRONG_PASSWORD = "That password isn’t right."
    /* A password only its quick check passed, and an item then read as damaged: let go of, asked for again. */
    const val PASSWORD_UNPROVEN = "This item didn’t open with that password. It may be wrong: enter it again."
    const val DOWNLOAD = "Download"
    const val DOWNLOAD_ARCHIVE = "Download the archive"
    const val CANCEL = "Cancel"
    const val STOP = "Stop"
    const val CONTINUE = "Continue"
    const val TRY_AGAIN = "Try again"
    const val CANT_SHOW = "This file can’t be shown"
    const val NO_PREVIEW = "This kind of file has no preview yet."
    const val ELSEWHERE = "Download it to open it in another app."
    const val COSTLY = "Opening it uses a lot of memory and may be slow on this device."
    /* A PDF before Android 11: PdfRenderer needs a file, and an entry is never written to one. */
    const val PDF_NEEDS_ANDROID_11 = "PDFs inside an archive preview on Android 11 and later. Download it to open it in another app."
    const val DOWNLOADED = "Downloaded."
    /* A read underneath that failed (the store, the network), the kept copy, and a destination that refused a piece. */
    const val UNREADABLE = "Couldn’t read this archive. Check your connection, then try again."
    const val KEPT_UNREADABLE = "Couldn’t read the copy kept on this phone."
    const val NOT_SAVED = "Couldn’t save it there. Check the folder has room, then try again."

    fun hidden(count: Int) = if (count == 1) "1 Mac resource file isn’t shown." else "$count Mac resource files aren’t shown."
    fun items(count: Int) = if (count == 1) "1 item" else "${String.format(java.util.Locale.US, "%,d", count)} items"
    fun passwordTitle(name: String) = "“$name” needs a password"
    fun asksFirst(size: Long, packed: Long) = "This item expands to ${formatBytes(size)} from ${formatBytes(packed)}."
    fun downloading(name: String) = "Downloading “$name”"
    fun tooLarge(size: Long) = "This file is ${formatBytes(size)}, too large to preview here."
    fun large(size: Long) = "This file is ${formatBytes(size)}."

    /* An item whose bytes are damaged: one sentence, whichever check noticed first (the web's ITEM_DAMAGED). */
    private const val ITEM_DAMAGED = "This item is damaged, or isn’t something HushOS can read."

    /*
     * Why an archive or one of its items was refused, by the core's code; anything else is the tools'
     * failure. `entry`: an item's own refusal, where "damaged" says the item is, not the archive,
     * which still lists (the web's entryRefusalWords).
     */
    fun refusal(code: String, entry: Boolean = false): String = when (code) {
        "damaged" -> if (entry) ITEM_DAMAGED else "This archive is damaged, or isn’t a zip archive HushOS can read."
        "directory-too-large" -> "This archive’s list of contents is too large to open here. Download it to open it on your computer."
        "too-many-entries" -> "This archive has more than ${String.format(java.util.Locale.US, "%,d", com.hushos.core.zipEntriesMax().toLong())} items, too many to list here. Download it to open it on your computer."
        "encrypted-directory" -> ENCRYPTED_DIRECTORY
        "split" -> "This is one part of an archive split into several. HushOS can’t open it."
        "overlap" -> "This archive’s items overlap each other, which is how some zip bombs work. HushOS won’t open it."
        "local" -> "This item doesn’t match the archive’s list of contents. HushOS won’t open it."
        "method" -> METHOD
        "encryption" -> ENCRYPTION
        "password" -> NEEDS_PASSWORD
        "wrong-password" -> WRONG_PASSWORD
        "password-unproven" -> PASSWORD_UNPROVEN
        // One sentence whichever check noticed the damage first: the web's decoders notice it at
        // their own point (words.ts, ITEM_DAMAGED).
        "crc", "auth", "size", "short" -> ITEM_DAMAGED
        "ratio" -> "This item expands far more than ordinary files do, which is how some zip bombs work. HushOS stopped reading it."
        "link" -> "This item is a link, which HushOS doesn’t open."
        "directory" -> "This is a folder in the archive, not a file."
        "too-large" -> "This item is too large to preview here. Download it to open it in another app."
        "nested" -> NESTED
        else -> toolFailedMessage()
    }
}
