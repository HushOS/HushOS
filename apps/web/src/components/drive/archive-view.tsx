import type { DriveNode } from '@hushos/drive/client';
import type { FileReader } from '@hushos/drive/downloads';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from 'cn';
import { ChevronRightIcon, DownloadIcon, FileQuestionIcon, LockIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import { PreviewBody } from '@/components/drive/preview';
import { Notice, Opening, viewerWords } from '@/components/drive/viewer-parts';
import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { openSink } from '@/lib/download-sinks';
import { formatBytes, formatWhen, nodeSize } from '@/lib/drive';
import {
    archiveReader,
    archiveWorker,
    entryLimit,
    entryNode,
    entryWhen,
    preloadArchiveWorker,
} from '@/lib/archives/open';
import {
    openArchive,
    type ArchiveEntry,
    type ArchiveSession,
    type Listing,
} from '@/lib/archives/session';
import { archiveWords } from '@/lib/archives/words';
import { asksFirst } from '@/lib/archives/zip-format';
import { previewKind } from '@/lib/previews';

/*
 * A zip in the viewer (docs/file-tools-design.md, section 1 (a)): the list of what is inside it,
 * a breadcrumb over its folders, and each file with its size and date, opening in the viewer's
 * own renderers or downloading on its own. Only the archive's directory and the entries asked
 * for are read; the archive's worker holds a password while the viewer is open and nothing
 * after. Mac resource entries are left out, and said to be.
 */

/* The archive view and its worker, fetched after unlock with every other viewer. */
export function preloadArchive() {
    preloadArchiveWorker();
}

type Folder = {
    folders: Map<string, number>;
    files: ArchiveEntry[];
};

/* Every folder of the archive by its path ('' is the top), with its folders (and how many items each holds) and files. */
function treeOf(listing: Listing) {
    const folders = new Map<string, Folder>();
    const folder = (key: string) => {
        let found = folders.get(key);
        if (!found) folders.set(key, (found = { folders: new Map(), files: [] }));
        return found;
    };
    folder('');
    for (const entry of listing.entries) {
        if (entry.hidden) continue;
        const depth = entry.directory ? entry.parts.length : entry.parts.length - 1;
        for (let i = 0; i < depth; i++) {
            const parent = folder(entry.parts.slice(0, i).join('/'));
            const name = entry.parts[i]!;
            if (!parent.folders.has(name)) parent.folders.set(name, 0);
            folder(entry.parts.slice(0, i + 1).join('/'));
        }
        if (!entry.directory) folder(entry.parts.slice(0, -1).join('/')).files.push(entry);
    }
    for (const [key, value] of folders)
        for (const name of value.folders.keys()) {
            const child = folders.get(key ? `${key}/${name}` : name)!;
            value.folders.set(name, child.folders.size + child.files.length);
        }
    return folders;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

type Row =
    | { kind: 'folder'; name: string; count: number }
    | { kind: 'file'; name: string; entry: ArchiveEntry };

function rowsOf(folder: Folder | undefined): Row[] {
    if (!folder) return [];
    const folders = [...folder.folders]
        .sort(([a], [b]) => byName.compare(a, b))
        .map(([name, count]): Row => ({ kind: 'folder', name, count }));
    const files = [...folder.files]
        .sort((a, b) => byName.compare(a.parts.at(-1)!, b.parts.at(-1)!))
        .map((entry): Row => ({ kind: 'file', name: entry.parts.at(-1)!, entry }));
    return [...folders, ...files];
}

type Download = { entry: ArchiveEntry; written: number; stop: () => void; error: string | null };

export function ArchiveView({ node, onDownload }: { node: DriveNode; onDownload: () => void }) {
    const [session, setSession] = useState<ArchiveSession | null>(null);
    const [listing, setListing] = useState<Listing | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [path, setPath] = useState<string[]>([]);
    const [opened, setOpened] = useState<ArchiveEntry | null>(null);
    const [unlocked, setUnlocked] = useState(false);
    const [downloads, setDownloads] = useState<Download[]>([]);
    const [asking, setAsking] = useState<ArchiveEntry | null>(null);
    const versionId = node.currentVersion?.id ?? node.id;

    useEffect(() => {
        let active = true;
        let current: ArchiveSession | null = null;
        void (async () => {
            try {
                const reader = await archiveReader(node);
                if (!active) {
                    void reader.close?.();
                    return;
                }
                current = openArchive(reader, archiveWorker);
                setSession(current);
                const read = await current.listing;
                if (active) setListing(read);
            } catch (cause) {
                if (active) setFailure(cause instanceof Error ? cause.message : viewerWords.broken);
            }
        })();
        return () => {
            active = false;
            current?.close();
            setSession(null);
            setListing(null);
            setFailure(null);
            setUnlocked(false);
            setOpened(null);
            setDownloads([]);
        };
        // The archive's version and a retry open it afresh; nothing else does.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [versionId, attempt]);

    const tree = useMemo(() => (listing ? treeOf(listing) : null), [listing]);
    const rows = useMemo(() => rowsOf(tree?.get(path.join('/'))), [tree, path]);

    function startDownload(entry: ArchiveEntry) {
        if (!session) return;
        const name = entry.parts.at(-1)!;
        // The sink first, while the click still counts as one (a save dialog needs it).
        const sink = openSink({ name, size: entry.size });
        let handle: { done: Promise<void>; stop: () => void } | null = null;
        const record: Download = { entry, written: 0, stop: () => handle?.stop(), error: null };
        setDownloads((list) => [...list.filter((item) => item.entry !== entry), record]);
        const update = (patch: Partial<Download>) =>
            setDownloads((list) =>
                list.map((item) => (item.entry === entry ? { ...item, ...patch } : item)),
            );
        void sink
            .then((opened) => {
                handle = session.download(entry, opened, (written) => update({ written }));
                return handle.done;
            })
            .then(
                () => setDownloads((list) => list.filter((item) => item.entry !== entry)),
                (cause: unknown) =>
                    cause instanceof Error && cause.message === 'Stopped.'
                        ? setDownloads((list) => list.filter((item) => item.entry !== entry))
                        : update({
                              error: cause instanceof Error ? cause.message : viewerWords.broken,
                          }),
            );
    }

    function download(entry: ArchiveEntry) {
        if (entry.lock !== 'none' && !unlocked) {
            setOpened(entry);
            return;
        }
        if (asksFirst(entry)) {
            setAsking(entry);
            return;
        }
        startDownload(entry);
    }

    if (failure)
        return (
            <Notice
                icon={
                    <FileQuestionIcon
                        className="size-8 text-muted-foreground"
                        strokeWidth={1.6}
                        aria-hidden="true"
                    />
                }
                title={viewerWords.broken}
                text={failure}
                onDownload={onDownload}
            >
                <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                    Try again
                </Button>
            </Notice>
        );
    if (!listing || !session) return <Opening name={node.name} />;

    const go = (to: string[]) => {
        setOpened(null);
        setPath(to);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-archive>
            <nav
                aria-label={archiveWords.folders}
                className="flex min-h-12 shrink-0 items-center border-b border-rule px-3 sm:px-5"
            >
                <ol className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
                    <Crumb
                        label={node.name}
                        current={path.length === 0 && !opened}
                        onClick={() => go([])}
                    />
                    {path.map((part, i) => (
                        <Crumb
                            key={`${i}:${part}`}
                            label={part}
                            separated
                            current={i === path.length - 1 && !opened}
                            onClick={() => go(path.slice(0, i + 1))}
                        />
                    ))}
                    {opened && <Crumb label={opened.parts.at(-1)!} separated current />}
                </ol>
            </nav>
            {opened ? (
                <EntryPane
                    key={opened.index}
                    archive={node}
                    entry={opened}
                    session={session}
                    unlocked={unlocked}
                    onUnlocked={() => setUnlocked(true)}
                    onDownload={() => download(opened)}
                    onDownloadArchive={onDownload}
                />
            ) : (
                <EntryList
                    rows={rows}
                    unlocked={unlocked}
                    hidden={listing.hidden}
                    onFolder={(name) => go([...path, name])}
                    onOpen={setOpened}
                    onDownload={download}
                />
            )}
            {downloads.length > 0 && (
                <ul className="shrink-0 border-t border-rule bg-card">
                    {downloads.map((item) => (
                        <li
                            key={item.entry.index}
                            className="flex min-h-12 items-center gap-3 px-3 text-[13px] sm:px-5"
                        >
                            <span className="min-w-0 flex-1 truncate">
                                {item.error ?? archiveWords.downloading(item.entry.parts.at(-1)!)}
                            </span>
                            {!item.error && (
                                <span className="shrink-0 text-muted-foreground tabular-nums">
                                    {item.entry.size
                                        ? `${Math.floor((item.written / item.entry.size) * 100)}%`
                                        : ''}
                                </span>
                            )}
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={item.error ? 'Dismiss' : archiveWords.stop}
                                title={item.error ? 'Dismiss' : archiveWords.stop}
                                onClick={() => {
                                    item.stop();
                                    setDownloads((list) => list.filter((other) => other !== item));
                                }}
                            >
                                <XIcon />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {asking ? archiveWords.asksFirst(asking.size, asking.packed) : ''}
                        </AlertDialogTitle>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{archiveWords.cancel}</AlertDialogCancel>
                        <Button
                            onClick={() => {
                                const entry = asking;
                                setAsking(null);
                                if (entry) startDownload(entry);
                            }}
                        >
                            {archiveWords.download}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function Crumb({
    label,
    current,
    separated = false,
    onClick,
}: {
    label: string;
    current: boolean;
    separated?: boolean;
    onClick?: () => void;
}) {
    return (
        <li className="flex min-w-0 items-center gap-0.5">
            {separated && (
                <ChevronRightIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
            )}
            {current ? (
                <span aria-current="page" className="truncate px-2 py-1.5 font-semibold">
                    {label}
                </span>
            ) : (
                <button
                    type="button"
                    onClick={onClick}
                    className="truncate rounded-sm px-2 py-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                >
                    {label}
                </button>
            )}
        </li>
    );
}

/* What a row says under its name: its size and date, or why it doesn't open. */
function rowMeta(entry: ArchiveEntry, unlocked: boolean) {
    if (entry.link) return archiveWords.link;
    if (entry.lock !== 'none' && !unlocked) return archiveWords.needsPassword;
    return [formatBytes(entry.size), formatWhen(entryWhen(entry))].filter(Boolean).join(' · ');
}

function EntryList({
    rows,
    unlocked,
    hidden,
    onFolder,
    onOpen,
    onDownload,
}: {
    rows: Row[];
    unlocked: boolean;
    hidden: number;
    onFolder: (name: string) => void;
    onOpen: (entry: ArchiveEntry) => void;
    onDownload: (entry: ArchiveEntry) => void;
}) {
    const scroller = useRef<HTMLDivElement>(null);
    // oxlint-disable-next-line react/incompatible-library -- the list re-renders from its rows, never from memoized pieces of the virtualizer
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scroller.current,
        estimateSize: () => 56,
        overscan: 12,
    });
    return (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto" data-viewer-body tabIndex={-1}>
            {rows.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                    {archiveWords.empty}
                </p>
            ) : (
                <ul
                    aria-label="Items"
                    className="relative"
                    style={{ height: virtualizer.getTotalSize() }}
                >
                    {virtualizer.getVirtualItems().map((item) => {
                        const row = rows[item.index]!;
                        return (
                            <li
                                key={
                                    row.kind === 'folder' ? `d:${row.name}` : `f:${row.entry.index}`
                                }
                                className="absolute inset-x-0 flex h-14 items-center border-b border-rule"
                                style={{ transform: `translateY(${item.start}px)` }}
                            >
                                {row.kind === 'folder' ? (
                                    <RowButton
                                        mark={
                                            <FileMark kind="folder" name={row.name} size="list" />
                                        }
                                        name={row.name}
                                        meta={archiveWords.items(row.count)}
                                        onClick={() => onFolder(row.name)}
                                    />
                                ) : (
                                    <>
                                        <RowButton
                                            mark={
                                                <FileMark kind="file" name={row.name} size="list" />
                                            }
                                            name={row.name}
                                            meta={rowMeta(row.entry, unlocked)}
                                            locked={row.entry.lock !== 'none' && !unlocked}
                                            onClick={
                                                row.entry.link ? undefined : () => onOpen(row.entry)
                                            }
                                        />
                                        {!row.entry.link && row.entry.support === 'ok' && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="mr-2 sm:mr-5"
                                                aria-label={`Download ${row.name}`}
                                                title={archiveWords.download}
                                                onClick={() => onDownload(row.entry)}
                                            >
                                                <DownloadIcon />
                                            </Button>
                                        )}
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {hidden > 0 && (
                <p className="px-5 py-4 text-center text-[13px] text-muted-foreground sm:px-8">
                    {archiveWords.hidden(hidden)}
                </p>
            )}
        </div>
    );
}

function RowButton({
    mark,
    name,
    meta,
    locked = false,
    onClick,
}: {
    mark: React.ReactNode;
    name: string;
    meta: string;
    locked?: boolean;
    onClick?: () => void;
}) {
    const body = (
        <>
            {mark}
            <span className="flex min-w-0 flex-col">
                <span className="truncate text-[14px] font-medium md:text-[15px]">{name}</span>
                <span className="flex items-center gap-1 truncate text-[13px] text-muted-foreground tabular-nums">
                    {locked && <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />}
                    {meta}
                </span>
            </span>
        </>
    );
    const shape =
        'flex h-full min-w-0 flex-1 items-center gap-3 pr-3 pl-5 text-left sm:pl-8 md:gap-4';
    if (!onClick) return <div className={shape}>{body}</div>;
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                shape,
                'cursor-pointer outline-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
            )}
        >
            {body}
        </button>
    );
}

function EntryPane({
    archive,
    entry,
    session,
    unlocked,
    onUnlocked,
    onDownload,
    onDownloadArchive,
}: {
    archive: DriveNode;
    entry: ArchiveEntry;
    session: ArchiveSession;
    unlocked: boolean;
    onUnlocked: () => void;
    onDownload: () => void;
    onDownloadArchive: () => void;
}) {
    const name = entry.parts.at(-1)!;
    const node = useMemo(() => entryNode(archive, entry), [archive, entry]);
    const kind = previewKind(node);
    const icon = <FileMark kind="file" name={name} size="large" />;
    const opener = useMemo(
        () => (): Promise<FileReader> => session.preview(entry, entryLimit(kind)),
        [session, entry, kind],
    );
    let body: React.ReactNode;
    if (entry.lock !== 'none' && !unlocked)
        body = <PasswordCard name={name} session={session} onUnlocked={onUnlocked} />;
    else if (entry.support !== 'ok')
        body = (
            <Notice
                icon={icon}
                title={name}
                text={entry.support === 'method' ? archiveWords.method : archiveWords.encryption}
                onDownload={onDownloadArchive}
            />
        );
    else if (entry.nested)
        body = (
            <Notice icon={icon} title={name} text={archiveWords.nested} onDownload={onDownload} />
        );
    else if (!entry.stored && entry.size > entryLimit(kind))
        body = (
            <Notice
                icon={icon}
                title={viewerWords.tooLarge(entry.size)}
                text={viewerWords.elsewhere}
                onDownload={onDownload}
            />
        );
    else body = <PreviewBody key={node.id} node={node} onDownload={onDownload} open={opener} />;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-rule pr-3 pl-5 sm:pr-5 sm:pl-7">
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground tabular-nums">
                    {[
                        nodeSize(node) === null ? null : formatBytes(entry.size),
                        formatWhen(entryWhen(entry)),
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                </span>
                {entry.support === 'ok' && (entry.lock === 'none' || unlocked) && (
                    <Button variant="outline" onClick={onDownload}>
                        <DownloadIcon />
                        {archiveWords.download}
                    </Button>
                )}
            </div>
            {body}
        </div>
    );
}

function PasswordCard({
    name,
    session,
    onUnlocked,
}: {
    name: string;
    session: ArchiveSession;
    onUnlocked: () => void;
}) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [wrong, setWrong] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The field takes focus when the card shows: opening a locked item is asking to type its password.
    const field = useRef<HTMLInputElement>(null);
    useEffect(() => field.current?.focus({ preventScroll: true }), []);
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        setWrong(false);
        setError(null);
        try {
            if (await session.unlock(password)) onUnlocked();
            else setWrong(true);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : viewerWords.broken);
        } finally {
            setBusy(false);
        }
    }
    return (
        <Notice
            icon={
                <LockIcon
                    className="size-8 text-muted-foreground"
                    strokeWidth={1.6}
                    aria-hidden="true"
                />
            }
            title={archiveWords.passwordTitle(name)}
        >
            <form
                onSubmit={(event) => void submit(event)}
                className="mt-1 flex w-full flex-col gap-2 text-left"
            >
                <label htmlFor="archive-password" className="text-sm font-medium">
                    {archiveWords.passwordLabel}
                </label>
                <div className="flex gap-2">
                    <PasswordInput
                        id="archive-password"
                        ref={field}
                        autoComplete="off"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        aria-invalid={wrong || undefined}
                        aria-describedby={wrong || error ? 'archive-password-error' : undefined}
                        wrapperClassName="min-w-0 flex-1"
                    />
                    <Button type="submit" className="h-11" disabled={!password || busy}>
                        {archiveWords.open}
                    </Button>
                </div>
                {(wrong || error) && (
                    <p
                        id="archive-password-error"
                        role="alert"
                        className="text-sm text-destructive"
                    >
                        {wrong ? archiveWords.wrongPassword : error}
                    </p>
                )}
            </form>
        </Notice>
    );
}
