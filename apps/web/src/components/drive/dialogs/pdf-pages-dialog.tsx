import type { DriveNode } from '@hushos/drive/client';
import { THUMBNAIL_MAX_BYTES } from '@hushos/drive/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ChevronLeftIcon,
    ChevronRightIcon,
    RotateCwIcon,
    ScissorsIcon,
    Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { DialogField, Segmented } from '@/components/account/settings';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { driveKeys, formatBytes, nodeSize } from '@/lib/drive/drive';
import { suggestedName } from '@/lib/drive/runs/save-runs';
import {
    imagesFolderName,
    imagesStage,
    mergedName,
    pageImageName,
    pdfToolsStage,
    rangesOf,
    splitName,
    tooManyPages,
} from '@/lib/pdf-tools/names';
import { openPageDrawer, type PageDrawer } from '@/lib/pdf-tools/page-thumbnails';
import {
    IMAGES_MAX_PAGES,
    PDF_TOOLS_MAX_BYTES,
    PDF_TOOLS_MAX_FILES,
    PDF_TOOLS_MAX_PAGES,
    type PageInfo,
    type PagePlan,
    type PdfFlags,
    type Rotation,
} from '@/lib/pdf-tools/protocol';
import type { Inspected, PdfOutput, PdfPagesJob } from '@/lib/pdf-tools/make';
import { cn } from '@/lib/utils';

/*
 * Edit pages (docs/file-tools-design.md, feature (c)): every page of the PDFs chosen, in order, to
 * turn, put in order (drag, or each page's Move earlier and Move later), remove, and split after;
 * then saved as a new version of the one PDF, as a new file (one PDF edited, or several merged), as
 * one file a range when split, or as images in a new folder. pdf-lib in the PDF tools worker says
 * what each PDF is (its pages, its warnings, or why it can't be edited); pdf.js draws the pages.
 * Saving runs in the transfers panel; the dialog closes at once.
 */

type WithoutPlace<J> = J extends PdfPagesJob ? Omit<J, 'folder' | 'folderName' | 'sources'> : never;
/* What the dialog decided; the caller adds where it goes and from what. */
export type PdfPagesChoice = WithoutPlace<PdfPagesJob>;

export function PdfPagesDialog({
    folder,
    files,
    onOpenChange,
    onSave,
}: {
    folder: DriveNode;
    /* Null while closed. */
    files: DriveNode[] | null;
    onOpenChange: (open: boolean) => void;
    onSave: (choice: PdfPagesChoice) => void;
}) {
    return (
        <Dialog open={files !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[860px]">
                {files && (
                    <PdfPagesForm
                        // A new selection starts afresh.
                        key={files.map((node) => node.id).join()}
                        folder={folder}
                        files={files}
                        onClose={() => onOpenChange(false)}
                        onSave={onSave}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

type Item = { key: string; source: number; page: number; rotate: Rotation; info: PageInfo };
type Mode = 'version' | 'file' | 'images';
type Reading =
    | { status: 'waiting' }
    | { status: 'reading' }
    | { status: 'failed'; message: string }
    | { status: 'ready'; inspected: Extract<Inspected, { ok: true }>[] };

const FORMATS = [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPEG' },
] as const;
const RESOLUTIONS = [
    { value: '150', label: '150 dpi' },
    { value: '300', label: '300 dpi' },
] as const;
/* Thumbnails drawn for the outputs saved, at most: a split into hundreds saves the rest without. */
const OUTPUT_THUMBNAILS = 20;
const THUMBNAIL_EDGE = 512;

function PdfPagesForm({
    folder,
    files,
    onClose,
    onSave,
}: {
    folder: DriveNode;
    files: DriveNode[];
    onClose: () => void;
    onSave: (choice: PdfPagesChoice) => void;
}) {
    const queryClient = useQueryClient();
    const total = useMemo(
        () => files.reduce((sum, node) => sum + (nodeSize(node) || 0), 0),
        [files],
    );
    const stage = pdfToolsStage(files.length, total);
    const one = files.length === 1;
    const [reading, setReading] = useState<Reading>(() =>
        stage === 'fine' ? { status: 'reading' } : { status: 'waiting' },
    );
    const [items, setItems] = useState<Item[]>([]);
    const [original, setOriginal] = useState('');
    const [cuts, setCuts] = useState<Set<string>>(() => new Set());
    const [mode, setMode] = useState<Mode>(one ? 'version' : 'file');
    const [typed, setTyped] = useState<string | null>(null);
    const [format, setFormat] = useState<'png' | 'jpeg'>('png');
    const [dpi, setDpi] = useState<'150' | '300'>('150');
    const [flags, setFlags] = useState<PdfFlags>({ signed: false, outline: false, form: false });
    const [announcement, setAnnouncement] = useState('');
    const [dragging, setDragging] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const listId = useId();
    const drawers = useRef(new Map<number, Promise<PageDrawer>>());

    // Every drawer goes with the dialog: pdf.js's documents, their readers and their keys.
    useEffect(() => {
        const open = drawers.current;
        return () => {
            for (const drawer of open.values()) void drawer.then((d) => d.close()).catch(() => {});
            open.clear();
        };
    }, []);

    useEffect(() => {
        if (reading.status !== 'reading') return;
        let active = true;
        let look: { cancel(): void } | null = null;
        void import('@/lib/pdf-tools/make').then(({ inspectPdfs, refusalWords }) => {
            if (!active) return;
            const started = inspectPdfs(files);
            look = started;
            started.result.then(
                (inspected) => {
                    if (!active) return;
                    const refused = inspected.findIndex((source) => !source.ok);
                    if (refused >= 0) {
                        const source = inspected[refused] as Extract<Inspected, { ok: false }>;
                        setReading({
                            status: 'failed',
                            message: refusalWords(source.reason, one ? null : files[refused]!.name),
                        });
                        return;
                    }
                    const ready = inspected as Extract<Inspected, { ok: true }>[];
                    const pages = ready.reduce((sum, source) => sum + source.pages.length, 0);
                    if (tooManyPages(pages)) {
                        setReading({
                            status: 'failed',
                            message: `These PDFs have more than ${PDF_TOOLS_MAX_PAGES.toLocaleString('en')} pages together, too many to edit here.`,
                        });
                        return;
                    }
                    const list = ready.flatMap((source, s) =>
                        source.pages.map((info, page) => ({
                            key: `${s}:${page}`,
                            source: s,
                            page,
                            rotate: info.rotate,
                            info,
                        })),
                    );
                    setItems(list);
                    setOriginal(signature(list));
                    setFlags({
                        signed: ready.some((source) => source.flags.signed),
                        outline: ready.some((source) => source.flags.outline),
                        form: ready.some((source) => source.flags.form),
                    });
                    setReading({ status: 'ready', inspected: ready });
                },
                (error: unknown) => {
                    if (active)
                        setReading({
                            status: 'failed',
                            message: error instanceof Error ? error.message : String(error),
                        });
                },
            );
        });
        return () => {
            active = false;
            look?.cancel();
        };
    }, [reading.status, files, one]);

    // Stable, so a page's thumbnail is drawn when it shows or turns, not at every change of the list.
    const drawer = useCallback(
        (source: number) => {
            let open = drawers.current.get(source);
            if (!open) {
                open = openPageDrawer(files[source]!);
                open.catch(() => {});
                drawers.current.set(source, open);
            }
            return open;
        },
        [files],
    );

    const keyIndex = new Map(items.map((item, index) => [item.key, index]));
    const cutAfter = [...cuts].flatMap((key) => {
        const index = keyIndex.get(key);
        return index === undefined ? [] : [index];
    });
    const ranges = rangesOf(items.length, cutAfter);
    const split = ranges.length > 1;
    const changed = signature(items) !== original;
    const effective: Mode = mode === 'version' && (!one || split) ? 'file' : mode;
    const first = files[0]!;
    const singleName = one ? first.name : mergedName(first.name);
    const suggested = useQuery({
        // Under Drive's keys, so a lock clears the name with the listings it came from.
        queryKey: [...driveKeys.all, 'pdf-pages-name', folder.id, first.id, one],
        queryFn: () => suggestedName(queryClient, folder, singleName),
        staleTime: 0,
        enabled: !split && effective === 'file',
    });
    const name = typed ?? suggested.data ?? singleName;
    const trimmed = name.trim();
    const nameProblem =
        effective !== 'file' || split
            ? ''
            : !trimmed
              ? 'Enter a name.'
              : trimmed.includes('/')
                ? 'A name can’t have a slash in it.'
                : '';
    const imagesAre = imagesStage(items.length);

    function move(from: number, to: number) {
        if (to < 0 || to >= items.length || from === to) return;
        const next = [...items];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item!);
        setItems(next);
        setAnnouncement(`Page ${from + 1}, now ${to + 1} of ${next.length}`);
    }
    function rotate(index: number) {
        setItems(
            items.map((item, at) =>
                at === index ? { ...item, rotate: ((item.rotate + 90) % 360) as Rotation } : item,
            ),
        );
    }
    function remove(index: number) {
        const item = items[index]!;
        setItems(items.filter((_, at) => at !== index));
        setAnnouncement(`Page ${index + 1} removed`);
        if (cuts.has(item.key)) {
            const next = new Set(cuts);
            next.delete(item.key);
            setCuts(next);
        }
    }
    function toggleCut(index: number) {
        const key = items[index]!.key;
        const next = new Set(cuts);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setCuts(next);
    }
    function onDrop(event: DragEvent, to: number) {
        event.preventDefault();
        if (dragging !== null) move(dragging, to);
        setDragging(null);
    }

    const plan = (list: Item[]): PagePlan[] =>
        list.map((item) => ({ source: item.source, page: item.page, rotate: item.rotate }));

    async function thumbnailOf(pages: PagePlan[]) {
        const head = pages[0];
        if (!head) return null;
        try {
            const draw = await drawer(head.source);
            return await draw.thumbnail(
                head.page,
                head.rotate,
                THUMBNAIL_EDGE,
                THUMBNAIL_MAX_BYTES,
            );
        } catch {
            return null;
        }
    }

    async function save() {
        if (saving || items.length === 0) return;
        setSaving(true);
        try {
            if (effective === 'images') {
                const pages = plan(items);
                onSave({
                    kind: 'images',
                    pages,
                    sizes: items.map((item) => item.info),
                    format,
                    dpi: dpi === '300' ? 300 : 150,
                    imagesFolder: imagesFolderName(first.name),
                    names: pages.map((_, index) => pageImageName(index, format)),
                });
            } else {
                const outputs: PdfOutput[] = [];
                for (const [index, [from, to]] of ranges.entries()) {
                    const pages = plan(items.slice(from, to + 1));
                    outputs.push({
                        name: split ? splitName(first.name, from + 1, to + 1) : trimmed,
                        pages,
                        thumbnail: index < OUTPUT_THUMBNAILS ? await thumbnailOf(pages) : null,
                    });
                }
                if (effective === 'version')
                    onSave({
                        kind: 'version',
                        output: { ...outputs[0]!, name: first.name },
                        startedFrom: first.currentVersion?.id ?? null,
                    });
                else onSave({ kind: 'files', outputs });
            }
            onClose();
        } finally {
            setSaving(false);
        }
    }

    const ready = reading.status === 'ready';
    const title = one ? `Edit pages of ${first.name}` : `Edit pages of ${files.length} PDFs`;
    const saveOptions: { value: Mode; label: string }[] = [
        ...(one && !split ? [{ value: 'version' as const, label: 'New version' }] : []),
        {
            value: 'file' as const,
            label: split ? `${ranges.length} files` : one ? 'New file' : 'One file',
        },
        { value: 'images' as const, label: 'Images' },
    ];
    const blocked =
        !ready ||
        items.length === 0 ||
        Boolean(nameProblem) ||
        (effective === 'version' && !changed) ||
        (effective === 'images' && imagesAre === 'ceiling');

    return (
        <form
            className="contents"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                if (reading.status === 'waiting') {
                    setReading({ status: 'reading' });
                    return;
                }
                if (!blocked) void save();
            }}
        >
            <DialogHeader>
                <DialogTitle className="truncate">{title}</DialogTitle>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-5">
                {stage === 'ceiling' && (
                    <p className="text-sm text-destructive" role="alert">
                        These PDFs are too many or too large to edit here: at most{' '}
                        {PDF_TOOLS_MAX_FILES} files and {formatBytes(PDF_TOOLS_MAX_BYTES)}.
                    </p>
                )}
                {stage === 'offer' && reading.status === 'waiting' && (
                    <p className="text-sm">
                        {one ? 'This PDF is' : 'These PDFs are'} {formatBytes(total)}. Editing{' '}
                        {one ? 'it' : 'them'} uses a lot of memory and may be slow on this device.
                    </p>
                )}
                {reading.status === 'reading' && (
                    <output className="block text-sm text-muted-foreground">
                        Reading the pages
                    </output>
                )}
                {reading.status === 'failed' && (
                    <p className="text-sm text-destructive" role="alert">
                        {reading.message}
                    </p>
                )}
                {ready && (
                    <section
                        aria-labelledby={`${listId}-label`}
                        className="flex min-w-0 flex-col gap-2"
                    >
                        <h3 id={`${listId}-label`} className="text-sm font-semibold">
                            {items.length} {items.length === 1 ? 'page' : 'pages'}
                        </h3>
                        <ol
                            className="-mx-1 grid max-h-[46vh] grid-cols-[repeat(auto-fill,minmax(188px,1fr))] gap-2 overflow-y-auto px-1 pb-2"
                            aria-labelledby={`${listId}-label`}
                        >
                            {items.map((item, index) => (
                                // Dragging is the pointer's way; each page's Move buttons are the keyboard's and a screen reader's.
                                // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                                <li
                                    key={item.key}
                                    draggable
                                    onDragStart={(event) => {
                                        event.dataTransfer.effectAllowed = 'move';
                                        // Firefox starts no drag without some data.
                                        event.dataTransfer.setData('text/plain', item.key);
                                        setDragging(index);
                                    }}
                                    onDragEnd={() => setDragging(null)}
                                    onDragOver={(event) => {
                                        if (dragging === null) return;
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = 'move';
                                    }}
                                    onDrop={(event) => onDrop(event, index)}
                                    data-page={item.key}
                                    data-rotate={item.rotate}
                                    className={cn(
                                        'relative flex cursor-grab flex-col items-center gap-1.5 rounded-lg border border-edge bg-card p-2 select-none active:cursor-grabbing',
                                        dragging === index && 'opacity-50',
                                        cuts.has(item.key) &&
                                            index < items.length - 1 &&
                                            'border-r-4 border-r-primary',
                                    )}
                                >
                                    <span className="absolute top-1.5 left-2 text-xs font-semibold text-muted-foreground tabular-nums">
                                        {index + 1}
                                    </span>
                                    <PageThumbnail
                                        drawer={drawer}
                                        source={item.source}
                                        page={item.page}
                                        rotate={item.rotate}
                                        label={`Page ${index + 1}`}
                                    />
                                    {!one && (
                                        <span
                                            className="w-full truncate text-center text-xs text-muted-foreground"
                                            title={files[item.source]!.name}
                                        >
                                            {files[item.source]!.name}
                                        </span>
                                    )}
                                    <span className="flex">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Rotate page ${index + 1}`}
                                            onClick={() => rotate(index)}
                                        >
                                            <RotateCwIcon />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Move page ${index + 1} earlier`}
                                            disabled={index === 0}
                                            onClick={() => move(index, index - 1)}
                                        >
                                            <ChevronLeftIcon />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Move page ${index + 1} later`}
                                            disabled={index === items.length - 1}
                                            onClick={() => move(index, index + 1)}
                                        >
                                            <ChevronRightIcon />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Split after page ${index + 1}`}
                                            aria-pressed={cuts.has(item.key)}
                                            disabled={index === items.length - 1}
                                            className="aria-pressed:text-primary"
                                            onClick={() => toggleCut(index)}
                                        >
                                            <ScissorsIcon />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Remove page ${index + 1}`}
                                            disabled={items.length === 1}
                                            onClick={() => remove(index)}
                                        >
                                            <Trash2Icon />
                                        </Button>
                                    </span>
                                </li>
                            ))}
                        </ol>
                        <p className="sr-only" aria-live="polite">
                            {announcement}
                        </p>
                    </section>
                )}
                {ready && (
                    <div className="flex flex-col gap-2">
                        <h3 className="text-sm font-semibold">Save as</h3>
                        <Segmented
                            label="Save as"
                            options={saveOptions}
                            value={effective}
                            onChange={setMode}
                        />
                    </div>
                )}
                {ready && effective === 'file' && !split && (
                    <DialogField
                        label="Name"
                        value={name}
                        onChange={(event) => setTyped(event.target.value)}
                        error={nameProblem || undefined}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={255}
                    />
                )}
                {ready && effective === 'file' && split && (
                    <ul className="flex flex-col gap-1 text-sm" aria-label="Files">
                        {ranges.slice(0, 5).map(([from, to]) => (
                            <li key={from} className="truncate">
                                {splitName(first.name, from + 1, to + 1)}
                            </li>
                        ))}
                        {ranges.length > 5 && (
                            <li className="text-muted-foreground">and {ranges.length - 5} more</li>
                        )}
                    </ul>
                )}
                {ready && effective === 'images' && (
                    <div className="flex flex-wrap gap-5">
                        <div className="flex flex-col gap-2">
                            <h3 className="text-sm font-semibold">Format</h3>
                            <Segmented
                                label="Format"
                                options={FORMATS}
                                value={format}
                                onChange={setFormat}
                            />
                        </div>
                        <div className="flex flex-col gap-2">
                            <h3 className="text-sm font-semibold">Resolution</h3>
                            <Segmented
                                label="Resolution"
                                options={RESOLUTIONS}
                                value={dpi}
                                onChange={setDpi}
                            />
                        </div>
                    </div>
                )}
                {ready && effective === 'images' && imagesAre === 'offer' && (
                    <p className="text-sm">
                        Saving {items.length} pages as images takes a while and uses a lot of
                        memory.
                    </p>
                )}
                {ready && effective === 'images' && imagesAre === 'ceiling' && (
                    <p className="text-sm text-destructive" role="alert">
                        Save at most {IMAGES_MAX_PAGES} pages as images at a time.
                    </p>
                )}
                {ready && effective !== 'images' && flags.signed && (
                    <output className="block text-sm">
                        Its digital signature won’t be valid in the new file.
                    </output>
                )}
                {ready && effective !== 'images' && (flags.outline || flags.form) && (
                    <output className="block text-sm">
                        Bookmarks and form fields may not carry over.
                    </output>
                )}
            </div>
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                    {stage === 'ceiling' || reading.status === 'failed' ? 'Close' : 'Cancel'}
                </Button>
                {stage !== 'ceiling' && reading.status === 'waiting' && (
                    <Button type="submit">Continue</Button>
                )}
                {stage !== 'ceiling' &&
                    reading.status !== 'waiting' &&
                    reading.status !== 'failed' && (
                        <Button type="submit" disabled={blocked || saving}>
                            Save
                        </Button>
                    )}
            </DialogFooter>
        </form>
    );
}

/* The list as saved would see it: order, rotation, what's left. */
const signature = (list: Item[]) => list.map((item) => `${item.key}@${item.rotate}`).join(',');

/* One page drawn by pdf.js into its own canvas once it scrolls into view, again when it turns. */
function PageThumbnail({
    drawer,
    source,
    page,
    rotate,
    label,
}: {
    drawer: (source: number) => Promise<PageDrawer>;
    source: number;
    page: number;
    rotate: Rotation;
    label: string;
}) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [visible, setVisible] = useState(false);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        const element = canvas.current;
        if (!element || visible) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [visible]);
    useEffect(() => {
        if (!visible) return;
        let active = true;
        void drawer(source)
            .then((draw) =>
                active && canvas.current ? draw.draw(page, rotate, 240, canvas.current) : undefined,
            )
            .catch(() => active && setFailed(true));
        return () => {
            active = false;
        };
    }, [visible, source, page, rotate, drawer]);
    return (
        <div className="flex size-[120px] items-center justify-center">
            <canvas
                ref={canvas}
                aria-hidden="true"
                data-label={label}
                className={cn(
                    'max-h-[120px] max-w-[120px] border border-edge bg-white',
                    failed && 'hidden',
                )}
            />
        </div>
    );
}
