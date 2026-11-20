import { formatBytes } from '@/lib/platform/format';
import { ZIP_LIMITS } from './zip-format';

/*
 * What the archive viewer says (docs/file-tools-design.md, section 1 (a), whose strings are used
 * as written). The phones say the same (HushOSKit/ArchiveWords.swift, data/ArchiveWords.kt):
 * change them together.
 */
export const archiveWords = {
    needsPassword: 'Needs a password',
    link: 'Link, not opened',
    nested: 'Extract it first, or download it.',
    method: 'This item uses a kind of compression HushOS can’t open. Download the archive to open it on your computer.',
    encryption:
        'This item uses a kind of encryption HushOS can’t open. Download the archive to open it on your computer.',
    encryptedDirectory: 'This archive’s list of contents is encrypted. HushOS can’t open it.',
    hidden: (count: number) =>
        count === 1
            ? '1 Mac resource file isn’t shown.'
            : `${count} Mac resource files aren’t shown.`,
    items: (count: number) => (count === 1 ? '1 item' : `${count.toLocaleString()} items`),
    empty: 'This folder in the archive is empty.',
    passwordTitle: (name: string) => `“${name}” needs a password`,
    passwordLabel: 'Password',
    open: 'Open',
    wrongPassword: 'That password isn’t right.',
    /* A password only its quick check passed, and an item then read as damaged: let go of, asked for again. */
    passwordUnproven: 'This item didn’t open with that password. It may be wrong: enter it again.',
    asksFirst: (size: number, packed: number) =>
        `This item expands to ${formatBytes(size)} from ${formatBytes(packed)}.`,
    downloading: (name: string) => `Downloading “${name}”`,
    stop: 'Stop',
    download: 'Download',
    cancel: 'Cancel',
    folders: 'Folders in the archive',
    /* A stored entry larger than the viewer checks before showing: read by range, its checksum unchecked. */
    unverified: 'This item is too large to check before it’s shown, so it may be damaged.',
};

/*
 * An item whose bytes are damaged: one sentence, whichever check noticed first (its stream, its
 * size, its CRC, its AES code). The decoders behind each client notice damage at their own
 * point (zlib-rs and the deflate64 crate in the core, zip.js's inflaters on the web), so the same
 * bytes can meet different checks; a person sees the same words on every client all the same.
 */
const ITEM_DAMAGED = 'This item is damaged, or isn’t something HushOS can read.';

/* Why an archive or an entry was refused, in the person's words. Anything else is the tools' TOOL_FAILED. */
export const refusalWords: Record<string, string> = {
    damaged: 'This archive is damaged, or isn’t a zip archive HushOS can read.',
    'directory-too-large':
        'This archive’s list of contents is too large to open here. Download it to open it on your computer.',
    'too-many-entries': `This archive has more than ${ZIP_LIMITS.entries.toLocaleString('en-US')} items, too many to list here. Download it to open it on your computer.`,
    'encrypted-directory': archiveWords.encryptedDirectory,
    split: 'This is one part of an archive split into several. HushOS can’t open it.',
    overlap:
        'This archive’s items overlap each other, which is how some zip bombs work. HushOS won’t open it.',
    local: 'This item doesn’t match the archive’s list of contents. HushOS won’t open it.',
    method: archiveWords.method,
    encryption: archiveWords.encryption,
    password: archiveWords.needsPassword,
    'wrong-password': archiveWords.wrongPassword,
    'password-unproven': archiveWords.passwordUnproven,
    crc: ITEM_DAMAGED,
    auth: ITEM_DAMAGED,
    size: ITEM_DAMAGED,
    short: ITEM_DAMAGED,
    link: 'This item is a link, which HushOS doesn’t open.',
    directory: 'This is a folder in the archive, not a file.',
    'too-large': 'This item is too large to preview here. Download it to open it in another app.',
    ratio: 'This item expands far more than ordinary files do, which is how some zip bombs work. HushOS stopped reading it.',
    nested: archiveWords.nested,
    unreadable: 'Couldn’t read this archive. Check your connection, then try again.',
};

/* An item's own refusal: "damaged" says the item is, not the archive, which still lists. */
export const entryRefusalWords: Record<string, string> = {
    ...refusalWords,
    damaged: ITEM_DAMAGED,
};
