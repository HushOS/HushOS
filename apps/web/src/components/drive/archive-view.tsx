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
    ArchiveRefusal,
    folderName,
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

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

type Row =
    | { kind: 'folder'; id: number; name: string; count: number }
    | { kind: 'file'; name: string; entry: ArchiveEntry };

/*
 * Folder `id`'s rows: its folders, then its files, each by name, numbers in order. Read from the
 * listing's folder array as they are asked for, so nothing the size of every path is ever built:
 * one pass over the folders finds the children, a second counts what each holds.
 */
function rowsOf(listing: Listing, id: number): Row[] {
    const { parents } = listing.folders;
    const counts = new Map<number, number>();
    for (let k = 1; k < parents.length; k++) if (parents[k] === id) counts.set(k, 0);
    for (let k = 1; k < parents.length; k++) {
        const count = counts.get(parents[k]!);
        if (count !== undefined) counts.set(parents[k]!, count + 1);
    }
    const files: Row[] = [];
    for (const entry of listing.entries) {
        if (entry.hidden || entry.directory) continue;
        if (entry.folder === id) files.push({ kind: 'file', name: entry.name, entry });
        const count = counts.get(entry.folder);
        if (count !== undefined) counts.set(entry.folder, count + 1);
    }
    const folders = [...counts]
        .map(([k, count]): Row => ({
            kind: 'folder',
            id: k,
            name: folderName(listing.folders, k),
            count,
        }))
        .sort((a, b) => byName.compare(a.name, b.name));
    files.sort((a, b) => byName.compare(a.name, b.name));
    return [...folders, ...files];
}

/* One download: its own, by `id`, so the same entry downloaded twice is two downloads, each stopped on its own. */
type Download = {
    id: number;
    entry: ArchiveEntry;
    written: number;
    stop: () => void;
    error: string | null;
};

let downloadIds = 0;

export function ArchiveView({ node, onDownload }: { node: DriveNode; onDownload: () => void }) {
    const [session, setSession] = useState<ArchiveSession | null>(null);
    const [listing, setListing] = useState<Listing | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    // The folders from the top to the one shown, by id.
    const [path, setPath] = useState<number[]>([]);
    const [opened, setOpened] = useState<ArchiveEntry | null>(null);
    const [unlocked, setUnlocked] = useState(false);
    // The held password, which only its quick check had passed, was let go of: the cards say it may be wrong.
    const [doubted, setDoubted] = useState(false);
    const [downloads, setDownloads] = useState<Download[]>([]);
    const [asking, setAsking] = useState<ArchiveEntry | null>(null);
    // An entry whose password is asked for so it can be downloaded.
    const [askFor, setAskFor] = useState<ArchiveEntry | null>(null);
    const versionId = node.currentVersion?.id ?? node.id;

    useEffect(() => {
        let active = true;
        let current: ArchiveSession | null = null;
        // Closing the viewer while a small archive is read whole stops the read itself.
        const leaving = new AbortController();
        void (async () => {
            try {
                const reader = await archiveReader(node, leaving.signal);
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
            leaving.abort();
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

    const shown = path.at(-1) ?? 0;
    // The trail scrolled to its end whenever it changes: the crumb shown is the last.
    const trail = useRef<HTMLOListElement>(null);
    useEffect(() => {
        const ol = trail.current;
        if (ol) ol.scrollLeft = ol.scrollWidth;
    }, [path, opened]);
    const rows = useMemo(() => (listing ? rowsOf(listing, shown) : []), [listing, shown]);

    function startDownload(entry: ArchiveEntry) {
        if (!session) return;
        // The sink first, while the click still counts as one (a save dialog needs it). Under the
        // name made safe in the worker: no bidi override can make "…exe" read as "…txt".
        const sink = openSink({ name: entry.saveName, size: entry.size });
        let handle: { done: Promise<void>; stop: () => void } | null = null;
        // Stop can come before the sink is open: it is remembered, and a sink opened after it is let go.
        let stopped = false;
        const id = ++downloadIds;
        const record: Download = {
            id,
            entry,
            written: 0,
            stop: () => {
                stopped = true;
                handle?.stop();
            },
            error: null,
        };
        setDownloads((list) => [...list, record]);
        const update = (patch: Partial<Download>) =>
            setDownloads((list) =>
                list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
            );
        const drop = () => setDownloads((list) => list.filter((item) => item.id !== id));
        void sink
            .then(async (opened) => {
                if (stopped) {
                    await opened.abort().catch(() => {});
                    throw new Error('Stopped.');
                }
                handle = session.download(entry, opened, (written) => update({ written }));
                return handle.done;
            })
            .then(drop, (cause: unknown) => {
                if (cause instanceof Error && cause.message === 'Stopped.') return drop();
                // The entry has a password of its own: asked for, then downloaded.
                if (cause instanceof ArchiveRefusal && cause.code === 'wrong-password') {
                    drop();
                    setAskFor(entry);
                    setOpened(entry);
                    return;
                }
                // No password held for it any more (the held one, maybe wrong, let go of): asked for again.
                if (
                    cause instanceof ArchiveRefusal &&
                    (cause.code === 'password-unproven' || cause.code === 'password')
                ) {
                    drop();
                    passwordLost(cause.code === 'password-unproven');
                    setAskFor(entry);
                    setOpened(entry);
                    return;
                }
                update({ error: cause instanceof Error ? cause.message : viewerWords.broken });
            });
    }

    /* The archive holds no password: every locked entry asks again, saying why when it may have been wrong. */
    function passwordLost(doubt: boolean) {
        setUnlocked(false);
        setDoubted(doubt);
    }

    /* After a password has opened it, or when none is needed. */
    function downloadNow(entry: ArchiveEntry) {
        if (asksFirst(entry)) {
            setAsking(entry);
            return;
        }
        startDownload(entry);
    }

    function download(entry: ArchiveEntry) {
        if (entry.lock !== 'none' && !unlocked) {
            // The entry's pane asks for the password, then downloads.
            setAskFor(entry);
            setOpened(entry);
            return;
        }
        downloadNow(entry);
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

    const go = (to: number[]) => {
        setOpened(null);
        setAskFor(null);
        setPath(to);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-archive>
            {/* At the top the header already names the archive: the trail shows only inside it. */}
            {(path.length > 0 || opened) && (
                <nav
                    aria-label={archiveWords.folders}
                    className="flex min-h-12 shrink-0 items-center border-b border-rule px-3 sm:px-5"
                >
                    {/* One line however deep: it scrolls sideways (to the last crumb as the path changes), so a
                        deep path never pushes the contents down off a narrow screen. */}
                    <ol
                        ref={trail}
                        className="flex min-w-0 flex-nowrap items-center gap-0.5 overflow-x-auto text-sm [scrollbar-width:none]"
                    >
                        <Crumb
                            label={node.name}
                            current={path.length === 0 && !opened}
                            onClick={() => go([])}
                        />
                        {path.map((id, i) => (
                            <Crumb
                                key={id}
                                label={folderName(listing.folders, id)}
                                separated
                                current={i === path.length - 1 && !opened}
                                onClick={() => go(path.slice(0, i + 1))}
                            />
                        ))}
                        {opened && <Crumb label={opened.name} separated current />}
                    </ol>
                </nav>
            )}
            {opened ? (
                <EntryPane
                    key={opened.index}
                    archive={node}
                    entry={opened}
                    session={session}
                    unlocked={unlocked}
                    onUnlocked={() => {
                        setUnlocked(true);
                        setDoubted(false);
                    }}
                    doubted={doubted}
                    onPasswordLost={passwordLost}
                    onDownload={() => download(opened)}
                    downloadAfterPassword={askFor === opened}
                    onDownloadNow={() => {
                        setAskFor(null);
                        downloadNow(opened);
                    }}
                    onDownloadArchive={onDownload}
                />
            ) : (
                <EntryList
                    rows={rows}
                    unlocked={unlocked}
                    hidden={listing.hidden}
                    onFolder={(id) => go([...path, id])}
                    // Opened to look at it: a download waiting on another entry's password is let go of.
                    onOpen={(entry) => {
                        setAskFor(null);
                        setOpened(entry);
                    }}
                    onDownload={download}
                />
            )}
            {downloads.length > 0 && (
                <ul className="shrink-0 border-t border-rule bg-card">
                    {downloads.map((item) => (
                        <li
                            key={item.id}
                            className="flex min-h-12 items-center gap-3 px-3 text-[13px] sm:px-5"
                        >
                            <span className="min-w-0 flex-1 truncate">
                                {item.error ?? archiveWords.downloading(item.entry.name)}
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
                                    setDownloads((list) =>
                                        list.filter((other) => other.id !== item.id),
                                    );
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
        <li className="flex shrink-0 items-center gap-0.5">
            {separated && (
                <ChevronRightIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
            )}
            {current ? (
                <span
                    aria-current="page"
                    className="max-w-64 truncate px-2 py-1.5 font-semibold whitespace-nowrap"
                >
                    {label}
                </span>
            ) : (
                <button
                    type="button"
                    onClick={onClick}
                    className="max-w-64 truncate rounded-sm px-2 py-1.5 whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
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
    onFolder: (id: number) => void;
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
                                key={row.kind === 'folder' ? `d:${row.id}` : `f:${row.entry.index}`}
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
                                        onClick={() => onFolder(row.id)}
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
    downloadAfterPassword,
    onDownloadNow,
    doubted,
    onPasswordLost,
}: {
    archive: DriveNode;
    entry: ArchiveEntry;
    session: ArchiveSession;
    unlocked: boolean;
    onUnlocked: () => void;
    onDownload: () => void;
    onDownloadArchive: () => void;
    /* The password is asked for so the entry can be downloaded (its own, or one a preview can't use). */
    downloadAfterPassword: boolean;
    onDownloadNow: () => void;
    /* The password held was let go of, maybe wrong: the card says so. */
    doubted: boolean;
    onPasswordLost: (doubt: boolean) => void;
}) {
    const name = entry.name;
    const node = useMemo(
        () => entryNode(archive, entry, session.tag),
        [archive, entry, session.tag],
    );
    const kind = previewKind(node);
    const icon = <FileMark kind="file" name={name} size="large" />;
    // The entry has a password of its own (the one held didn't open it): asked for again.
    const [reprompt, setReprompt] = useState(false);
    /*
     * A stored entry past the limit, shown by range without its checksum checked: known from the
     * entry, as the worker decides it, so a preview the viewer remembers still says so.
     */
    const unchecked = entry.stored && entry.size > entryLimit(kind);
    const [attempt, setAttempt] = useState(0);
    const opener = useMemo(
        () =>
            async (signal: AbortSignal): Promise<FileReader> => {
                try {
                    const { reader, checked } = await session.preview(
                        entry,
                        entryLimit(kind),
                        signal,
                    );
                    // The worker and the page agree on what is checked, or the preview isn't shown.
                    if (checked === unchecked) throw new Error(viewerWords.broken);
                    return reader;
                } catch (cause) {
                    if (cause instanceof ArchiveRefusal && cause.code === 'wrong-password')
                        setReprompt(true);
                    // No password held any more (the held one, maybe wrong, let go of): the card asks again.
                    if (
                        cause instanceof ArchiveRefusal &&
                        (cause.code === 'password-unproven' || cause.code === 'password')
                    )
                        onPasswordLost(cause.code === 'password-unproven');
                    throw cause;
                }
            },
        // A new attempt (after a password) opens afresh.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [session, entry, kind, attempt],
    );
    let body: React.ReactNode;
    // What can't be read at all says so first: a password would change nothing.
    if (entry.support !== 'ok')
        body = (
            <Notice
                icon={icon}
                title={name}
                text={entry.support === 'method' ? archiveWords.method : archiveWords.encryption}
                onDownload={onDownloadArchive}
            />
        );
    // A locked archive inside the archive is never previewed, but its Download asks for the password.
    else if (
        entry.lock !== 'none' &&
        (!unlocked || reprompt || downloadAfterPassword) &&
        (!entry.nested || downloadAfterPassword)
    )
        body = (
            <PasswordCard
                name={name}
                session={session}
                entry={entry}
                note={doubted ? archiveWords.passwordUnproven : null}
                onUnlocked={() => {
                    setReprompt(false);
                    setAttempt((value) => value + 1);
                    onUnlocked();
                    if (downloadAfterPassword) onDownloadNow();
                }}
            />
        );
    else if (entry.nested)
        body = (
            <Notice icon={icon} title={name} text={archiveWords.nested} onDownload={onDownload} />
        );
    // An unknown kind is no preview at any size (the viewer looks at small ones as text).
    else if (!entry.stored && kind !== 'none' && entry.size > entryLimit(kind))
        body = (
            <Notice
                icon={icon}
                title={viewerWords.tooLarge(entry.size)}
                text={viewerWords.elsewhere}
                onDownload={onDownload}
            />
        );
    else
        body = (
            <>
                {unchecked && (
                    <p className="shrink-0 border-b border-rule px-5 py-2.5 text-[13px] text-muted-foreground sm:px-7">
                        {archiveWords.unverified}
                    </p>
                )}
                <PreviewBody
                    key={`${node.id}:${attempt}`}
                    node={node}
                    onDownload={onDownload}
                    open={opener}
                />
            </>
        );
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
    entry,
    note,
    onUnlocked,
}: {
    name: string;
    session: ArchiveSession;
    /*
     * The entry the password is asked for: tried on it first, so a password that opens only
     * some of the archive's entries opens the one the person picked.
     */
    entry: ArchiveEntry;
    /* Said before anything is typed: why the password is asked for again. */
    note: string | null;
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
            if (await session.unlock(password, entry)) onUnlocked();
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
                        aria-describedby={
                            wrong || error || note ? 'archive-password-error' : undefined
                        }
                        wrapperClassName="min-w-0 flex-1"
                    />
                    <Button type="submit" className="h-11" disabled={!password || busy}>
                        {archiveWords.open}
                    </Button>
                </div>
                {(wrong || error || note) && (
                    <p
                        id="archive-password-error"
                        role="alert"
                        className="text-sm text-destructive"
                    >
                        {wrong ? archiveWords.wrongPassword : (error ?? note)}
                    </p>
                )}
            </form>
        </Notice>
    );
}
