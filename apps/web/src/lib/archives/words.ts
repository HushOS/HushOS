import { formatBytes } from '@/lib/format';

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
    asksFirst: (size: number, packed: number) =>
        `This item expands to ${formatBytes(size)} from ${formatBytes(packed)}.`,
    downloading: (name: string) => `Downloading “${name}”`,
    stop: 'Stop',
    download: 'Download',
    cancel: 'Cancel',
    folders: 'Folders in the archive',
};

/* Why an archive or an entry was refused, in the person's words. Anything else is the tools' TOOL_FAILED. */
export const refusalWords: Record<string, string> = {
    damaged: 'This archive is damaged, or isn’t a zip archive HushOS can read.',
    'directory-too-large':
        'This archive’s list of contents is too large to open here. Download it to open it on your computer.',
    'too-many-entries':
        'This archive has more than 100,000 items, too many to list here. Download it to open it on your computer.',
    'encrypted-directory': archiveWords.encryptedDirectory,
    split: 'This is one part of an archive split into several. HushOS can’t open it.',
    overlap:
        'This archive’s items overlap each other, which is how some zip bombs work. HushOS won’t open it.',
    local: 'This item doesn’t match the archive’s list of contents. HushOS won’t open it.',
    method: archiveWords.method,
    encryption: archiveWords.encryption,
    password: archiveWords.needsPassword,
    'wrong-password': archiveWords.wrongPassword,
    crc: 'This item is damaged: its contents don’t match its checksum.',
    auth: 'This item is damaged: it doesn’t pass the archive’s check, so nothing of it is shown.',
    size: 'This item holds more than it says, which is how some zip bombs work. HushOS stopped reading it.',
    ratio: 'This item expands far more than ordinary files do, which is how some zip bombs work. HushOS stopped reading it.',
    nested: archiveWords.nested,
};
