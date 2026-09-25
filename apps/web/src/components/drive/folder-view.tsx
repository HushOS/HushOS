import { CreateFolderDialog } from '@/components/drive/create-folder-dialog';
import { DetailsPanel } from '@/components/drive/details-panel';
import { useDrive } from '@/components/drive/drive-shell';
import { FileMark } from '@/components/drive/file-mark';
import { HotkeyHints } from '@/components/drive/hotkey-hints';
import { InfoDialog } from '@/components/drive/info-dialog';
import { MoveDialog } from '@/components/drive/move-dialog';
import { Preview } from '@/components/drive/preview';
import { RenameDialog } from '@/components/drive/rename-dialog';
import { ReportDialog } from '@/components/drive/report-dialog';
import { ShareDialog } from '@/components/drive/share-dialog';
import { TagDialog } from '@/components/drive/tag-dialog';
import { TagStamps } from '@/components/drive/tag-stamp';
import { keyLabel } from '@/components/drive/shortcuts';
import { UploadMenu, useDropZone, type UploadPicker } from '@/components/drive/upload-controls';
import { VersionsDialog } from '@/components/drive/versions-dialog';
import { Spinner } from '@/components/motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { downloadNodes } from '@/lib/downloads';
import {
    copyInto,
    driveClient,
    driveError,
    driveKeys,
    folderQueryOptions,
    formatBytes,
    formatWhen,
    invalidateFolders,
    nodeSize,
    sortNodesBy,
    DEFAULT_SORT,
    type SortKey,
    type SortOrder,
} from '@/lib/drive';
import { saveCopy } from '@/lib/save-copy';
import { cue } from '@/lib/sounds';
import { tagsQueryOptions } from '@/lib/tags';
import { tagsOf } from '@hushos/drive/client';
import { useThumbnail } from '@/lib/thumbnails';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
    draggable,
    dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { DriveNode, FolderListing } from '@hushos/drive/client';
import { useHotkey } from '@tanstack/react-hotkeys';
import { lendPaletteContext, usePaletteOpen } from '@/lib/palette';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import {
    CopyIcon,
    DownloadIcon,
    EllipsisIcon,
    FolderInputIcon,
    FolderPlusIcon,
    HistoryIcon,
    InfoIcon,
    LayoutGridIcon,
    ListIcon,
    PencilIcon,
    Share2Icon,
    SquareCheckIcon,
    SquareIcon,
    SquareMinusIcon,
    TagIcon,
    Trash2Icon,
    UploadIcon,
    XIcon,
    ArrowDownIcon,
    ArrowUpIcon,
} from 'lucide-react';
import {
    Fragment,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type MouseEvent,
} from 'react';

/*
 * One folder at a time: a path, the rows, and the actions. Selection follows
 * desktop conventions (click, Mod-click, Shift-click, arrows), a double click or
 * Enter opens, and every action is also a keyboard shortcut and a palette entry.
 */

function folderLink(rootId: string, folderId: string) {
    return folderId === rootId
        ? ({ to: '/app/drive' } as const)
        : ({ to: '/app/drive/f/$folderId', params: { folderId } } as const);
}

const VIEW_KEY = 'hushos.drive.view';

/* A tile's face: the file's thumbnail where one exists, its mark otherwise. */
function NodeFace({ node }: { node: DriveNode }) {
    const url = useThumbnail(node);
    if (url) return <img src={url} alt="" draggable={false} className="size-full object-cover" />;
    return <FileMark node={node} size="large" />;
}

/* Whether there is room for the details panel beside the list; below this it is a dialog. */
function useWideScreen() {
    return useSyncExternalStore(
        (onChange) => {
            const query = window.matchMedia('(min-width: 1024px)');
            query.addEventListener('change', onChange);
            return () => query.removeEventListener('change', onChange);
        },
        () => window.matchMedia('(min-width: 1024px)').matches,
        () => false,
    );
}

/*
 * The spot a row's mark occupies is also where it is ticked: on a phone that
 * is the one target that reliably adds or removes a row, where a tap elsewhere
 * on the row is easy to miss and a tap on the name opens it. The mark itself
 * never changes, the row's fill shows the selection; only the header, which
 * has no mark, draws a box. It is a checkbox in role and behaviour, and it stops the
 * tap from reaching the row underneath so a tap is exactly one toggle.
 */
function SelectMark({
    checked,
    indeterminate = false,
    selecting = true,
    face,
    name,
    className,
    onToggle,
    onPick,
}: {
    checked: boolean;
    /* Some but not all: the header's box while a selection is partial. */
    indeterminate?: boolean;
    /* Whether a selection exists: the box shows, and a click toggles; otherwise the face shows, and a click picks. */
    selecting?: boolean;
    /* What sits here while nothing is selected: the row's icon or thumbnail. */
    face?: React.ReactNode;
    name: string;
    className: string;
    onToggle: () => void;
    onPick?: (event: MouseEvent) => void;
}) {
    return (
        <span className={`flex items-center justify-center ${className}`}>
            {/*
             * The input covers the box and takes every click; the icon beneath is its
             * face. It stays the one element under the pointer whether a selection
             * exists or not, so the browser can see a double click, which the row
             * opens; the input itself acts only on a single click.
             */}
            <input
                type="checkbox"
                className="absolute inset-0 z-10 size-full cursor-default appearance-none opacity-0"
                checked={checked}
                ref={(input) => {
                    if (input) input.indeterminate = indeterminate;
                }}
                aria-label={`Select ${name}`}
                tabIndex={-1}
                onChange={() => {}}
                onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    if (event.detail > 1) return;
                    if (selecting || !onPick) onToggle();
                    else onPick(event);
                }}
            />
            {face ? (
                // The row's own fill says it is selected; its mark stays what it is.
                face
            ) : checked ? (
                <SquareCheckIcon aria-hidden="true" className="size-4 text-primary" />
            ) : indeterminate ? (
                <SquareMinusIcon aria-hidden="true" className="size-4 text-primary" />
            ) : (
                <SquareIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            )}
        </span>
    );
}

/*
 * The name itself is a link, so a modifier-click opens the folder or the
 * viewer in a new tab and a plain click opens it here without selecting the
 * row. Selection stays on the rest of the row.
 */
function NodeName({
    node,
    rootId,
    folderId,
    onOpen,
}: {
    node: DriveNode;
    rootId: string;
    folderId: string;
    onOpen: () => void;
}) {
    const target = node.kind === 'folder' ? node.id : folderId;
    const search = node.kind === 'folder' ? {} : { preview: node.id };
    const props = {
        draggable: false,
        className: `truncate hover:underline ${node.openError ? 'text-muted-foreground italic' : ''}`,
        onClick: (event: MouseEvent) => {
            event.stopPropagation();
            if (!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) onOpen();
        },
        onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
        children: node.name,
    };
    return target === rootId ? (
        <Link to="/app/drive" search={search} {...props} />
    ) : (
        <Link
            to="/app/drive/f/$folderId"
            params={{ folderId: target }}
            search={search}
            {...props}
        />
    );
}

/* Whether the primary pointer is a finger: taps then toggle selection instead of replacing it. */
export function useCoarsePointer() {
    return useSyncExternalStore(
        (onChange) => {
            const query = window.matchMedia('(pointer: coarse)');
            query.addEventListener('change', onChange);
            return () => query.removeEventListener('change', onChange);
        },
        () => window.matchMedia('(pointer: coarse)').matches,
        () => false,
    );
}

/* The store lost this file's bytes: the audit marked it, and the row says so instead of failing later. */
function unavailable(node: DriveNode) {
    return node.currentVersion?.objectStatus === 'missing';
}

/* The menu a row or tile opens; `targets` is the selection when the node is part of it. */
function NodeMenu({
    node,
    targets,
    onOpen,
    onDownload,
    onRename,
    onMove,
    onCopy,
    onVersions,
    onInfo,
    onTags,
    onShare,
    onSaveCopy,
    onReport,
    onTrash,
}: {
    node: DriveNode;
    targets: DriveNode[];
    onOpen: (node: DriveNode) => void;
    onDownload: (nodes: DriveNode[]) => void;
    onRename: (node: DriveNode) => void;
    onMove: (nodes: DriveNode[]) => void;
    onCopy: (nodes: DriveNode[]) => void;
    onVersions: (node: DriveNode) => void;
    onInfo: (node: DriveNode) => void;
    /* Absent for a node in someone else's workspace: tags are sealed with one's own registry. */
    onTags: ((nodes: DriveNode[]) => void) | null;
    /* Absent for a node in someone else's workspace: only its owner shares it. */
    onShare: ((node: DriveNode) => void) | null;
    /* Present only for a node in someone else's workspace: a re-encrypted copy into one's own. */
    onSaveCopy: ((nodes: DriveNode[]) => void) | null;
    /* Present only for someone else's node: the operators get its key, sealed here. */
    onReport: ((node: DriveNode) => void) | null;
    onTrash: (nodes: DriveNode[]) => void;
}) {
    return (
        <ContextMenuContent>
            <ContextMenuItem onClick={() => onOpen(node)}>
                {node.kind === 'folder' ? 'Open' : 'Preview'}
                <ContextMenuShortcut>{keyLabel('Enter')}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onDownload(targets)}>
                Download
                <ContextMenuShortcut>D</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRename(node)}>
                Rename
                <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onMove(targets)}>
                Move to…
                <ContextMenuShortcut>M</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCopy(targets)}>
                Copy to…
                <ContextMenuShortcut>C</ContextMenuShortcut>
            </ContextMenuItem>
            {node.kind === 'file' && (
                <ContextMenuItem onClick={() => onVersions(node)}>Versions…</ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => onInfo(node)}>
                Info…
                <ContextMenuShortcut>I</ContextMenuShortcut>
            </ContextMenuItem>
            {onTags && (
                <ContextMenuItem onClick={() => onTags(targets)}>
                    Tags…
                    <ContextMenuShortcut>T</ContextMenuShortcut>
                </ContextMenuItem>
            )}
            {onShare && <ContextMenuItem onClick={() => onShare(node)}>Share…</ContextMenuItem>}
            {onSaveCopy && (
                <ContextMenuItem onClick={() => onSaveCopy(targets)}>
                    Save a copy to my Drive
                </ContextMenuItem>
            )}
            {onReport && <ContextMenuItem onClick={() => onReport(node)}>Report…</ContextMenuItem>}
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => onTrash(targets)}>
                Move to trash
                <ContextMenuShortcut>{keyLabel('Backspace')}</ContextMenuShortcut>
            </ContextMenuItem>
        </ContextMenuContent>
    );
}

export function FolderView({ folderId }: { folderId: string }) {
    const { rootId, workspaceId } = useDrive();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const listing = useQuery(folderQueryOptions(folderId));
    const [order, setOrder] = useSortOrder();
    const rows = useMemo(
        () => (listing.data ? sortNodesBy(listing.data.children, order) : []),
        [listing.data, order],
    );
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [anchor, setAnchor] = useState<string | null>(null);
    const [focused, setFocused] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [renaming, setRenaming] = useState<DriveNode | null>(null);
    const [moving, setMoving] = useState<DriveNode[] | null>(null);
    const [copying, setCopying] = useState<DriveNode[] | null>(null);
    const [versionsOf, setVersionsOf] = useState<DriveNode | null>(null);
    // Details sit in a panel beside the list where there is room, and stay open as
    // the selection moves; on a narrow screen they are a dialog for one item.
    const [infoOf, setInfoOf] = useState<DriveNode | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const wide = useWideScreen();
    const [sharing, setSharing] = useState<DriveNode | null>(null);
    const [reporting, setReporting] = useState<DriveNode | null>(null);
    const [tagging, setTagging] = useState<DriveNode[] | null>(null);
    // Tag colours are this workspace's; a shared item's tags read by name alone.
    const registry = useQuery(tagsQueryOptions).data ?? null;
    const [trashing, setTrashing] = useState(false);
    const paletteOpen = usePaletteOpen();
    // The viewer's state lives in the URL: opening a file pushes an entry, the
    // arrows replace it, and closing goes back, so the browser's back button
    // dismisses the viewer and a preview can be opened in a new tab.
    const router = useRouter();
    const search = useSearch({ strict: false }) as { preview?: string };
    const pushedPreview = useRef(false);
    // On a touch screen there is no modifier key: every tap on a row toggles it,
    // and the name itself is the link that opens.
    const coarsePointer = useCoarsePointer();
    /* The folder row or breadcrumb a drag is hovering, for its highlight. */
    const [dropOver, setDropOver] = useState<string | null>(null);
    // List or grid, remembered on this device. The view only mounts after unlock,
    // on the client, so reading storage in the initializer is safe.
    const [view, setView] = useState<'list' | 'grid'>(() => {
        try {
            return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
        } catch {
            return 'list';
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(VIEW_KEY, view);
        } catch {
            /* Private mode or storage disabled: the choice lasts for the page. */
        }
    }, [view]);
    const [movingByDrag, setMovingByDrag] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const dropRef = useRef<HTMLDivElement>(null);
    const picker = useRef<UploadPicker>(null);
    const [marquee, setMarquee] = useState<{
        left: number;
        top: number;
        width: number;
        height: number;
    } | null>(null);

    // Rows that vanished (moved, trashed elsewhere) drop out here; the routes remount
    // this view per folder, so a new folder always starts with nothing selected.
    const selection = rows.filter((row) => selected.has(row.id));
    const previewing = useMemo(
        () =>
            search.preview
                ? (rows.find((row) => row.id === search.preview && row.kind === 'file') ?? null)
                : null,
        [rows, search.preview],
    );
    const dialogOpen =
        creating ||
        renaming !== null ||
        moving !== null ||
        copying !== null ||
        versionsOf !== null ||
        sharing !== null ||
        tagging !== null ||
        paletteOpen ||
        previewing !== null;
    const enabled = !dialogOpen;
    const here = folderLink(rootId, folderId);
    function showPreview(node: DriveNode | null, replace = false) {
        if (node) {
            if (!replace) pushedPreview.current = true;
            void navigate({ ...here, search: { preview: node.id }, replace });
        } else if (pushedPreview.current) {
            pushedPreview.current = false;
            router.history.back();
        } else void navigate({ ...here, search: {}, replace: true });
    }

    function select(
        node: DriveNode,
        event?: MouseEvent | { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
    ) {
        const toggle = coarsePointer || Boolean(event?.metaKey || event?.ctrlKey);
        const range = Boolean(event?.shiftKey) && anchor !== null;
        setFocused(node.id);
        if (range) {
            const from = rows.findIndex((row) => row.id === anchor);
            const to = rows.findIndex((row) => row.id === node.id);
            const [start, end] = from < to ? [from, to] : [to, from];
            setSelected(new Set(rows.slice(start, end + 1).map((row) => row.id)));
            return;
        }
        setAnchor(node.id);
        if (toggle)
            setSelected((current) => {
                const next = new Set(current);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
            });
        else setSelected(new Set([node.id]));
    }
    /* The checkbox's toggle: always additive, whatever the pointer or modifier. */
    function toggle(node: DriveNode) {
        setFocused(node.id);
        setAnchor(node.id);
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
        });
    }
    const selecting = selection.length > 0;
    const single = selection.length === 1 ? selection[0]! : null;
    const allSelected = rows.length > 0 && selection.length === rows.length;
    /* Tags need this workspace's registry, so only items of one's own can be tagged. */
    const ownSelection =
        selection.length > 0 && selection.every((node) => node.workspaceId === workspaceId);
    function showInfo(node: DriveNode) {
        if (wide) {
            setSelected(new Set([node.id]));
            setDetailsOpen(true);
        } else setInfoOf(node);
    }
    /* The Info button and its key: they open the details, and put an open panel away. */
    function toggleInfo() {
        if (wide && detailsOpen) setDetailsOpen(false);
        else if (selection.length === 1) showInfo(selection[0]!);
    }
    function open(node: DriveNode) {
        if (node.kind === 'folder') void navigate(folderLink(rootId, node.id));
        else showPreview(node);
    }
    /* A re-encrypted copy of something shared with this person, into the top of their own Drive. */
    async function saveToMyDrive(nodes: DriveNode[]) {
        if (!nodes.length) return;
        try {
            const root = (await queryClient.fetchQuery(folderQueryOptions(rootId))).folder;
            const made = await saveCopy(queryClient, nodes, root);
            cue('droplet');
            toast.add({
                type: 'success',
                title:
                    made === 1 && nodes[0]!.kind === 'file'
                        ? `“${nodes[0]!.name}” is being saved to your Drive`
                        : `${made} items are being saved to your Drive`,
                description: 'Encrypted again under your own keys as they upload.',
            });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not save', description: driveError(error) });
        }
    }
    function download(nodes: DriveNode[]) {
        if (!nodes.length) return;
        const here = listing.data?.folder;
        downloadNodes(nodes, here?.parentId === null ? undefined : here?.name);
    }
    async function trash(nodes: DriveNode[]) {
        if (!nodes.length || trashing) return;
        setTrashing(true);
        let done = 0;
        try {
            for (const node of nodes) {
                await driveClient.trash(node);
                done++;
            }
            cue('droplet');
            toast.add({
                type: 'success',
                title:
                    done === 1
                        ? `“${nodes[0]!.name}” moved to trash`
                        : `${done} items moved to trash`,
                description: 'Restore from the trash within 30 days.',
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not move to trash',
                description: driveError(error),
            });
        } finally {
            setTrashing(false);
            await invalidateFolders(queryClient, folderId);
        }
    }
    /* Arrows move the one selected row; with Shift they stretch the selection from where it began, as a file manager does. */
    function moveFocus(delta: number, extend = false) {
        if (!rows.length) return;
        const index = focused ? rows.findIndex((row) => row.id === focused) : -1;
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]!;
        select(next, extend ? { shiftKey: true } : undefined);
        listRef.current
            ?.querySelector<HTMLElement>(`[data-node-id="${next.id}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }

    // Desktop selection: a click on empty space clears, a drag on empty space draws a
    // rectangle and selects what it touches (with Mod or Shift adding to what was there).
    const latest = useRef({ rows, selected, select });
    useEffect(() => {
        latest.current = { rows, selected, select };
    });
    useEffect(() => {
        const root = dropRef.current;
        if (!root) return;
        let start: {
            x: number;
            y: number;
            additive: boolean;
            base: Set<string>;
            row: string | null;
            /* The second press of a double click: it opens, it never lets go. */
            second: boolean;
            modifiers: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };
        } | null = null;
        let dragging = false;
        let lastClick: { row: string; at: number } | null = null;
        const DOUBLE_CLICK_MS = 400;
        // What was selected before the first press of what may become a double click,
        // so a double click opens and leaves the selection as it found it.
        let beforeDouble: Set<string> | null = null;
        let lastDown: { row: string | null; at: number } | null = null;
        const onDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            const target = event.target as HTMLElement;
            const pressed = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
            const repeat =
                lastDown !== null &&
                lastDown.row === pressed &&
                event.timeStamp - lastDown.at < 700;
            if (!repeat) beforeDouble = new Set(latest.current.selected);
            lastDown = { row: pressed, at: event.timeStamp };
            if (
                target.closest(
                    'button, a, input, summary, thead, [role=menu], [role=dialog], [data-selection-bar], [data-details], section[aria-label=Transfers]',
                )
            )
                return;
            const row = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
            start = {
                x: event.clientX,
                y: event.clientY,
                additive: event.metaKey || event.ctrlKey || event.shiftKey,
                base: new Set(latest.current.selected),
                row,
                second:
                    row !== null &&
                    lastClick?.row === row &&
                    event.timeStamp - lastClick.at < DOUBLE_CLICK_MS,
                modifiers: {
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                },
            };
            dragging = false;
        };
        const onMove = (event: PointerEvent) => {
            if (!start || start.row) return;
            if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4)
                return;
            dragging = true;
            const bounds = root.getBoundingClientRect();
            const left = Math.min(start.x, event.clientX);
            const top = Math.min(start.y, event.clientY);
            const right = Math.max(start.x, event.clientX);
            const bottom = Math.max(start.y, event.clientY);
            setMarquee({
                left: left - bounds.left,
                top: top - bounds.top + root.scrollTop,
                width: right - left,
                height: bottom - top,
            });
            const hit = new Set(start.additive ? start.base : []);
            for (const row of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
                const rect = row.getBoundingClientRect();
                const inside =
                    rect.left < right &&
                    rect.right > left &&
                    rect.top < bottom &&
                    rect.bottom > top;
                if (inside) hit.add(row.dataset.nodeId!);
            }
            setSelected(hit);
            event.preventDefault();
        };
        const onUp = (event: PointerEvent) => {
            if (!start) return;
            if (!dragging && event.type !== 'pointercancel') {
                const node = start.row
                    ? latest.current.rows.find((row) => row.id === start!.row)
                    : undefined;
                const { metaKey, ctrlKey, shiftKey } = start.modifiers;
                const plain = !metaKey && !ctrlKey && !shiftKey;
                // The name is a button with its own click; this is the blank part of a row.
                // A plain click there on the one selected row lets go of it at once, since
                // the eye reads that area as empty space and expects a second click to
                // undo; a double click puts the selection back as it found it and opens.
                const letGo =
                    node !== undefined &&
                    plain &&
                    !start.second &&
                    latest.current.selected.size === 1 &&
                    latest.current.selected.has(node.id);
                lastClick = node && plain ? { row: node.id, at: event.timeStamp } : null;
                if (letGo) {
                    setSelected(new Set());
                    setFocused(null);
                } else if (node) latest.current.select(node, start.modifiers);
                else {
                    setSelected(new Set());
                    setFocused(null);
                }
            }
            start = null;
            dragging = false;
            setMarquee(null);
        };
        // The browser decides what a double click is, on the system's own interval:
        // when it says so, the selection goes back to what the first press found.
        const onDouble = () => {
            if (beforeDouble) {
                setSelected(beforeDouble);
                setFocused(null);
            }
        };
        root.addEventListener('pointerdown', onDown);
        root.addEventListener('dblclick', onDouble);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('dblclick', onDouble);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, []);

    useHotkey('Shift+N', () => setCreating(true), { enabled });
    useHotkey('F2', () => selection.length === 1 && setRenaming(selection[0]!), { enabled });
    useHotkey('M', () => selection.length > 0 && setMoving(selection), { enabled });
    useHotkey('C', () => selection.length > 0 && setCopying(selection), { enabled });
    useHotkey('D', () => download(selection), { enabled });
    useHotkey('I', toggleInfo, { enabled });
    useHotkey('T', () => ownSelection && setTagging(selection), { enabled });
    useHotkey('Backspace', () => void trash(selection), { enabled });
    useHotkey('Delete', () => void trash(selection), { enabled });
    // Enter on a focused link or button in the view is that control's, not the selection's.
    useHotkey(
        'Enter',
        (event) => {
            if (event.target instanceof Element && event.target.closest('a, button')) return;
            if (selection.length === 1) open(selection[0]!);
        },
        { enabled, preventDefault: false },
    );
    useHotkey('ArrowDown', () => moveFocus(1), { enabled });
    useHotkey('ArrowUp', () => moveFocus(-1), { enabled });
    useHotkey('Shift+ArrowDown', () => moveFocus(1, true), { enabled });
    useHotkey('Shift+ArrowUp', () => moveFocus(-1, true), { enabled });
    // Never inside a text field, where Mod+A means the text.
    useHotkey('Mod+A', () => setSelected(new Set(rows.map((row) => row.id))), {
        enabled,
        ignoreInputs: true,
    });
    useHotkey(
        'Escape',
        () => {
            setSelected(new Set());
            setFocused(null);
        },
        { enabled },
    );

    const folder = listing.data?.folder;
    // While a folder loads for the first time, its path is already known from the
    // listing it was opened from, so the breadcrumb never blanks on the way in.
    const knownPath = useMemo(() => {
        if (listing.data) return null;
        for (const [, cached] of queryClient.getQueriesData<FolderListing>({
            queryKey: [...driveKeys.all, 'folder'],
        })) {
            const child = cached?.children.find((node) => node.id === folderId);
            if (cached && child) return [...cached.ancestors, cached.folder, child];
        }
        return null;
    }, [listing.data, queryClient, folderId]);
    const crumbs = useMemo(
        () => (listing.data ? [...listing.data.ancestors, listing.data.folder] : (knownPath ?? [])),
        [listing.data, knownPath],
    );
    // The whole view takes drops, not only the list: an empty folder has no list.
    const over = useDropZone(dropRef, folder, rows);
    const paletteHandlers = useRef({ download, trash });
    useEffect(() => {
        paletteHandlers.current = { download, trash };
    });
    // The command center, mounted at the app's root, shows this folder's actions while it is on screen.
    useEffect(() => {
        lendPaletteContext({
            folders: rows.filter((row) => row.kind === 'folder'),
            parentId: folder?.parentId ?? null,
            selection,
            rows: rows.length,
            view,
            setView,
            selectAll: () => setSelected(new Set(rows.map((row) => row.id))),
            clearSelection: () => setSelected(new Set()),
            actions: {
                newFolder: () => setCreating(true),
                upload: () => picker.current?.pickFiles(),
                rename: () => selection.length === 1 && setRenaming(selection[0]!),
                move: () => selection.length > 0 && setMoving(selection),
                copy: () => selection.length > 0 && setCopying(selection),
                versions: () =>
                    selection.length === 1 &&
                    selection[0]!.kind === 'file' &&
                    setVersionsOf(selection[0]!),
                share: () =>
                    selection.length === 1 &&
                    selection[0]!.workspaceId === workspaceId &&
                    setSharing(selection[0]!),
                tags: () => ownSelection && setTagging(selection),
                download: () => paletteHandlers.current.download(selection),
                trash: () => void paletteHandlers.current.trash(selection),
            },
        });
    }, [rows, folder, selection, ownSelection, view, workspaceId]);
    useEffect(() => () => lendPaletteContext(null), []);

    /* Moves dragged rows into a folder row or a breadcrumb ancestor; with Alt held, copies them. */
    async function moveTo(ids: string[], destination: DriveNode, copy = false) {
        const nodes = latest.current.rows.filter(
            (row) => ids.includes(row.id) && row.id !== destination.id,
        );
        if (!nodes.length || movingByDrag) return;
        setMovingByDrag(true);
        const where = destination.parentId === null ? 'the top folder' : `“${destination.name}”`;
        let moved = 0;
        try {
            if (copy) {
                moved = await copyInto(queryClient, nodes, destination);
                cue('droplet');
                toast.add({
                    type: 'success',
                    title:
                        nodes.length === 1 && nodes[0]!.kind === 'file'
                            ? `“${nodes[0]!.name}” copied to ${where}`
                            : `${moved} items copied to ${where}`,
                });
                return;
            }
            for (const node of nodes) {
                await driveClient.move(node, destination);
                moved++;
            }
            cue('droplet');
            toast.add({
                type: 'success',
                title:
                    moved === 1
                        ? `“${nodes[0]!.name}” moved to ${where}`
                        : `${moved} items moved to ${where}`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: copy ? 'Could not copy' : 'Could not move',
                description: driveError(error),
            });
        } finally {
            setMovingByDrag(false);
            await invalidateFolders(queryClient, folderId, destination.id);
        }
    }
    /*
     * A folder in the path, dragged onto a crumb further up: the folder moves there,
     * with everything in it. The page stays where it is, since a folder's address is
     * its id, and the path redraws around it.
     */
    async function moveCrumb(id: string, destination: DriveNode) {
        const node = crumbs.find((crumb) => crumb.id === id);
        if (!node || movingByDrag) return;
        setMovingByDrag(true);
        const where = destination.parentId === null ? 'the top folder' : `“${destination.name}”`;
        try {
            await driveClient.move(node, destination);
            cue('droplet');
            toast.add({ type: 'success', title: `“${node.name}” moved to ${where}` });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not move', description: driveError(error) });
        } finally {
            setMovingByDrag(false);
            await invalidateFolders(queryClient, folderId, node.parentId, destination.id);
        }
    }
    // Rows drag as themselves, or as the whole selection when they are part of it.
    // Folder rows and breadcrumb ancestors take the drop; the current folder does not.
    const moveToRef = useRef(moveTo);
    const moveCrumbRef = useRef(moveCrumb);
    useEffect(() => {
        moveToRef.current = moveTo;
        moveCrumbRef.current = moveCrumb;
    });
    useEffect(() => {
        const root = dropRef.current;
        if (!root) return;
        const cleanups: (() => void)[] = [];
        const dragged = (id: string) =>
            latest.current.selected.has(id) ? [...latest.current.selected] : [id];
        const target = (element: HTMLElement, destination: DriveNode) =>
            dropTargetForElements({
                element,
                canDrop: ({ source }) => {
                    if (source.data.type === 'drive-crumb') {
                        // Only upward, and past its own parent: anything else is where it already is, or inside itself.
                        const from = crumbs.findIndex((crumb) => crumb.id === source.data.id);
                        const to = crumbs.findIndex((crumb) => crumb.id === destination.id);
                        return to >= 0 && from > 0 && to < from - 1;
                    }
                    return (
                        source.data.type === 'drive-nodes' &&
                        !(source.data.ids as string[]).includes(destination.id)
                    );
                },
                onDragEnter: () => setDropOver(destination.id),
                onDragLeave: () => setDropOver(null),
                onDrop: ({ source, location }) => {
                    setDropOver(null);
                    if (source.data.type === 'drive-crumb') {
                        void moveCrumbRef.current(source.data.id as string, destination);
                        return;
                    }
                    void moveToRef.current(
                        source.data.ids as string[],
                        destination,
                        location.current.input.altKey,
                    );
                },
            });
        for (const element of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
            const id = element.dataset.nodeId!;
            const node = rows.find((row) => row.id === id);
            if (!node) continue;
            cleanups.push(
                draggable({
                    element,
                    getInitialData: () => ({ type: 'drive-nodes', ids: dragged(id) }),
                    onDragStart: () => {
                        if (!latest.current.selected.has(id)) latest.current.select(node);
                    },
                }),
            );
            if (node.kind === 'folder') cleanups.push(target(element, node));
        }
        for (const element of root.querySelectorAll<HTMLElement>('[data-crumb-id]')) {
            const crumb = crumbs.find((entry) => entry.id === element.dataset.crumbId);
            if (crumb) cleanups.push(target(element, crumb));
        }
        // Every folder in the path but the top one can be picked up, the open folder included.
        for (const element of root.querySelectorAll<HTMLElement>('[data-crumb-drag]')) {
            const id = element.dataset.crumbDrag!;
            cleanups.push(
                draggable({ element, getInitialData: () => ({ type: 'drive-crumb', id }) }),
            );
        }
        return combine(...cleanups);
    }, [rows, crumbs]);

    return (
        <div
            ref={dropRef}
            className={`relative flex min-h-0 flex-1 flex-col ${marquee ? 'select-none' : ''}`}
        >
            {marquee && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute z-10 rounded-xs border border-primary bg-primary/10"
                    style={marquee}
                />
            )}
            {over && folder && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xs border-2 border-dashed border-primary bg-card/80"
                >
                    <p className="rounded-xs bg-popover px-4 py-3 text-sm font-medium shadow-overlay">
                        {folder.parentId === null
                            ? 'Drop to upload here'
                            : `Drop to upload into “${folder.name}”`}
                    </p>
                </div>
            )}
            <div className="flex flex-col gap-2 border-b border-rule px-5 pt-4 pb-2 sm:px-8">
                {/* Where you are, and what you can add here: both stay put whatever is selected. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="mr-auto min-w-0">
                        <Breadcrumb>
                            <BreadcrumbList className="text-lg">
                                {crumbs.length === 0 && <BreadcrumbPage>…</BreadcrumbPage>}
                                {crumbs.length > 0 && crumbs[0]!.workspaceId !== workspaceId && (
                                    <>
                                        <BreadcrumbItem>
                                            <BreadcrumbLink render={<Link to="/app/shared" />}>
                                                Shared with me
                                            </BreadcrumbLink>
                                        </BreadcrumbItem>
                                        <BreadcrumbSeparator />
                                    </>
                                )}
                                {crumbs.map((crumb, index) => (
                                    <Fragment key={crumb.id}>
                                        {index > 0 && <BreadcrumbSeparator />}
                                        <BreadcrumbItem>
                                            {index === crumbs.length - 1 ? (
                                                <BreadcrumbPage
                                                    className="font-bold tracking-tight"
                                                    data-crumb-drag={
                                                        index > 0 &&
                                                        crumb.workspaceId === workspaceId
                                                            ? crumb.id
                                                            : undefined
                                                    }
                                                >
                                                    {crumb.name}
                                                </BreadcrumbPage>
                                            ) : (
                                                <BreadcrumbLink
                                                    render={
                                                        <Link
                                                            {...folderLink(rootId, crumb.id)}
                                                            data-crumb-id={crumb.id}
                                                            data-crumb-drag={
                                                                index > 0 &&
                                                                crumb.workspaceId === workspaceId
                                                                    ? crumb.id
                                                                    : undefined
                                                            }
                                                            className={
                                                                dropOver === crumb.id
                                                                    ? 'rounded-xs bg-accent text-accent-foreground ring-2 ring-primary ring-offset-2 ring-offset-card'
                                                                    : undefined
                                                            }
                                                        />
                                                    }
                                                >
                                                    {crumb.name}
                                                </BreadcrumbLink>
                                            )}
                                        </BreadcrumbItem>
                                    </Fragment>
                                ))}
                            </BreadcrumbList>
                        </Breadcrumb>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="icon-sm"
                            aria-label={view === 'grid' ? 'Show as list' : 'Show as grid'}
                            title={view === 'grid' ? 'Show as list' : 'Show as grid'}
                            onClick={() =>
                                setView((current) => (current === 'grid' ? 'list' : 'grid'))
                            }
                        >
                            {view === 'grid' ? <ListIcon /> : <LayoutGridIcon />}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCreating(true)}
                            disabled={!folder}
                        >
                            <FolderPlusIcon />
                            New folder
                        </Button>
                        {folder && <UploadMenu folder={folder} known={rows} handle={picker} />}
                    </div>
                </div>
                {/* One line, one height: the folder's controls, or the selection's actions in their place. */}
                {selecting && (
                    <div
                        role="toolbar"
                        aria-label="Selection"
                        data-selection-bar=""
                        className="-mx-2 flex h-11 items-center gap-0.5 rounded-md bg-accent px-2 text-accent-foreground sm:gap-1"
                    >
                        <span className="mr-1 shrink-0 pl-1 text-sm font-medium tabular-nums sm:mr-2">
                            {selection.length} selected
                        </span>
                        {view === 'grid' && !allSelected && (
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label="Select all"
                                onClick={() => setSelected(new Set(rows.map((row) => row.id)))}
                            >
                                <SquareCheckIcon />
                                <span className="max-sm:sr-only">Select all</span>
                            </Button>
                        )}
                        {single && ownSelection && (
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label="Share"
                                className="max-sm:hidden"
                                onClick={() => setSharing(single)}
                            >
                                <Share2Icon />
                                <span>Share</span>
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label="Download"
                            onClick={() => download(selection)}
                        >
                            <DownloadIcon />
                            <span className="max-sm:sr-only">Download</span>
                        </Button>
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label="Move"
                            onClick={() => setMoving(selection)}
                        >
                            <FolderInputIcon />
                            <span className="max-sm:sr-only">Move</span>
                        </Button>
                        {single && (
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label="Rename"
                                onClick={() => setRenaming(single)}
                            >
                                <PencilIcon />
                                <span className="max-sm:sr-only">Rename</span>
                            </Button>
                        )}
                        {single && (
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label="Info"
                                aria-pressed={wide ? detailsOpen : undefined}
                                className="max-sm:hidden"
                                onClick={toggleInfo}
                            >
                                <InfoIcon />
                                <span>Info</span>
                            </Button>
                        )}
                        {ownSelection && (
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label="Tags"
                                className="max-sm:hidden"
                                onClick={() => setTagging(selection)}
                            >
                                <TagIcon />
                                <span>Tags</span>
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label="Trash"
                            disabled={trashing}
                            onClick={() => void trash(selection)}
                        >
                            <Trash2Icon />
                            <span className="max-sm:sr-only">Trash</span>
                        </Button>
                        {/* The less common actions, and on a phone every action the line has no room for. */}
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button variant="ghost" size="xs" aria-label="More actions" />
                                }
                            >
                                <EllipsisIcon />
                                <span className="max-sm:sr-only">More</span>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" sideOffset={6}>
                                {single && ownSelection && (
                                    <DropdownMenuItem
                                        className="sm:hidden"
                                        onClick={() => setSharing(single)}
                                    >
                                        <Share2Icon aria-hidden="true" /> Share…
                                    </DropdownMenuItem>
                                )}
                                {single?.kind === 'file' && (
                                    <DropdownMenuItem onClick={() => setVersionsOf(single)}>
                                        <HistoryIcon aria-hidden="true" /> Versions…
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={() => setCopying(selection)}>
                                    <CopyIcon aria-hidden="true" /> Copy to…
                                </DropdownMenuItem>
                                {single && (
                                    <DropdownMenuItem className="sm:hidden" onClick={toggleInfo}>
                                        <InfoIcon aria-hidden="true" /> Info…
                                    </DropdownMenuItem>
                                )}
                                {ownSelection && (
                                    <DropdownMenuItem
                                        className="sm:hidden"
                                        onClick={() => setTagging(selection)}
                                    >
                                        <TagIcon aria-hidden="true" /> Tags…
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <span className="flex-1" />
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Clear selection"
                            onClick={() => {
                                setSelected(new Set());
                                setFocused(null);
                            }}
                        >
                            <XIcon />
                        </Button>
                    </div>
                )}
                <div className={`h-11 items-center gap-2 ${selecting ? 'hidden' : 'flex'}`}>
                    <p className="mr-auto text-sm whitespace-nowrap text-muted-foreground tabular-nums">
                        {listing.data
                            ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`
                            : ''}
                    </p>
                    {view === 'grid' && rows.length > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="-mr-2 text-muted-foreground"
                            onClick={() => setSelected(new Set(rows.map((row) => row.id)))}
                        >
                            Select all
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex min-h-0 flex-1">
                {/* The space itself has a menu too: what you can do here, without a selection. */}
                <ContextMenu>
                    <ContextMenuTrigger
                        render={<div />}
                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                    >
                        {listing.isPending && (
                            <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
                                <Spinner />
                            </div>
                        )}
                        {listing.isError && (
                            <div className="px-5 py-6 sm:px-8">
                                <Alert variant="destructive" className="max-w-xl">
                                    <AlertTitle>This folder could not be opened</AlertTitle>
                                    <AlertDescription>{driveError(listing.error)}</AlertDescription>
                                </Alert>
                            </div>
                        )}
                        {listing.data && rows.length === 0 && (
                            <div className="px-5 py-6 sm:px-8">
                                <div className="flex flex-col items-center gap-4 rounded-md border border-dashed border-input px-6 py-12 text-center">
                                    <div className="max-w-sm">
                                        <h2 className="text-lg font-bold">Nothing here yet</h2>
                                        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                            Drop files or folders anywhere on this page. Everything
                                            is encrypted on this device before it leaves.
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap items-center justify-center gap-2">
                                        <Button
                                            size="sm"
                                            onClick={() => picker.current?.pickFiles()}
                                        >
                                            <UploadIcon />
                                            Upload files
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setCreating(true)}
                                        >
                                            <FolderPlusIcon />
                                            New folder
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {listing.data && rows.length > 0 && view === 'list' && (
                            <div ref={listRef} className="flex flex-col">
                                <table
                                    aria-label={`Contents of ${folder?.name ?? 'folder'}`}
                                    aria-multiselectable="true"
                                    className="w-full table-fixed border-collapse"
                                >
                                    <thead>
                                        <tr className="border-b border-rule">
                                            <th
                                                scope="col"
                                                aria-sort={ariaSort(order, 'name')}
                                                className="eyebrow py-2.5 pl-5 text-left text-muted-foreground sm:pl-8"
                                            >
                                                <span className="flex items-center gap-3">
                                                    {rows.length > 0 && (
                                                        <SelectMark
                                                            checked={allSelected}
                                                            indeterminate={
                                                                selecting && !allSelected
                                                            }
                                                            name={allSelected ? 'none' : 'all'}
                                                            className="relative h-[30px] w-[30px] shrink-0"
                                                            onToggle={() =>
                                                                setSelected(
                                                                    allSelected
                                                                        ? new Set()
                                                                        : new Set(
                                                                              rows.map(
                                                                                  (row) => row.id,
                                                                              ),
                                                                          ),
                                                                )
                                                            }
                                                        />
                                                    )}
                                                    <SortHeader
                                                        label="Name"
                                                        sortKey="name"
                                                        order={order}
                                                        onOrder={setOrder}
                                                    />
                                                </span>
                                            </th>
                                            <th
                                                scope="col"
                                                aria-sort={ariaSort(order, 'modified')}
                                                className="eyebrow hidden w-40 py-2.5 text-left text-muted-foreground sm:table-cell"
                                            >
                                                <SortHeader
                                                    label="Modified"
                                                    sortKey="modified"
                                                    order={order}
                                                    onOrder={setOrder}
                                                />
                                            </th>
                                            <th
                                                scope="col"
                                                aria-sort={ariaSort(order, 'size')}
                                                className="eyebrow w-28 py-2.5 pr-5 text-right text-muted-foreground sm:pr-8"
                                            >
                                                <SortHeader
                                                    label="Size"
                                                    sortKey="size"
                                                    order={order}
                                                    onOrder={setOrder}
                                                    align="end"
                                                />
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((node) => {
                                            const isSelected = selected.has(node.id);
                                            const size = nodeSize(node);
                                            return (
                                                <ContextMenu key={node.id}>
                                                    <ContextMenuTrigger
                                                        render={
                                                            <tr
                                                                aria-selected={isSelected}
                                                                data-node-id={node.id}
                                                                onDoubleClick={() => open(node)}
                                                                onContextMenu={(event) => {
                                                                    event.stopPropagation();
                                                                    if (!isSelected) select(node);
                                                                }}
                                                            />
                                                        }
                                                        className={`h-[46px] cursor-default border-b border-rule select-none ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'} ${focused === node.id && !isSelected ? 'ring-1 ring-ring ring-inset' : ''} ${dropOver === node.id ? 'bg-primary/15 ring-2 ring-primary ring-inset' : ''}`}
                                                    >
                                                        <td className="min-w-0 p-0">
                                                            {/* Only as wide as the name: the blank rest of the cell is row, where a second click lets go. */}
                                                            <span className="inline-flex max-w-full min-w-0 items-center">
                                                                <button
                                                                    type="button"
                                                                    className="inline-flex max-w-full min-w-0 items-center gap-3 py-2 pl-5 text-left text-sm font-medium outline-none sm:pl-8"
                                                                    onClick={(event) =>
                                                                        select(node, event)
                                                                    }
                                                                >
                                                                    <SelectMark
                                                                        checked={isSelected}
                                                                        selecting={selecting}
                                                                        name={node.name}
                                                                        className="relative h-[30px] w-[30px] shrink-0"
                                                                        face={
                                                                            <FileMark node={node} />
                                                                        }
                                                                        onToggle={() =>
                                                                            toggle(node)
                                                                        }
                                                                        onPick={(event) =>
                                                                            select(node, event)
                                                                        }
                                                                    />
                                                                    <NodeName
                                                                        node={node}
                                                                        rootId={rootId}
                                                                        folderId={folderId}
                                                                        onOpen={() => {
                                                                            if (
                                                                                node.kind === 'file'
                                                                            )
                                                                                pushedPreview.current = true;
                                                                        }}
                                                                    />
                                                                </button>
                                                                <TagStamps
                                                                    tagIds={
                                                                        registry
                                                                            ? tagsOf(
                                                                                  registry,
                                                                                  node.id,
                                                                              )
                                                                            : []
                                                                    }
                                                                    registry={registry}
                                                                    itemName={node.name}
                                                                    onEdit={
                                                                        node.workspaceId ===
                                                                        workspaceId
                                                                            ? () =>
                                                                                  setTagging([node])
                                                                            : undefined
                                                                    }
                                                                    max={2}
                                                                    className="ml-4"
                                                                />
                                                            </span>
                                                        </td>
                                                        <td className="hidden py-2 text-sm text-muted-foreground tabular-nums sm:table-cell">
                                                            {formatWhen(
                                                                node.metadata?.modified ??
                                                                    node.updatedAt,
                                                            )}
                                                        </td>
                                                        <td className="py-2 pr-5 text-right text-sm text-muted-foreground tabular-nums sm:pr-8">
                                                            {node.kind === 'folder'
                                                                ? '-'
                                                                : unavailable(node)
                                                                  ? 'Unavailable'
                                                                  : formatBytes(size)}
                                                        </td>
                                                    </ContextMenuTrigger>
                                                    <NodeMenu
                                                        node={node}
                                                        targets={
                                                            isSelected && selection.length > 1
                                                                ? selection
                                                                : [node]
                                                        }
                                                        onOpen={open}
                                                        onDownload={download}
                                                        onRename={setRenaming}
                                                        onMove={setMoving}
                                                        onCopy={setCopying}
                                                        onVersions={setVersionsOf}
                                                        onInfo={showInfo}
                                                        onTags={
                                                            node.workspaceId === workspaceId
                                                                ? (nodes) => setTagging(nodes)
                                                                : null
                                                        }
                                                        onShare={
                                                            node.workspaceId === workspaceId
                                                                ? setSharing
                                                                : null
                                                        }
                                                        onSaveCopy={
                                                            node.workspaceId === workspaceId
                                                                ? null
                                                                : (nodes) =>
                                                                      void saveToMyDrive(nodes)
                                                        }
                                                        onReport={
                                                            node.workspaceId === workspaceId
                                                                ? null
                                                                : setReporting
                                                        }
                                                        onTrash={(nodes) => void trash(nodes)}
                                                    />
                                                </ContextMenu>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {listing.data && rows.length > 0 && view === 'grid' && (
                            <div ref={listRef} className="flex flex-col">
                                <div
                                    aria-label={`Contents of ${folder?.name ?? 'folder'}`}
                                    className="grid grid-cols-2 gap-2 px-3.5 py-4 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:px-6.5"
                                >
                                    {rows.map((node) => {
                                        const isSelected = selected.has(node.id);
                                        const size = nodeSize(node);
                                        return (
                                            <ContextMenu key={node.id}>
                                                <ContextMenuTrigger
                                                    render={
                                                        <div
                                                            data-node-id={node.id}
                                                            data-selected={isSelected || undefined}
                                                            onContextMenu={(event) => {
                                                                event.stopPropagation();
                                                                if (!isSelected) select(node);
                                                            }}
                                                        />
                                                    }
                                                    className={`flex cursor-default flex-col rounded-md p-1.5 select-none ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'} ${focused === node.id && !isSelected ? 'ring-1 ring-ring' : ''} ${dropOver === node.id ? 'bg-primary/15 ring-2 ring-primary' : ''}`}
                                                >
                                                    <button
                                                        type="button"
                                                        aria-label={node.name}
                                                        aria-pressed={isSelected}
                                                        className="flex w-full min-w-0 flex-col text-left outline-none"
                                                        onClick={(event) => select(node, event)}
                                                        onDoubleClick={() => open(node)}
                                                    >
                                                        <div className="relative flex aspect-4/3 w-full items-center justify-center overflow-hidden rounded-xs">
                                                            <NodeFace node={node} />
                                                            {selecting && (
                                                                <SelectMark
                                                                    checked={isSelected}
                                                                    name={node.name}
                                                                    className="absolute top-1.5 left-1.5 size-8 rounded-xs bg-popover shadow-overlay"
                                                                    onToggle={() => toggle(node)}
                                                                />
                                                            )}
                                                        </div>
                                                        <div className="min-w-0 px-1 pt-2 pb-1">
                                                            <p className="truncate text-sm font-medium">
                                                                <NodeName
                                                                    node={node}
                                                                    rootId={rootId}
                                                                    folderId={folderId}
                                                                    onOpen={() => {
                                                                        if (node.kind === 'file')
                                                                            pushedPreview.current = true;
                                                                    }}
                                                                />
                                                            </p>
                                                            <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
                                                                {node.kind === 'folder'
                                                                    ? 'Folder'
                                                                    : unavailable(node)
                                                                      ? 'Unavailable'
                                                                      : formatBytes(size)}
                                                            </p>
                                                        </div>
                                                    </button>
                                                </ContextMenuTrigger>
                                                <NodeMenu
                                                    node={node}
                                                    targets={
                                                        isSelected && selection.length > 1
                                                            ? selection
                                                            : [node]
                                                    }
                                                    onOpen={open}
                                                    onDownload={download}
                                                    onRename={setRenaming}
                                                    onMove={setMoving}
                                                    onCopy={setCopying}
                                                    onVersions={setVersionsOf}
                                                    onInfo={showInfo}
                                                    onTags={
                                                        node.workspaceId === workspaceId
                                                            ? (nodes) => setTagging(nodes)
                                                            : null
                                                    }
                                                    onShare={
                                                        node.workspaceId === workspaceId
                                                            ? setSharing
                                                            : null
                                                    }
                                                    onSaveCopy={
                                                        node.workspaceId === workspaceId
                                                            ? null
                                                            : (nodes) => void saveToMyDrive(nodes)
                                                    }
                                                    onReport={
                                                        node.workspaceId === workspaceId
                                                            ? null
                                                            : setReporting
                                                    }
                                                    onTrash={(nodes) => void trash(nodes)}
                                                />
                                            </ContextMenu>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem onClick={() => setCreating(true)}>
                            New folder
                            <ContextMenuShortcut>{keyLabel('Shift')}N</ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => picker.current?.pickFiles()}>
                            Upload files
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => picker.current?.pickFolder()}>
                            Upload folder
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            disabled={!rows.length}
                            onClick={() => setSelected(new Set(rows.map((row) => row.id)))}
                        >
                            Select all
                            <ContextMenuShortcut>{keyLabel('Mod')}A</ContextMenuShortcut>
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
                {wide && detailsOpen && (
                    <DetailsPanel
                        node={single}
                        location={crumbs.map((crumb) => crumb.name).join(' / ')}
                        onTags={
                            single?.workspaceId === workspaceId
                                ? (node) => setTagging([node])
                                : undefined
                        }
                        onShare={single?.workspaceId === workspaceId ? setSharing : undefined}
                        onClose={() => setDetailsOpen(false)}
                    />
                )}
            </div>

            {folder && (
                <CreateFolderDialog parent={folder} open={creating} onOpenChange={setCreating} />
            )}
            <RenameDialog
                node={renaming}
                open={renaming !== null}
                onOpenChange={(open) => !open && setRenaming(null)}
            />
            <MoveDialog
                nodes={moving ?? []}
                rootId={rootId}
                open={moving !== null}
                onOpenChange={(open) => !open && setMoving(null)}
            />
            <MoveDialog
                nodes={copying ?? []}
                rootId={rootId}
                mode="copy"
                open={copying !== null}
                onOpenChange={(open) => !open && setCopying(null)}
            />
            <VersionsDialog
                node={versionsOf}
                open={versionsOf !== null}
                onOpenChange={(open) => !open && setVersionsOf(null)}
            />
            <InfoDialog
                node={infoOf}
                location={crumbs.map((crumb) => crumb.name).join(' / ')}
                onShare={
                    infoOf && infoOf.workspaceId === workspaceId
                        ? (node) => {
                              setInfoOf(null);
                              setSharing(node);
                          }
                        : undefined
                }
                onTags={
                    infoOf && infoOf.workspaceId === workspaceId
                        ? (node) => {
                              setInfoOf(null);
                              setTagging([node]);
                          }
                        : undefined
                }
                open={infoOf !== null}
                onOpenChange={(open) => !open && setInfoOf(null)}
            />
            <ShareDialog
                node={sharing}
                open={sharing !== null}
                onOpenChange={(open) => !open && setSharing(null)}
            />
            <TagDialog
                nodes={tagging ?? []}
                open={tagging !== null}
                onOpenChange={(open) => !open && setTagging(null)}
            />
            <ReportDialog
                node={reporting}
                via={{ share: true }}
                signedIn
                open={reporting !== null}
                onOpenChange={(open) => !open && setReporting(null)}
            />
            <Preview
                files={rows.filter((row) => row.kind === 'file')}
                current={previewing}
                onChange={(node) => showPreview(node, node !== null)}
                onDownload={(node) => download([node])}
            />
            <HotkeyHints />
        </div>
    );
}

const SORT_STORAGE = 'hushos.folder-sort';
const sortListeners = new Set<() => void>();
/* Set by a choice this session, so the order applies even where storage is blocked. */
let sortChosen: string | null = null;

function readSort() {
    if (sortChosen !== null) return sortChosen;
    try {
        return window.localStorage.getItem(SORT_STORAGE) ?? '';
    } catch {
        return '';
    }
}

function parseSort(raw: string): SortOrder {
    try {
        const saved = JSON.parse(raw || 'null') as SortOrder | null;
        if (saved && ['name', 'modified', 'size'].includes(saved.key)) return saved;
    } catch {
        /* Unreadable: the default order. */
    }
    return DEFAULT_SORT;
}

/*
 * The order folder lists use, remembered in this browser. The server snapshot is
 * the default, so the rendered markup and the first client render agree; the saved
 * order takes over right after hydration.
 */
function useSortOrder() {
    const raw = useSyncExternalStore(
        (listener) => {
            sortListeners.add(listener);
            return () => sortListeners.delete(listener);
        },
        readSort,
        () => '',
    );
    const order = useMemo(() => parseSort(raw), [raw]);
    const update = (next: SortOrder) => {
        sortChosen = JSON.stringify(next);
        try {
            window.localStorage.setItem(SORT_STORAGE, sortChosen);
        } catch {
            /* Not remembered, still applied. */
        }
        for (const listener of sortListeners) listener();
    };
    return [order, update] as const;
}

function ariaSort(order: SortOrder, key: SortKey) {
    if (order.key !== key) return undefined;
    return order.ascending ? ('ascending' as const) : ('descending' as const);
}

/* A column label that sorts by it; a second click flips the direction. Newest and largest come first on the first click. */
function SortHeader({
    label,
    sortKey,
    order,
    onOrder,
    align = 'start',
}: {
    label: string;
    sortKey: SortKey;
    order: SortOrder;
    onOrder: (order: SortOrder) => void;
    align?: 'start' | 'end';
}) {
    const active = order.key === sortKey;
    const Arrow = order.ascending ? ArrowUpIcon : ArrowDownIcon;
    return (
        <button
            type="button"
            onClick={() =>
                onOrder(
                    active
                        ? { key: sortKey, ascending: !order.ascending }
                        : { key: sortKey, ascending: sortKey === 'name' },
                )
            }
            className={`eyebrow inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''} ${align === 'end' ? 'flex-row-reverse' : ''}`}
            aria-label={`Sort by ${label.toLowerCase()}`}
        >
            {label}
            {active && <Arrow className="size-3" aria-hidden="true" />}
        </button>
    );
}
