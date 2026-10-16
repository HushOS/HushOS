/*
 * Where each file of a reported tree goes in the evidence packet's zip. Names
 * are encrypted on the uploader's device, so the server cannot refuse any of
 * them: whatever a reported person typed must still make a path that stays
 * inside the zip, extracts on Windows, macOS and Linux, and never lands on
 * another file. Pure, so it is tested without a drive.
 */

export type PacketTree = {
    id: string;
    name: string;
    kind: 'file' | 'folder';
    children?: PacketTree[];
};

export type PacketPath = {
    nodeId: string;
    /* The path in the zip, every segment made safe and unique in its folder. */
    path: string;
    /* The names as the uploader wrote them, root first, for the operator to match up. */
    names: string[];
};

/* Characters no file system takes, controls (C0, DEL, C1) and bidi marks. */
const FORBIDDEN = new Set('\\/:*?"<>|');
function unsafe(char: string) {
    const code = char.codePointAt(0)!;
    return (
        FORBIDDEN.has(char) ||
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        code === 0x2028 ||
        code === 0x2029 ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
    );
}

/* Names Windows keeps for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
/* Leaves room under the 255-byte name limit for a " (12)" made unique below. */
const MAX_BYTES = 240;
const encoder = new TextEncoder();

/*
 * One name as one path segment: unsafe characters become "_", trailing dots and
 * spaces go (Windows drops them, so ".. " would act as ".."), an empty, "." or
 * ".." name is "_", a device name gets a leading "_", and the result is cut on
 * whole code points to MAX_BYTES of UTF-8.
 */
export function packetSegment(name: string) {
    let segment = Array.from(name, (char) => (unsafe(char) ? '_' : char))
        .join('')
        .replace(/[.\s]+$/, '');
    if (segment === '' || segment === '.' || segment === '..') segment = '_';
    if (RESERVED.test(segment)) segment = `_${segment}`;
    let out = '';
    let bytes = 0;
    for (const char of segment) {
        bytes += encoder.encode(char).length;
        if (bytes > MAX_BYTES) break;
        out += char;
    }
    return out.replace(/[.\s]+$/, '') || '_';
}

/* "photo.jpg" taken: "photo (2).jpg"; a folder or a name without an extension: "notes (2)". */
function numbered(segment: string, n: number, file: boolean) {
    const dot = file ? segment.lastIndexOf('.') : -1;
    return dot > 0 ? `${segment.slice(0, dot)} (${n})${segment.slice(dot)}` : `${segment} (${n})`;
}

/*
 * Every file's path, folders first-come first-named: within a folder, names that
 * come out the same (case aside, as macOS and Windows compare them) get " (2)",
 * " (3)" in the order they are listed, so no entry overwrites another and
 * hashes.txt never lists two hashes under one path.
 */
export function packetPaths(root: PacketTree): PacketPath[] {
    const out: PacketPath[] = [];
    function visit(node: PacketTree, segment: string, prefix: string, names: string[]) {
        const path = `${prefix}${segment}`;
        const here = [...names, node.name];
        if (node.kind === 'file') {
            out.push({ nodeId: node.id, path, names: here });
            return;
        }
        const taken = new Set<string>();
        for (const child of node.children ?? []) {
            const base = packetSegment(child.name);
            let unique = base;
            for (let n = 2; taken.has(unique.toLowerCase()); n++)
                unique = numbered(base, n, child.kind === 'file');
            taken.add(unique.toLowerCase());
            visit(child, unique, `${path}/`, here);
        }
    }
    visit(root, packetSegment(root.name), '', []);
    return out;
}

/*
 * A name as one line of the packet's text files: control characters, line and
 * paragraph separators and bidi marks written as \u{…}, so a name cannot start
 * a forged line in report.txt or hashes.txt, or reorder what is around it.
 */
export function printable(text: string) {
    return Array.from(text, (char) =>
        char !== ' ' && unsafe(char) && !FORBIDDEN.has(char)
            ? `\\u{${char.codePointAt(0)!.toString(16)}}`
            : char,
    ).join('');
}
