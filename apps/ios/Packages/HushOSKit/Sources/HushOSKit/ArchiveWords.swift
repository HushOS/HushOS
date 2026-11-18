import Foundation
import HushOSCore

/*
 * What the archive viewer says (docs/file-tools-design.md, section 1 (a)), word for word the web's
 * (apps/web/src/lib/archives/words.ts) and Android's (data/ArchiveWords.kt): change them together.
 */
public enum ArchiveWords {
    public static let needsPassword = "Needs a password"
    public static let link = "Link, not opened"
    public static let nested = "Extract it first, or download it."
    public static let method = "This item uses a kind of compression HushOS can’t open. Download the archive to open it on your computer."
    public static let encryption = "This item uses a kind of encryption HushOS can’t open. Download the archive to open it on your computer."
    public static let encryptedDirectory = "This archive’s list of contents is encrypted. HushOS can’t open it."
    public static func hidden(_ count: Int) -> String {
        count == 1 ? "1 Mac resource file isn’t shown." : "\(count) Mac resource files aren’t shown."
    }
    public static func items(_ count: Int) -> String {
        count == 1 ? "1 item" : "\(count.formatted()) items"
    }
    public static let empty = "This folder in the archive is empty."
    public static func passwordTitle(_ name: String) -> String { "“\(name)” needs a password" }
    public static let passwordLabel = "Password"
    public static let open = "Open"
    public static let wrongPassword = "That password isn’t right."
    /* A password only its quick check passed, and an item then read as damaged: let go of, asked for again. */
    public static let passwordUnproven = "This item didn’t open with that password. It may be wrong: enter it again."
    public static func asksFirst(size: String, packed: String) -> String { "This item expands to \(size) from \(packed)." }
    public static func downloading(_ name: String) -> String { "Downloading “\(name)”" }
    public static let stop = "Stop"
    public static let download = "Download"
    public static let cancel = "Cancel"
    public static let folders = "Folders in the archive"
    /* A read underneath that failed (the store, the network), and a download's destination that refused a piece. */
    public static let unreadable = "Couldn’t read this archive. Check your connection, then try again."
    public static let keptUnreadable = "Couldn’t read the copy kept on this phone."
    public static let notSaved = "Couldn’t save it there. Check the folder has room, then try again."
    /* The viewer's own words, as the web's viewerWords say them. */
    public static let noPreview = "This kind of file has no preview yet."
    public static let broken = "This file can’t be shown"
    public static func tooLarge(_ size: String) -> String { "This file is \(size), too large to preview here." }
    public static let elsewhere = "Download it to open it in another app."
    public static func large(_ size: String) -> String { "This file is \(size)." }
    public static let largeRisk = "Opening it uses a lot of memory and may be slow on this device."
    public static let openAnyway = "Open anyway"

    static let itemDamaged = "This item is damaged, or isn’t something HushOS can read."

    /* Why an archive or an entry was refused, by the core's code (archive.rs, `Refusal::code`). */
    public static let refusals: [String: String] = [
        "damaged": "This archive is damaged, or isn’t a zip archive HushOS can read.",
        "directory-too-large": "This archive’s list of contents is too large to open here. Download it to open it on your computer.",
        "too-many-entries": "This archive has more than \(Int(zipEntriesMax()).formatted()) items, too many to list here. Download it to open it on your computer.",
        "encrypted-directory": encryptedDirectory,
        "split": "This is one part of an archive split into several. HushOS can’t open it.",
        "overlap": "This archive’s items overlap each other, which is how some zip bombs work. HushOS won’t open it.",
        "local": "This item doesn’t match the archive’s list of contents. HushOS won’t open it.",
        "method": method,
        "encryption": encryption,
        "password": needsPassword,
        "wrong-password": wrongPassword,
        "password-unproven": passwordUnproven,
        // One sentence whichever check noticed the damage first: the web's decoders notice it at
        // their own point (words.ts, ITEM_DAMAGED).
        "crc": itemDamaged,
        "auth": itemDamaged,
        "size": itemDamaged,
        "short": itemDamaged,
        "link": "This item is a link, which HushOS doesn’t open.",
        "directory": "This is a folder in the archive, not a file.",
        "too-large": "This item is too large to preview here. Download it to open it in another app.",
        "ratio": "This item expands far more than ordinary files do, which is how some zip bombs work. HushOS stopped reading it.",
        "nested": nested,
    ]

    /* An item's own refusal: "damaged" says the item is, not the archive, which still lists. */
    public static let entryRefusals: [String: String] = refusals.merging(
        ["damaged": itemDamaged]
    ) { _, entry in entry }

    /* Which refusal words: the archive's (opening it) or an item's (reading one entry). */
    public enum Scope: Sendable { case archive, entry }

    /* A refusal's words, or the tools' own failure for any code without words. */
    public static func refusal(_ code: String, scope: Scope = .archive) -> String {
        (scope == .entry ? entryRefusals : refusals)[code] ?? toolFailedMessage()
    }
}
