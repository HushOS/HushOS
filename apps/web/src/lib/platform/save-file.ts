/*
 * Saving something the page made itself (a QR code, a recovery kit) as a file.
 * One way, so every such file is named alike and its address lives long enough:
 * Safari, iOS above all, reads the blob only once the person confirms the
 * download, which can be well after the click.
 */

/* Characters no file system takes, or that change how a name reads (controls, bidi marks). */
const FORBIDDEN = new Set('\\/:*?"<>|');
const unsafe = (char: string) => {
    const code = char.codePointAt(0)!;
    return (
        FORBIDDEN.has(char) ||
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
    );
};

/* Names Windows keeps for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const encoder = new TextEncoder();
const EDGES = /^[.\s]+|[.\s]+$/g;

/* Whole characters where the browser can tell them (Firefox from 125), code points elsewhere. */
function characters(text: string) {
    return typeof Intl.Segmenter === 'function'
        ? Array.from(
              new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
              (part) => part.segment,
          )
        : Array.from(text);
}

/*
 * A name every system accepts, as the start of a file name: forbidden and
 * invisible characters replaced, no leading or trailing dots or spaces (a hidden
 * file, or one Windows renames), no device name, and at most `maxBytes` of UTF-8
 * cut between whole characters, so a suffix the caller adds (" QR code.png")
 * still fits the 255-byte limit of APFS and ext4.
 */
export function safeFileName(name: string, maxBytes = 200) {
    let cleaned = Array.from(name, (char) => (unsafe(char) ? '_' : char))
        .join('')
        .replace(EDGES, '');
    if (!cleaned) cleaned = 'Untitled';
    if (RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
    let out = '';
    let bytes = 0;
    for (const character of characters(cleaned)) {
        bytes += encoder.encode(character).length;
        if (bytes > maxBytes) break;
        out += character;
    }
    // The cut can land just after a space or a dot.
    return out.replace(EDGES, '') || 'Untitled';
}

export function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
