import { folderName, type ArchiveEntry, type Listing } from '@/lib/archives/session';

export type Row =
    | { kind: 'folder'; id: number; name: string; count: number }
    | { kind: 'file'; name: string; entry: ArchiveEntry };

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/* How much work goes between pauses: a slice is a few milliseconds, so the page answers meanwhile. */
const SLICE = 20_000;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/* Each listing's folders' rows, made once each, for as long as the listing is held. */
const made = new WeakMap<Listing, Map<number, Row[]>>();

/* Folder `id`'s rows when they are made already; undefined when they are still to make. */
export function madeRows(listing: Listing, id: number): Row[] | undefined {
    return made.get(listing)?.get(id);
}

/*
 * Folder `id`'s rows: its folders, then its files, each by name, numbers in order. Read from the
 * listing's folder array as they are asked for, so nothing the size of every path is ever built:
 * one pass over the folders finds the children, a second counts what each holds. Made off the
 * render path, a slice at a time with a pause between, sort included (a folder of 100,000 files
 * took over a second in one go), and kept per folder, so going back to one is instant.
 */
export async function rowsOf(listing: Listing, id: number): Promise<Row[]> {
    const known = madeRows(listing, id);
    if (known) return known;
    const { parents } = listing.folders;
    let work = 0;
    // Counted synchronously; a pause only at a slice's end (an await per item was millions of microtasks).
    const due = () => ++work % SLICE === 0;
    const counts = new Map<number, number>();
    for (let k = 1; k < parents.length; k++) {
        if (parents[k] === id) counts.set(k, 0);
        if (due()) await pause();
    }
    for (let k = 1; k < parents.length; k++) {
        const count = counts.get(parents[k]!);
        if (count !== undefined) counts.set(parents[k]!, count + 1);
        if (due()) await pause();
    }
    const files: Row[] = [];
    for (const entry of listing.entries) {
        if (due()) await pause();
        if (entry.hidden || entry.directory) continue;
        if (entry.folder === id) files.push({ kind: 'file', name: entry.name, entry });
        const count = counts.get(entry.folder);
        if (count !== undefined) counts.set(entry.folder, count + 1);
    }
    const folders = [...counts].map(([k, count]): Row => ({
        kind: 'folder',
        id: k,
        name: folderName(listing.folders, k),
        count,
    }));
    const compare = (a: Row, b: Row) => byName.compare(a.name, b.name);
    const rows = [
        ...(await sortInSlices(folders, compare)),
        ...(await sortInSlices(files, compare)),
    ];
    let byFolder = made.get(listing);
    if (!byFolder) made.set(listing, (byFolder = new Map()));
    // Two makings of one folder (back and forth while the first ran) keep the first.
    const first = byFolder.get(id);
    if (first) return first;
    byFolder.set(id, rows);
    return rows;
}

/*
 * A stable merge sort with a pause every SLICE comparisons: short runs sorted by the engine, then
 * merged pairwise. The same order Array.prototype.sort gives (both stable), never one long task.
 */
async function sortInSlices<T>(items: T[], compare: (a: T, b: T) => number): Promise<T[]> {
    const run = 2048;
    const n = items.length;
    let from = items.slice();
    for (let start = 0; start < n; start += run) {
        const part = from.slice(start, start + run).sort(compare);
        for (let i = 0; i < part.length; i++) from[start + i] = part[i]!;
        if (n > run) await pause();
    }
    let to = Array.from({ length: n }) as T[];
    let work = 0;
    for (let width = run; width < n; width *= 2) {
        for (let lo = 0; lo < n; lo += 2 * width) {
            const mid = Math.min(lo + width, n);
            const hi = Math.min(lo + 2 * width, n);
            let i = lo;
            let j = mid;
            let k = lo;
            while (i < mid && j < hi) {
                // The left one on a tie: stable.
                to[k++] = compare(from[j]!, from[i]!) < 0 ? from[j++]! : from[i++]!;
                if (++work % SLICE === 0) await pause();
            }
            while (i < mid) to[k++] = from[i++]!;
            while (j < hi) to[k++] = from[j++]!;
        }
        [from, to] = [to, from];
    }
    return from;
}
