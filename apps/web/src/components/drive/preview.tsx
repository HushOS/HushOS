import type { DriveNode } from '@hushos/drive/client';
import { officeKind } from '@/lib/office';
import type { FileReader } from '@hushos/drive/downloads';
import { useHotkey } from '@tanstack/react-hotkeys';
import { cn } from 'cn';
import {
    ChevronLeftIcon,
    ChevronRightIcon,
    DownloadIcon,
    FileQuestionIcon,
    RotateCcwIcon,
    UserPlusIcon,
    XIcon,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import {
    Notice,
    Opening,
    SourceSwitch,
    useSourceSwitch,
    viewerWords,
} from '@/components/drive/viewer-parts';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatBytes, formatWhen, nodeSize } from '@/lib/drive';
import { languageFor } from '@/lib/highlight';
import {
    looksLikeText,
    openReader,
    PREVIEW_LIMITS,
    previewKind,
    previewMime,
    readAll,
    type ReadProgress,
    recallPreview,
    rememberPreview,
    serveMedia,
} from '@/lib/previews';

/*
 * The viewer: one file at a time over the folder, with the neighbours a key
 * press away. Each kind of file has its own renderer under the same header;
 * everything decrypts on this device and nothing is written anywhere.
 */

const PdfViewer = lazy(() =>
    import('@/components/drive/pdf-viewer').then((m) => ({ default: m.PdfViewer })),
);
const OfficeViewer = lazy(() =>
    import('@/components/drive/office-viewer').then((m) => ({ default: m.OfficeViewer })),
);
// The Markdown pipeline and the highlighter's core arrive with the first text
// preview, not with the folder view.
const CodeView = lazy(() =>
    import('@/components/drive/rich-text').then((m) => ({ default: m.CodeView })),
);
const MarkdownView = lazy(() =>
    import('@/components/drive/rich-text').then((m) => ({ default: m.MarkdownView })),
);

/* An earlier version open in the viewer: when it was replaced, how long it stays, and Restore. */
export type ViewerVersion = {
    meta: string;
    banner: string;
    restoring: boolean;
    onRestore: () => void;
};

export function Preview({
    files,
    current,
    onChange,
    onDownload,
    onShare,
    access,
    version,
}: {
    files: DriveNode[];
    current: DriveNode | null;
    onChange: (node: DriveNode | null) => void;
    onDownload: (node: DriveNode) => void;
    /* Where the person may share the file, Share in the header. */
    onShare?: (node: DriveNode) => void;
    /* Who can open the file, beside the actions. */
    access?: (node: DriveNode) => ReactNode;
    /* An earlier version instead of the file: no neighbours, no Share, a banner with Restore. */
    version?: ViewerVersion;
}) {
    const index = current ? files.findIndex((file) => file.id === current.id) : -1;
    const previous = !version && index > 0 ? files[index - 1] : undefined;
    const next = !version && index >= 0 && index < files.length - 1 ? files[index + 1] : undefined;
    const open = current !== null;
    useHotkey('ArrowLeft', () => previous && onChange(previous), { enabled: open });
    useHotkey('ArrowRight', () => next && onChange(next), { enabled: open });
    // Formatted | Source, offered by the renderer and kept per file.
    const [offered, setOffered] = useState(false);
    const [sourceFor, setSourceFor] = useState<string | null>(null);
    const source = current !== null && sourceFor === current.id;
    const offer = useCallback((available: boolean) => setOffered(available), []);
    const switchValue = useMemo(() => ({ source, offer }), [source, offer]);
    return (
        <Dialog open={open} onOpenChange={(value) => !value && onChange(null)}>
            <DialogContent
                showCloseButton={false}
                // No enter or exit transition: Base UI waits for the popup's transition to end
                // before unmounting, and a viewer this size can be closed before its
                // opening transition has begun, which left an invisible popup over the page.
                className="inset-0 top-0 left-0 flex h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 text-base shadow-none transition-none *:min-w-0 sm:max-w-none sm:p-0"
                onKeyDown={(event) => {
                    // The dialog holds focus, so the arrows are handled here as well.
                    if ((event.target as HTMLElement).tagName === 'INPUT') return;
                    if (event.key === 'ArrowLeft' && previous) onChange(previous);
                    else if (event.key === 'ArrowRight' && next) onChange(next);
                    else return;
                    event.preventDefault();
                }}
            >
                {current && (
                    <>
                        <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-3 border-b border-rule bg-card py-2 pr-2 pl-5 sm:flex-nowrap sm:pr-3">
                            {/* On a phone the name takes a full line; wider, it shortens in the middle so its type stays. */}
                            <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                                <DialogTitle
                                    className="flex min-w-0 text-[15px] font-bold"
                                    title={current.name}
                                >
                                    <MiddleName name={current.name} />
                                </DialogTitle>
                                <DialogDescription className="truncate text-[13px] text-muted-foreground tabular-nums">
                                    {version
                                        ? version.meta
                                        : [
                                              formatBytes(nodeSize(current)),
                                              formatWhen(
                                                  current.metadata?.modified ?? current.updatedAt,
                                              ),
                                              files.length > 1
                                                  ? `${index + 1} of ${files.length}`
                                                  : null,
                                          ]
                                              .filter(Boolean)
                                              .join(' · ')}
                                </DialogDescription>
                            </div>
                            {access && !version && (
                                <span className="hidden h-8 max-w-56 shrink-0 items-center rounded-full bg-muted px-3 lg:flex">
                                    {access(current)}
                                </span>
                            )}
                            {offered && (
                                <fieldset className="m-0 inline-flex min-w-0 shrink-0 rounded-md border-0 bg-muted p-0.5">
                                    <legend className="sr-only">Show</legend>
                                    {(['Formatted', 'Source'] as const).map((label) => {
                                        const on = (label === 'Source') === source;
                                        return (
                                            <button
                                                key={label}
                                                type="button"
                                                aria-pressed={on}
                                                onClick={() =>
                                                    setSourceFor(
                                                        label === 'Source' ? current.id : null,
                                                    )
                                                }
                                                className={cn(
                                                    'h-8 cursor-pointer rounded-sm px-2.5 text-[13px] sm:px-3 font-semibold outline-none focus-visible:outline-2 focus-visible:outline-ring',
                                                    on
                                                        ? 'bg-card text-foreground shadow-sm'
                                                        : 'text-muted-foreground hover:text-foreground',
                                                )}
                                            >
                                                {label}
                                            </button>
                                        );
                                    })}
                                </fieldset>
                            )}
                            <div className="ml-auto flex shrink-0 items-center sm:gap-1">
                                {!version && files.length > 1 && (
                                    <>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label="Previous file"
                                            title="Previous file (←)"
                                            disabled={!previous}
                                            onClick={() => previous && onChange(previous)}
                                        >
                                            <ChevronLeftIcon />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label="Next file"
                                            title="Next file (→)"
                                            disabled={!next}
                                            onClick={() => next && onChange(next)}
                                        >
                                            <ChevronRightIcon />
                                        </Button>
                                    </>
                                )}
                                {!version && onShare && (
                                    <>
                                        <span
                                            className="mx-1 h-6 w-px bg-rule max-sm:hidden"
                                            aria-hidden="true"
                                        />
                                        <Button
                                            variant="outline"
                                            aria-label="Share"
                                            className="max-sm:size-9 max-sm:px-0 max-sm:pointer-coarse:size-11"
                                            onClick={() => onShare(current)}
                                        >
                                            <UserPlusIcon />
                                            <span className="max-sm:hidden">Share</span>
                                        </Button>
                                    </>
                                )}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Download"
                                    title="Download"
                                    onClick={() => onDownload(current)}
                                >
                                    <DownloadIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Close preview"
                                    title="Close (Esc)"
                                    onClick={() => onChange(null)}
                                >
                                    <XIcon />
                                </Button>
                            </div>
                        </header>
                        {version && (
                            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule bg-accent px-5 py-2.5 text-sm text-accent-foreground">
                                <span className="min-w-0 flex-1">
                                    <b>Earlier version.</b> {version.banner}
                                </span>
                                <Button
                                    size="sm"
                                    disabled={version.restoring}
                                    onClick={version.onRestore}
                                >
                                    {version.restoring ? <Spinner /> : <RotateCcwIcon />}
                                    {version.restoring ? 'Restoring…' : 'Restore this version'}
                                </Button>
                            </div>
                        )}
                        <SourceSwitch.Provider value={switchValue}>
                            <PreviewBody
                                key={current.currentVersion?.id ?? current.id}
                                node={current}
                                onDownload={onDownload}
                            />
                        </SourceSwitch.Provider>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

/*
 * A long name shortened in the middle, so its end and its type stay visible:
 * the start truncates, the last few characters and the extension never do.
 */
function MiddleName({ name }: { name: string }) {
    const dot = name.lastIndexOf('.');
    const cut = Math.max(0, (dot > 0 ? dot : name.length) - 6);
    if (cut < 8) return <span className="truncate">{name}</span>;
    return (
        <>
            <span className="truncate">{name.slice(0, cut)}</span>
            <span className="shrink-0 whitespace-pre">{name.slice(cut)}</span>
        </>
    );
}

/*
 * A reader for the node, open for as long as the body shows it. The reader is
 * made inside the effect and closed in its cleanup, so a remount (React runs
 * effects twice in development) closes one reader and opens another rather than
 * closing the one still in use.
 */
function useReader(node: DriveNode, enabled: boolean) {
    const [state, setState] = useState<{ reader: FileReader | null; error: string | null }>({
        reader: null,
        error: null,
    });
    useEffect(() => {
        if (!enabled) return;
        let active = true;
        let opened: FileReader | null = null;
        let failure: string | null = null;
        try {
            opened = openReader(node);
        } catch (cause) {
            failure = cause instanceof Error ? cause.message : 'This file could not be opened.';
        }
        // Published after the effect settles, never during it.
        void Promise.resolve().then(() => {
            if (active) setState({ reader: opened, error: failure });
        });
        return () => {
            active = false;
            void opened?.close();
        };
    }, [node, enabled]);
    return state;
}

function PreviewBody({
    node,
    onDownload,
}: {
    node: DriveNode;
    onDownload: (node: DriveNode) => void;
}) {
    const kind = previewKind(node);
    const size = nodeSize(node) ?? 0;
    const textual = kind === 'text' || kind === 'markdown';
    const tooLarge =
        (kind === 'image' && size > PREVIEW_LIMITS.image) ||
        (textual && size > PREVIEW_LIMITS.text);
    // An unknown type still gets a look: a small file that reads as text opens as text.
    const sniff = kind === 'none' && size <= PREVIEW_LIMITS.text && Boolean(node.currentVersion);
    const remembered = node.currentVersion ? recallPreview(node.currentVersion.id) : null;
    const { reader, error } = useReader(
        node,
        (kind !== 'none' || sniff) && !tooLarge && remembered === null,
    );
    const download = () => onDownload(node);
    if (kind === 'none' && !sniff) return <NoPreview node={node} onDownload={download} />;
    if (tooLarge) return <TooLarge node={node} onDownload={download} />;
    if (error) return <Failed message={error} onDownload={download} />;
    if (remembered?.kind === 'image') return <ImageFrame url={remembered.url} node={node} />;
    if (remembered?.kind === 'text')
        return (
            <TextFrame
                node={node}
                kind={kind === 'markdown' ? 'markdown' : 'text'}
                text={remembered.text}
                truncated={remembered.truncated}
            />
        );
    if (remembered?.kind === 'document' && (kind === 'pdf' || kind === 'office'))
        return kind === 'pdf' ? (
            <Suspense fallback={<Opening />}>
                <PdfViewer
                    source={remembered.data}
                    versionId={null}
                    name={node.name}
                    onDownload={download}
                />
            </Suspense>
        ) : (
            <Suspense fallback={<Opening />}>
                <OfficeViewer
                    source={remembered.data}
                    versionId={null}
                    kind={officeKind(node.name, node.metadata?.mime ?? null)!}
                    name={node.name}
                    onDownload={download}
                />
            </Suspense>
        );
    if (remembered?.kind === 'media' && (kind === 'video' || kind === 'audio'))
        return <MediaFrame url={remembered.url} kind={kind} />;
    if (!reader) return <Opening />;
    switch (kind) {
        case 'image':
            return <ImagePreview reader={reader} node={node} onDownload={download} />;
        case 'text':
        case 'markdown':
            return <TextPreview reader={reader} node={node} kind={kind} onDownload={download} />;
        case 'none':
            return <TextPreview reader={reader} node={node} kind="sniff" onDownload={download} />;
        case 'pdf':
            return (
                <Suspense fallback={<Opening />}>
                    <PdfViewer
                        source={reader}
                        versionId={node.currentVersion?.id ?? null}
                        name={node.name}
                        onDownload={download}
                    />
                </Suspense>
            );
        case 'office':
            return (
                <Suspense fallback={<Opening />}>
                    <OfficeViewer
                        source={reader}
                        versionId={node.currentVersion?.id ?? null}
                        kind={officeKind(node.name, node.metadata?.mime ?? null)!}
                        name={node.name}
                        onDownload={download}
                    />
                </Suspense>
            );
        case 'video':
        case 'audio':
            return <MediaPreview reader={reader} node={node} kind={kind} onDownload={download} />;
    }
}

/* Couldn't be read: the reason the reader gave, and Download to try elsewhere. */
function Failed({ message, onDownload }: { message: string; onDownload: () => void }) {
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
            text={message}
            onDownload={onDownload}
        />
    );
}

function NoPreview({ node, onDownload }: { node: DriveNode; onDownload: () => void }) {
    return (
        <Notice
            icon={<FileMark node={node} size="large" />}
            title={viewerWords.noPreview}
            text={`${node.name} · ${formatBytes(nodeSize(node))}`}
            onDownload={onDownload}
        />
    );
}

function TooLarge({ node, onDownload }: { node: DriveNode; onDownload: () => void }) {
    const kind = previewKind(node);
    return (
        <Notice
            icon={<FileMark node={node} size="large" />}
            title={viewerWords.tooLarge(nodeSize(node) ?? 0)}
            text={
                kind === 'video' || kind === 'audio'
                    ? viewerWords.elsewhereMedia
                    : viewerWords.elsewhere
            }
            onDownload={onDownload}
        />
    );
}

const readFailure = (cause: unknown) =>
    cause instanceof Error ? cause.message : 'The file could not be read.';

/*
 * Decrypts the image to a blob URL and remembers it for the session; SVG goes
 * through <img>, never inline. The cache owns the URL and revokes it on eviction.
 */
function ImagePreview({
    reader,
    node,
    onDownload,
}: {
    reader: FileReader;
    node: DriveNode;
    onDownload: () => void;
}) {
    const mime = previewMime(node);
    const versionId = node.currentVersion?.id ?? null;
    const [progress, setProgress] = useState<ReadProgress | null>(null);
    const [state, setState] = useState<{ url: string | null; error: string | null }>({
        url: null,
        error: null,
    });
    useEffect(() => {
        let active = true;
        readAll(reader, PREVIEW_LIMITS.image, (value) => active && setProgress(value))
            .then(({ bytes }) => {
                if (!active) return;
                const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
                if (versionId)
                    rememberPreview(versionId, { kind: 'image', url, bytes: bytes.byteLength });
                setState({ url, error: null });
            })
            .catch((cause: unknown) => {
                if (active) setState({ url: null, error: readFailure(cause) });
            });
        return () => {
            active = false;
        };
    }, [reader, mime, versionId]);
    if (state.error) return <Failed message={state.error} onDownload={onDownload} />;
    if (!state.url) return <Opening name={node.name} progress={progress} />;
    return <ImageFrame url={state.url} node={node} />;
}

function ImageFrame({ url, node }: { url: string; node: DriveNode }) {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
            <img
                src={url}
                alt={node.name}
                className="max-h-full max-w-full rounded-sm object-contain"
            />
        </div>
    );
}

/*
 * Text of every kind. Markdown renders from its syntax tree; code highlights
 * once its grammar has loaded, plain text until then; a file of unknown type is
 * read first and shown only if its bytes look like text.
 */
function TextPreview({
    reader,
    node,
    kind,
    onDownload,
}: {
    reader: FileReader;
    node: DriveNode;
    kind: 'text' | 'markdown' | 'sniff';
    onDownload: () => void;
}) {
    const versionId = node.currentVersion?.id ?? null;
    const [progress, setProgress] = useState<ReadProgress | null>(null);
    const [state, setState] = useState<
        { text: string; truncated: boolean; binary: false } | { binary: true } | null
    >(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        readAll(reader, PREVIEW_LIMITS.text, (value) => active && setProgress(value))
            .then(({ bytes, truncated }) => {
                if (!active) return;
                if (kind === 'sniff' && !looksLikeText(bytes)) {
                    setState({ binary: true });
                    return;
                }
                const text = new TextDecoder().decode(bytes);
                if (versionId)
                    rememberPreview(versionId, {
                        kind: 'text',
                        text,
                        truncated,
                        bytes: bytes.byteLength,
                    });
                setState({ text, truncated, binary: false });
            })
            .catch((cause: unknown) => {
                if (active) setError(readFailure(cause));
            });
        return () => {
            active = false;
        };
    }, [reader, kind, versionId]);
    if (error) return <Failed message={error} onDownload={onDownload} />;
    if (!state) return <Opening name={node.name} progress={progress} />;
    if (state.binary) return <NoPreview node={node} onDownload={onDownload} />;
    return (
        <TextFrame
            node={node}
            kind={kind === 'markdown' ? 'markdown' : 'text'}
            text={state.text}
            truncated={state.truncated}
        />
    );
}

/* The text itself; Markdown offers Formatted | Source in the header. */
function TextFrame({
    node,
    kind,
    text,
    truncated,
}: {
    node: DriveNode;
    kind: 'text' | 'markdown';
    text: string;
    truncated: boolean;
}) {
    const source = useSourceSwitch(kind === 'markdown' && !truncated);
    const rendered = kind === 'markdown' && !truncated && !source;
    const language = kind === 'markdown' ? 'markdown' : languageFor(node.name);
    if (!text.trim())
        return <Notice icon={<FileMark node={node} size="large" />} title={viewerWords.nothing} />;
    return (
        // A document is a sheet lying on the desk, at reading width; long lines scroll inside it.
        <div className="min-h-0 flex-1 overflow-auto px-3 py-4 sm:px-6 sm:py-8">
            <div className="sheet mx-auto flex w-full max-w-4xl min-w-0 flex-col">
                <Suspense fallback={<Opening />}>
                    {rendered ? (
                        <MarkdownView text={text} />
                    ) : (
                        <CodeView text={text} language={language} />
                    )}
                </Suspense>
                {truncated && (
                    <p className="border-t border-rule px-6 py-3 text-[13px] text-muted-foreground">
                        Showing the first {formatBytes(PREVIEW_LIMITS.text)}. Download it for the
                        rest.
                    </p>
                )}
            </div>
        </div>
    );
}

/*
 * A short clip is decrypted whole to a blob URL and remembered for the session,
 * like an image. Longer media plays from the download worker's player page,
 * which asks this page for ranges as it seeks; without the worker, a blob under
 * the larger limit, else the too-large card.
 */
function MediaPreview({
    reader,
    node,
    kind,
    onDownload,
}: {
    reader: FileReader;
    node: DriveNode;
    kind: 'video' | 'audio';
    onDownload: () => void;
}) {
    const mime = previewMime(node);
    const versionId = node.currentVersion?.id ?? null;
    const [progress, setProgress] = useState<ReadProgress | null>(null);
    const [source, setSource] = useState<
        { via: 'worker' | 'blob'; url: string } | { via: 'none' } | null
    >(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        let release: (() => void) | null = null;
        let blobUrl: string | null = null;
        const report = (value: ReadProgress) => active && setProgress(value);
        void (async () => {
            try {
                if (reader.size <= PREVIEW_LIMITS.media) {
                    const { bytes } = await readAll(reader, PREVIEW_LIMITS.media, report);
                    if (!active) return;
                    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
                    // The cache owns this URL and revokes it on eviction.
                    if (versionId)
                        rememberPreview(versionId, { kind: 'media', url, bytes: bytes.byteLength });
                    else blobUrl = url;
                    setSource({ via: 'blob', url });
                    return;
                }
                const served = await serveMedia(reader, { name: node.name, mime, kind });
                if (!active) {
                    served?.release();
                    return;
                }
                if (served) {
                    release = served.release;
                    setSource({ via: 'worker', url: served.url });
                    return;
                }
                if (reader.size > PREVIEW_LIMITS.mediaBlob) {
                    setSource({ via: 'none' });
                    return;
                }
                const { bytes } = await readAll(reader, PREVIEW_LIMITS.mediaBlob, report);
                if (!active) return;
                blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
                setSource({ via: 'blob', url: blobUrl });
            } catch (cause) {
                if (active) setError(readFailure(cause));
            }
        })();
        return () => {
            active = false;
            release?.();
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        };
    }, [reader, node.name, mime, kind, versionId]);
    if (error) return <Failed message={error} onDownload={onDownload} />;
    if (!source) return <Opening name={node.name} progress={progress} />;
    if (source.via === 'none') return <TooLarge node={node} onDownload={onDownload} />;
    if (source.via === 'worker')
        return (
            <iframe
                title={node.name}
                src={source.url}
                className="min-h-0 flex-1 border-0 bg-black"
                allow="autoplay; fullscreen"
            />
        );
    return <MediaFrame url={source.url} kind={kind} />;
}

function MediaFrame({ url, kind }: { url: string; kind: 'video' | 'audio' }) {
    return (
        <div
            className={cn(
                'flex min-h-0 flex-1 items-center justify-center p-4',
                kind === 'video' && 'bg-black',
            )}
        >
            {kind === 'audio' ? (
                // oxlint-disable-next-line jsx-a11y/media-has-caption -- a person's own file carries no caption track
                <audio controls autoPlay src={url} className="w-full max-w-2xl" />
            ) : (
                // oxlint-disable-next-line jsx-a11y/media-has-caption -- a person's own file carries no caption track
                <video controls autoPlay playsInline src={url} className="max-h-full max-w-full" />
            )}
        </div>
    );
}
