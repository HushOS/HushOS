import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useId, useMemo, useState, type DragEvent } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import { DialogField, Segmented } from '@/components/settings';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { formatBytes, nodeSize } from '@/lib/drive';
import { defaultPageSize, type PageSize } from '@/lib/images-pdf/geometry';
import {
    IMAGES_PDF_MAX_BYTES,
    IMAGES_PDF_MAX_IMAGES,
    imagesPdfStage,
    pdfNameFor,
} from '@/lib/images-pdf/limits';
import { suggestedName } from '@/lib/save-runs';
import { cn } from '@/lib/utils';

/*
 * One PDF (docs/file-tools-design.md, feature (b)): the images in a row to put in order (drag,
 * or each one's Move earlier and Move later), the page size and margins, and the name, the
 * first image's with `.pdf`, the next free one in the folder. Making it runs in the transfers
 * panel; the dialog closes at once. The engine loads only then.
 */

export type ImagesPdfChoice = {
    images: DriveNode[];
    size: PageSize;
    margin: boolean;
    name: string;
};

export function ImagesPdfDialog({
    folder,
    images,
    onOpenChange,
    onMake,
}: {
    folder: DriveNode;
    /* Null while closed. */
    images: DriveNode[] | null;
    onOpenChange: (open: boolean) => void;
    onMake: (choice: ImagesPdfChoice) => void;
}) {
    return (
        <Dialog open={images !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                {images && (
                    <ImagesPdfForm
                        // A new selection starts afresh.
                        key={images.map((node) => node.id).join()}
                        folder={folder}
                        initial={images}
                        onClose={() => onOpenChange(false)}
                        onMake={onMake}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

const SIZES = [
    { value: 'fit', label: 'Fit to each image' },
    { value: 'a4', label: 'A4' },
    { value: 'letter', label: 'US Letter' },
] as const;
const MARGINS = [
    { value: 'none', label: 'None' },
    { value: '12mm', label: '12 mm' },
] as const;

function ImagesPdfForm({
    folder,
    initial,
    onClose,
    onMake,
}: {
    folder: DriveNode;
    initial: DriveNode[];
    onClose: () => void;
    onMake: (choice: ImagesPdfChoice) => void;
}) {
    const queryClient = useQueryClient();
    const [order, setOrder] = useState(initial);
    const [size, setSize] = useState<PageSize>(() => defaultPageSize());
    const [margin, setMargin] = useState<'none' | '12mm'>('none');
    // What the person typed; until then the name follows the first image.
    const [typed, setTyped] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');
    const [dragging, setDragging] = useState<number | null>(null);
    const listId = useId();
    const first = order[0]!;
    const suggested = useQuery({
        queryKey: ['images-pdf-name', folder.id, first.id],
        queryFn: () => suggestedName(queryClient, folder, pdfNameFor(first.name)),
        staleTime: 0,
    });
    const name = typed ?? suggested.data ?? pdfNameFor(first.name);
    const trimmed = name.trim();
    const problem = !trimmed
        ? 'Enter a name.'
        : trimmed.includes('/')
          ? 'A name can’t have a slash in it.'
          : '';
    const total = useMemo(
        () => order.reduce((sum, node) => sum + (nodeSize(node) || 0), 0),
        [order],
    );
    const stage = imagesPdfStage(order.length, total);

    function move(from: number, to: number) {
        if (to < 0 || to >= order.length || from === to) return;
        const next = [...order];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item!);
        setOrder(next);
        setAnnouncement(`${item!.name}, ${to + 1} of ${next.length}`);
    }

    function onDrop(event: DragEvent, to: number) {
        event.preventDefault();
        if (dragging !== null) move(dragging, to);
        setDragging(null);
    }

    return (
        <form
            className="contents"
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                if (problem || stage === 'ceiling') return;
                onMake({ images: order, size, margin: margin === '12mm', name: trimmed });
                onClose();
            }}
        >
            <DialogHeader>
                <DialogTitle>
                    One PDF from {order.length} {order.length === 1 ? 'image' : 'images'}
                </DialogTitle>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-5">
                <section
                    aria-labelledby={`${listId}-label`}
                    className="flex min-w-0 flex-col gap-2"
                >
                    <h3 id={`${listId}-label`} className="text-sm font-semibold">
                        Order
                    </h3>
                    <ol
                        className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2"
                        aria-labelledby={`${listId}-label`}
                    >
                        {order.map((node, index) => (
                            // Dragging is the pointer's way; each item's Move buttons are the keyboard's and a screen reader's.
                            // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                            <li
                                key={node.id}
                                draggable
                                onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = 'move';
                                    // Firefox starts no drag without some data.
                                    event.dataTransfer.setData('text/plain', node.id);
                                    setDragging(index);
                                }}
                                onDragEnd={() => setDragging(null)}
                                onDragOver={(event) => {
                                    if (dragging === null) return;
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = 'move';
                                }}
                                onDrop={(event) => onDrop(event, index)}
                                data-image-id={node.id}
                                className={cn(
                                    'group relative flex w-[104px] shrink-0 cursor-grab snap-start flex-col items-center gap-1.5 rounded-lg border border-edge bg-card p-2 select-none active:cursor-grabbing',
                                    dragging === index && 'opacity-50',
                                )}
                            >
                                <span className="absolute top-1.5 left-2 text-xs font-semibold text-muted-foreground tabular-nums">
                                    {index + 1}
                                </span>
                                <FileMark node={node} size="large" />
                                <span
                                    className="w-full truncate text-center text-xs"
                                    title={node.name}
                                >
                                    {node.name}
                                </span>
                                <span className="flex gap-0.5">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Move ${node.name} earlier`}
                                        disabled={index === 0}
                                        onClick={() => move(index, index - 1)}
                                    >
                                        <ChevronLeftIcon />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Move ${node.name} later`}
                                        disabled={index === order.length - 1}
                                        onClick={() => move(index, index + 1)}
                                    >
                                        <ChevronRightIcon />
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ol>
                    <p className="sr-only" aria-live="polite">
                        {announcement}
                    </p>
                </section>
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">Page size</h3>
                    <Segmented label="Page size" options={SIZES} value={size} onChange={setSize} />
                </div>
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">Margins</h3>
                    <Segmented
                        label="Margins"
                        options={MARGINS}
                        value={margin}
                        onChange={setMargin}
                    />
                </div>
                <DialogField
                    label="Name"
                    value={name}
                    onChange={(event) => setTyped(event.target.value)}
                    error={problem || undefined}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={255}
                />
                <p className="text-sm text-muted-foreground">
                    Location and camera details are left out.
                </p>
                {stage === 'offer' && (
                    <p className="text-sm">
                        These images are {formatBytes(total)}. Making the PDF uses a lot of memory
                        and may be slow on this device.
                    </p>
                )}
                {stage === 'ceiling' && (
                    <p className="text-sm text-destructive" role="alert">
                        These images are too many or too large for one PDF here: at most{' '}
                        {IMAGES_PDF_MAX_IMAGES} images and {formatBytes(IMAGES_PDF_MAX_BYTES)}.
                    </p>
                )}
            </div>
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                    {stage === 'ceiling' ? 'Close' : 'Cancel'}
                </Button>
                {stage !== 'ceiling' && (
                    <Button type="submit" disabled={Boolean(problem)}>
                        {stage === 'offer' ? 'Continue' : 'Make PDF'}
                    </Button>
                )}
            </DialogFooter>
        </form>
    );
}
