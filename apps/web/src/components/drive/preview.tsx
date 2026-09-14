import type { DriveNode } from '@hushos/drive/client';
import { officeKind } from '@/lib/office';
import type { FileReader } from '@hushos/drive/downloads';
import { useHotkey } from '@tanstack/react-hotkeys';
import {
    BookOpenTextIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    CodeIcon,
    DownloadIcon,
    FileIcon,
    XIcon,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Spinner } from '@/components/motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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

export function Preview({
    files,
    current,
    onChange,
    onDownload,
}: {
    files: DriveNode[];
    current: DriveNode | null;
    onChange: (node: DriveNode | null) => void;
    onDownload: (node: DriveNode) => void;
}) {
    const index = current ? files.findIndex((file) => file.id === current.id) : -1;
    const previous = index > 0 ? files[index - 1] : undefined;
    const next = index >= 0 && index < files.length - 1 ? files[index + 1] : undefined;
    const open = current !== null;
    useHotkey('ArrowLeft', () => previous && onChange(previous), { enabled: open });
    useHotkey('ArrowRight', () => next && onChange(next), { enabled: open });
    return (
        <Dialog open={open} onOpenChange={(value) => !value && onChange(null)}>
            <DialogContent
                showCloseButton={false}
                // No enter or exit transition: Base UI waits for the popup's transition to end
                // before unmounting, and a viewer this size can be closed before its
                // opening transition has begun, which left an invisible popup over the page.
                className="inset-0 top-0 left-0 flex h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden border-0 p-0 transition-none sm:max-w-none"
                onKeyDown={(event) => {
                    // The dialog holds focus, so the arrows are handled here as well.
                    if (event.key === 'ArrowLeft' && previous) onChange(previous);
                    else if (event.key === 'ArrowRight' && next) onChange(next);
                    else return;
                    event.preventDefault();
                }}
            >
                {current && (
                    <>
                        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b py-1.5 pr-2 pl-4">
                            {/* On a phone the name and its details take a full line and wrap; wider, one line, truncated. */}
                            <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                                <DialogTitle className="text-sm font-medium wrap-anywhere sm:truncate sm:text-nowrap">
                                    {current.name}
                                </DialogTitle>
                                <DialogDescription className="eyebrow mt-0.5 text-muted-foreground sm:truncate">
                                    {formatBytes(nodeSize(current))} ·{' '}
                                    {formatWhen(current.metadata?.modified ?? current.updatedAt)}
                                    {files.length > 1 && ` · ${index + 1} of ${files.length}`}
                                </DialogDescription>
                            </div>
                            <div className="ml-auto flex items-center gap-2">
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Previous file"
                                    disabled={!previous}
                                    onClick={() => previous && onChange(previous)}
                                >
                                    <ChevronLeftIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Next file"
                                    disabled={!next}
                                    onClick={() => next && onChange(next)}
                                >
                                    <ChevronRightIcon />
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="ml-2 max-sm:size-8 max-sm:px-0"
                                    aria-label="Download"
                                    onClick={() => onDownload(current)}
                                >
                                    <DownloadIcon />
                                    <span className="hidden sm:inline">Download</span>
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Close preview"
                                    onClick={() => onChange(null)}
                                >
                                    <XIcon />
                                </Button>
                            </div>
                        </header>
                        <PreviewBody key={current.id} node={current} onDownload={onDownload} />
                    </>
                )}
            </DialogContent>
        </Dialog>
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
    if ((kind === 'none' && !sniff) || tooLarge)
        return (
            <NoPreview
                node={node}
                onDownload={onDownload}
                reason={
                    tooLarge
                        ? `Files of this type preview up to ${formatBytes(kind === 'image' ? PREVIEW_LIMITS.image : PREVIEW_LIMITS.text)}.`
                        : 'This type of file has no preview yet.'
                }
            />
        );
    if (error) return <Failed message={error} />;
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
    if (!reader) return <Loading />;
    switch (kind) {
        case 'image':
            return <ImagePreview reader={reader} node={node} />;
        case 'text':
        case 'markdown':
            return <TextPreview reader={reader} node={node} kind={kind} />;
        case 'none':
            return <TextPreview reader={reader} node={node} kind="sniff" onDownload={onDownload} />;
        case 'pdf':
            return (
                <Suspense fallback={<Loading />}>
                    <PdfViewer reader={reader} />
                </Suspense>
            );
        case 'office':
            return (
                <Suspense fallback={<Loading />}>
                    <OfficeViewer
                        reader={reader}
                        kind={officeKind(node.name, node.metadata?.mime ?? null)!}
                        name={node.name}
                    />
                </Suspense>
            );
        case 'video':
        case 'audio':
            return <MediaPreview reader={reader} node={node} kind={kind} onDownload={onDownload} />;
    }
}

function Loading() {
    return (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Spinner />
        </div>
    );
}

function Failed({ message }: { message: string }) {
    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <Alert variant="destructive" className="max-w-md">
                <AlertTitle>No preview</AlertTitle>
                <AlertDescription>{message}</AlertDescription>
            </Alert>
        </div>
    );
}

function NoPreview({
    node,
    reason,
    onDownload,
}: {
    node: DriveNode;
    reason: string;
    onDownload: (node: DriveNode) => void;
}) {
    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <div className="flex max-w-sm flex-col items-center gap-5 text-center">
                <FileIcon aria-hidden="true" className="size-10 text-muted-foreground" />
                <div>
                    <p className="text-sm font-medium">{node.name}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {formatBytes(nodeSize(node))} · {previewMime(node)}
                    </p>
                    <p className="mt-3 text-sm text-muted-foreground">{reason}</p>
                </div>
                <Button size="sm" onClick={() => onDownload(node)}>
                    <DownloadIcon />
                    Download
                </Button>
            </div>
        </div>
    );
}

/*
 * Decrypts the image to a blob URL and remembers it for the session; SVG goes
 * through <img>, never inline. The cache owns the URL and revokes it on eviction.
 */
function ImagePreview({ reader, node }: { reader: FileReader; node: DriveNode }) {
    const mime = previewMime(node);
    const versionId = node.currentVersion?.id ?? null;
    const [state, setState] = useState<{ url: string | null; error: string | null }>({
        url: null,
        error: null,
    });
    useEffect(() => {
        let active = true;
        readAll(reader, PREVIEW_LIMITS.image)
            .then(({ bytes }) => {
                if (!active) return;
                const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
                if (versionId)
                    rememberPreview(versionId, { kind: 'image', url, bytes: bytes.byteLength });
                setState({ url, error: null });
            })
            .catch((cause: unknown) => {
                if (active)
                    setState({
                        url: null,
                        error:
                            cause instanceof Error ? cause.message : 'The file could not be read.',
                    });
            });
        return () => {
            active = false;
        };
    }, [reader, mime, versionId]);
    if (state.error) return <Failed message={state.error} />;
    if (!state.url) return <Loading />;
    return <ImageFrame url={state.url} node={node} />;
}

function ImageFrame({ url, node }: { url: string; node: DriveNode }) {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/40 p-4">
            <img src={url} alt={node.name} className="max-h-full max-w-full object-contain" />
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
    onDownload?: (node: DriveNode) => void;
}) {
    const versionId = node.currentVersion?.id ?? null;
    const [state, setState] = useState<
        { text: string; truncated: boolean; binary: false } | { binary: true } | null
    >(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        readAll(reader, PREVIEW_LIMITS.text)
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
                if (active)
                    setError(
                        cause instanceof Error ? cause.message : 'The file could not be read.',
                    );
            });
        return () => {
            active = false;
        };
    }, [reader, kind, versionId]);
    if (error) return <Failed message={error} />;
    if (!state) return <Loading />;
    if (state.binary)
        return (
            <NoPreview
                node={node}
                onDownload={onDownload ?? (() => {})}
                reason="This type of file has no preview yet."
            />
        );
    return (
        <TextFrame
            node={node}
            kind={kind === 'markdown' ? 'markdown' : 'text'}
            text={state.text}
            truncated={state.truncated}
        />
    );
}

/* The text itself; Markdown can be flipped to its source and back. */
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
    const [raw, setRaw] = useState(false);
    const rendered = kind === 'markdown' && !truncated && !raw;
    const language = kind === 'markdown' ? 'markdown' : languageFor(node.name);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {kind === 'markdown' && !truncated && (
                <div className="flex shrink-0 justify-end border-b px-3 py-1">
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-pressed={raw}
                        onClick={() => setRaw((value) => !value)}
                    >
                        {raw ? <BookOpenTextIcon /> : <CodeIcon />}
                        {raw ? 'Show rendered' : 'Show source'}
                    </Button>
                </div>
            )}
            <Suspense fallback={<Loading />}>
                {rendered ? (
                    <MarkdownView text={text} />
                ) : (
                    <CodeView text={text} language={language} />
                )}
            </Suspense>
            {truncated && (
                <p className="eyebrow border-t px-6 py-3 text-muted-foreground">
                    Showing the first {formatBytes(PREVIEW_LIMITS.text)}. Download for the rest.
                </p>
            )}
        </div>
    );
}

/*
 * Media plays from the download worker's player page, which asks this page for
 * ranges as it seeks; without the worker, a blob under the limit, else a card.
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
    onDownload: (node: DriveNode) => void;
}) {
    const mime = previewMime(node);
    const [source, setSource] = useState<
        { via: 'worker' | 'blob'; url: string } | { via: 'none' } | null
    >(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        let release: (() => void) | null = null;
        let blobUrl: string | null = null;
        void (async () => {
            try {
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
                const { bytes } = await readAll(reader, PREVIEW_LIMITS.mediaBlob);
                if (!active) return;
                blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
                setSource({ via: 'blob', url: blobUrl });
            } catch (cause) {
                if (active)
                    setError(
                        cause instanceof Error ? cause.message : 'The file could not be read.',
                    );
            }
        })();
        return () => {
            active = false;
            release?.();
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        };
    }, [reader, node.name, mime, kind]);
    if (error) return <Failed message={error} />;
    if (!source) return <Loading />;
    if (source.via === 'none')
        return (
            <NoPreview
                node={node}
                onDownload={onDownload}
                reason="This browser cannot stream media previews, and the file is too large to hold in memory."
            />
        );
    if (source.via === 'worker')
        return (
            <iframe
                title={node.name}
                src={source.url}
                className="min-h-0 flex-1 border-0 bg-black"
                allow="autoplay; fullscreen"
            />
        );
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
            {kind === 'audio' ? (
                // oxlint-disable-next-line jsx-a11y/media-has-caption -- a person's own file carries no caption track
                <audio controls autoPlay src={source.url} className="w-full max-w-2xl" />
            ) : (
                // oxlint-disable-next-line jsx-a11y/media-has-caption -- a person's own file carries no caption track
                <video
                    controls
                    autoPlay
                    playsInline
                    src={source.url}
                    className="max-h-full max-w-full"
                />
            )}
        </div>
    );
}
