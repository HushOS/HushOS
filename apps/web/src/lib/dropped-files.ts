/*
 * Turns what a person dropped into a flat list of files with the folder path each
 * came from, walking dropped directories through the entries API. Browsers only
 * expose entries during the drop event, so the items are read synchronously
 * first and the tree is walked afterwards.
 */

export type DroppedFile = { file: File; path: string[]; handle?: FileSystemFileHandle };

type FileSystemEntryLike = {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
    createReader?: () => {
        readEntries: (
            success: (entries: FileSystemEntryLike[]) => void,
            failure: (error: unknown) => void,
        ) => void;
    };
};

function readAll(entry: FileSystemEntryLike) {
    const reader = entry.createReader!();
    const all: FileSystemEntryLike[] = [];
    return new Promise<FileSystemEntryLike[]>((resolve, reject) => {
        const step = () =>
            reader.readEntries((batch) => {
                if (!batch.length) resolve(all);
                else {
                    all.push(...batch);
                    step();
                }
            }, reject);
        step();
    });
}

async function walk(entry: FileSystemEntryLike, path: string[], out: DroppedFile[]) {
    if (entry.isFile && entry.file) {
        const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
        // Finder drops .DS_Store and friends; nobody wants those in their Drive.
        if (!file.name.startsWith('.')) out.push({ file, path });
        return;
    }
    if (entry.isDirectory && entry.createReader)
        for (const child of await readAll(entry)) await walk(child, [...path, entry.name], out);
}

export async function collectDroppedFiles(items: DataTransferItem[]): Promise<DroppedFile[]> {
    const entries: (FileSystemEntryLike | null)[] = [];
    const plain: File[] = [];
    // Handles let Chromium reopen the file after a reload; they must be requested
    // synchronously during the drop, before anything awaits.
    const handles: Promise<FileSystemHandle | null>[] = [];
    for (const item of items) {
        if (item.kind !== 'file') continue;
        const withHandle = item as DataTransferItem & {
            getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
        };
        handles.push(
            withHandle.getAsFileSystemHandle
                ? withHandle.getAsFileSystemHandle().catch(() => null)
                : Promise.resolve(null),
        );
        const entry = (
            item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
        ).webkitGetAsEntry?.();
        if (entry) entries.push(entry);
        else {
            const file = item.getAsFile();
            if (file) plain.push(file);
        }
    }
    const out: DroppedFile[] = plain.map((file) => ({ file, path: [] }));
    for (const entry of entries) if (entry) await walk(entry, [], out);
    const resolved = await Promise.all(handles);
    for (const handle of resolved) {
        if (!handle || handle.kind !== 'file') continue;
        const match = out.find(
            (entry) => entry.path.length === 0 && entry.file.name === handle.name && !entry.handle,
        );
        if (match) match.handle = handle as FileSystemFileHandle;
    }
    return out;
}

/* From an <input type=file webkitdirectory>: the relative path carries the folders. */
export function filesFromInput(list: FileList | File[]): DroppedFile[] {
    return Array.from(list)
        .filter((file) => !file.name.startsWith('.'))
        .map((file) => {
            const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
            const parts = relative ? relative.split('/').slice(0, -1) : [];
            return { file, path: parts };
        });
}
