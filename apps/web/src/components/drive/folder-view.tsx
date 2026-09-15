import { CreateFolderDialog } from '@/components/drive/create-folder-dialog';
import { useDrive } from '@/components/drive/drive-shell';
import { HotkeyHints, Kbd } from '@/components/drive/hotkey-hints';
import { InfoDialog } from '@/components/drive/info-dialog';
import { MoveDialog } from '@/components/drive/move-dialog';
import { Preview } from '@/components/drive/preview';
import { RenameDialog } from '@/components/drive/rename-dialog';
import { ReportDialog } from '@/components/drive/report-dialog';
import { ShareDialog } from '@/components/drive/share-dialog';
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
    sortNodes,
} from '@/lib/drive';
import { saveCopy } from '@/lib/save-copy';
import { cue } from '@/lib/sounds';
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
    FileIcon,
    FileImageIcon,
    FileTextIcon,
    FileVideoIcon,
    FolderIcon,
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
    Trash2Icon,
    UploadIcon,
} from 'lucide-react';
import {
    createElement,
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

function iconFor(node: DriveNode) {
    if (node.kind === 'folder') return FolderIcon;
    const mime = node.metadata?.mime ?? '';
    if (mime.startsWith('image/')) return FileImageIcon;
    if (mime.startsWith('video/')) return FileVideoIcon;
    if (mime.startsWith('text/') || mime === 'application/pdf') return FileTextIcon;
    return FileIcon;
}

function folderLink(rootId: string, folderId: string) {
    return folderId === rootId
        ? ({ to: '/app' } as const)
        : ({ to: '/app/f/$folderId', params: { folderId } } as const);
}

const VIEW_KEY = 'hushos.drive.view';

/* A file's thumbnail where one exists, its type's icon otherwise. */
function NodeThumb({
    node,
    className,
    iconClassName,
}: {
    node: DriveNode;
    className: string;
    iconClassName: string;
}) {
    const url = useThumbnail(node);
    if (url)
        return <img src={url} alt="" draggable={false} className={`${className} object-cover`} />;
    return (
        <span className={`flex items-center justify-center ${className}`}>
            {createElement(iconFor(node), {
                'aria-hidden': 'true',
                className: `${iconClassName} ${node.kind === 'folder' ? 'text-primary' : 'text-muted-foreground'}`,
            })}
        </span>
    );
}

/*
 * Once anything is selected, every row and tile shows a box in place of, or
 * over, its icon: on a phone that is the one target that reliably adds or
 * removes a row, where a tap elsewhere on the row is easy to miss and a tap on
 * the name opens it. It is a checkbox in role and behaviour, and it stops the
 * tap from reaching the row underneath so a tap is exactly one toggle.
 */
function SelectMark({
    checked,
    indeterminate = false,
    name,
    className,
    onToggle,
}: {
    checked: boolean;
    /* Some but not all: the header's box while a selection is partial. */
    indeterminate?: boolean;
    name: string;
    className: string;
    onToggle: () => void;
}) {
    return (
        <span className={`flex items-center justify-center ${className}`}>
            {/* The input covers the box and takes the tap; the icon beneath is its face. */}
            <input
                type="checkbox"
                className="absolute inset-0 size-full cursor-default appearance-none opacity-0"
                checked={checked}
                ref={(input) => {
                    if (input) input.indeterminate = indeterminate;
                }}
                aria-label={`Select ${name}`}
                tabIndex={-1}
                onChange={onToggle}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
            />
            {checked ? (
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
        <Link to="/app" search={search} {...props} />
    ) : (
        <Link to="/app/f/$folderId" params={{ folderId: target }} search={search} {...props} />
    );
}

/* Whether the primary pointer is a finger: taps then toggle selection instead of replacing it. */
function useCoarsePointer() {
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

function ListFooter({ count }: { count: number }) {
    return (
        <p className="px-5 py-3 font-mono text-[11px] text-muted-foreground sm:px-8">
            {count} {count === 1 ? 'item' : 'items'}. Hold <Kbd>{keyLabel('Mod')}</Kbd> for
            shortcuts.
        </p>
    );
}

export function FolderView({ folderId }: { folderId: string }) {
    const { rootId, workspaceId } = useDrive();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const listing = useQuery(folderQueryOptions(folderId));
    const rows = useMemo(
        () => (listing.data ? sortNodes(listing.data.children) : []),
        [listing.data],
    );
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [anchor, setAnchor] = useState<string | null>(null);
    const [focused, setFocused] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [renaming, setRenaming] = useState<DriveNode | null>(null);
    const [moving, setMoving] = useState<DriveNode[] | null>(null);
    const [copying, setCopying] = useState<DriveNode[] | null>(null);
    const [versionsOf, setVersionsOf] = useState<DriveNode | null>(null);
    const [infoOf, setInfoOf] = useState<DriveNode | null>(null);
    const [sharing, setSharing] = useState<DriveNode | null>(null);
    const [reporting, setReporting] = useState<DriveNode | null>(null);
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
    const allSelected = rows.length > 0 && selection.length === rows.length;
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
    function moveFocus(delta: number) {
        if (!rows.length) return;
        const index = focused ? rows.findIndex((row) => row.id === focused) : -1;
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]!;
        select(next);
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
            modifiers: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };
        } | null = null;
        let dragging = false;
        const onDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            const target = event.target as HTMLElement;
            if (
                target.closest(
                    'button, a, input, thead, [role=menu], [role=dialog], section[aria-label=Transfers]',
                )
            )
                return;
            start = {
                x: event.clientX,
                y: event.clientY,
                additive: event.metaKey || event.ctrlKey || event.shiftKey,
                base: new Set(latest.current.selected),
                row: target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null,
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
                if (node) latest.current.select(node, start.modifiers);
                else {
                    setSelected(new Set());
                    setFocused(null);
                }
            }
            start = null;
            dragging = false;
            setMarquee(null);
        };
        root.addEventListener('pointerdown', onDown);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            root.removeEventListener('pointerdown', onDown);
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
    useHotkey('I', () => selection.length === 1 && setInfoOf(selection[0]!), { enabled });
    useHotkey('Backspace', () => void trash(selection), { enabled });
    useHotkey('Delete', () => void trash(selection), { enabled });
    useHotkey('Enter', () => selection.length === 1 && open(selection[0]!), { enabled });
    useHotkey('ArrowDown', () => moveFocus(1), { enabled });
    useHotkey('ArrowUp', () => moveFocus(-1), { enabled });
    useHotkey('Mod+A', () => setSelected(new Set(rows.map((row) => row.id))), { enabled });
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
                download: () => paletteHandlers.current.download(selection),
                trash: () => void paletteHandlers.current.trash(selection),
            },
        });
    }, [rows, folder, selection, view, workspaceId]);
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
    // Rows drag as themselves, or as the whole selection when they are part of it.
    // Folder rows and breadcrumb ancestors take the drop; the current folder does not.
    const moveToRef = useRef(moveTo);
    useEffect(() => {
        moveToRef.current = moveTo;
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
                canDrop: ({ source }) =>
                    source.data.type === 'drive-nodes' &&
                    !(source.data.ids as string[]).includes(destination.id),
                onDragEnter: () => setDropOver(destination.id),
                onDragLeave: () => setDropOver(null),
                onDrop: ({ source, location }) => {
                    setDropOver(null);
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
                    className="pointer-events-none absolute z-10 border border-primary bg-primary/10"
                    style={marquee}
                />
            )}
            {over && folder && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-primary bg-background/80"
                >
                    <p className="border bg-popover px-4 py-3 font-mono text-xs shadow-hard">
                        {folder.parentId === null
                            ? 'Drop to upload here'
                            : `Drop to upload into “${folder.name}”`}
                    </p>
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-5 py-4 sm:px-8">
                <div className="min-w-0">
                    <Breadcrumb>
                        <BreadcrumbList className="text-base">
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
                                            <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
                                        ) : (
                                            <BreadcrumbLink
                                                render={
                                                    <Link
                                                        {...folderLink(rootId, crumb.id)}
                                                        data-crumb-id={crumb.id}
                                                        className={
                                                            dropOver === crumb.id
                                                                ? 'bg-accent text-accent-foreground ring-2 ring-primary ring-offset-2 ring-offset-background'
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
                        onClick={() => setView((current) => (current === 'grid' ? 'list' : 'grid'))}
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

            {/* Always present, so the list never jumps when a selection comes and goes. */}
            <div className="flex h-10 items-center gap-1 border-b bg-muted/40 px-3 sm:gap-2 sm:px-8">
                <span className="eyebrow mr-1 shrink-0 text-muted-foreground sm:mr-2">
                    {rows.length ? `${selection.length} selected` : 'Empty'}
                </span>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label={allSelected ? 'Clear selection' : 'Select all'}
                    aria-pressed={allSelected}
                    disabled={!rows.length}
                    className={view === 'grid' ? '' : 'hidden'}
                    onClick={() =>
                        setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)))
                    }
                >
                    {allSelected ? <SquareCheckIcon /> : <SquareIcon />}
                    <span className="max-sm:sr-only">{allSelected ? 'Clear' : 'Select all'}</span>
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Rename"
                    disabled={selection.length !== 1}
                    onClick={() => setRenaming(selection[0]!)}
                >
                    <PencilIcon />
                    <span className="max-sm:sr-only">Rename</span>
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Move"
                    disabled={!selection.length}
                    onClick={() => setMoving(selection)}
                >
                    <FolderInputIcon />
                    <span className="max-sm:sr-only">Move</span>
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Download"
                    disabled={!selection.length}
                    onClick={() => download(selection)}
                >
                    <DownloadIcon />
                    <span className="max-sm:sr-only">Download</span>
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Share"
                    className="max-sm:hidden"
                    disabled={selection.length !== 1 || selection[0]!.workspaceId !== workspaceId}
                    onClick={() => setSharing(selection[0]!)}
                >
                    <Share2Icon />
                    <span>Share</span>
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Versions"
                    className="max-sm:hidden"
                    disabled={selection.length !== 1 || selection[0]!.kind !== 'file'}
                    onClick={() => setVersionsOf(selection[0]!)}
                >
                    <HistoryIcon />
                    <span>Versions</span>
                </Button>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Info"
                    className="max-sm:hidden"
                    disabled={selection.length !== 1}
                    onClick={() => setInfoOf(selection[0]!)}
                >
                    <InfoIcon />
                    <span>Info</span>
                </Button>
                {/* A phone has no room for every action in one row: the rest sit behind More. */}
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label="More actions"
                                className="sm:hidden"
                                disabled={!selection.length}
                            />
                        }
                    >
                        <EllipsisIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={6}>
                        <DropdownMenuItem
                            disabled={
                                selection.length !== 1 || selection[0]!.workspaceId !== workspaceId
                            }
                            onClick={() => setSharing(selection[0]!)}
                        >
                            <Share2Icon aria-hidden="true" /> Share…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={selection.length !== 1 || selection[0]!.kind !== 'file'}
                            onClick={() => setVersionsOf(selection[0]!)}
                        >
                            <HistoryIcon aria-hidden="true" /> Versions…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={!selection.length}
                            onClick={() => setCopying(selection)}
                        >
                            <CopyIcon aria-hidden="true" /> Copy to…
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={selection.length !== 1}
                            onClick={() => setInfoOf(selection[0]!)}
                        >
                            <InfoIcon aria-hidden="true" /> Info…
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Trash"
                    disabled={!selection.length || trashing}
                    onClick={() => void trash(selection)}
                >
                    <Trash2Icon />
                    <span className="max-sm:sr-only">Trash</span>
                </Button>
            </div>

            {/* The space itself has a menu too: what you can do here, without a selection. */}
            <ContextMenu>
                <ContextMenuTrigger render={<div />} className="flex min-h-0 flex-1 flex-col">
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
                        <div className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
                            <div className="flex max-w-sm flex-col items-center gap-5 text-center">
                                <div>
                                    <p className="eyebrow mb-3 text-muted-foreground">
                                        Empty folder
                                    </p>
                                    <h2 className="text-lg font-medium tracking-tight">
                                        Nothing here yet
                                    </h2>
                                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                                        Drop files or folders anywhere on this page. Everything is
                                        encrypted on this device before it leaves.
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center justify-center gap-2">
                                    <Button size="sm" onClick={() => picker.current?.pickFiles()}>
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
                                    <tr className="border-b">
                                        <th
                                            scope="col"
                                            className="eyebrow py-2.5 pl-5 text-left font-medium text-muted-foreground sm:pl-8"
                                        >
                                            <span className="flex items-center gap-3">
                                                {rows.length > 0 && (
                                                    <SelectMark
                                                        checked={allSelected}
                                                        indeterminate={selecting && !allSelected}
                                                        name={allSelected ? 'none' : 'all'}
                                                        className="relative size-6 shrink-0"
                                                        onToggle={() =>
                                                            setSelected(
                                                                allSelected
                                                                    ? new Set()
                                                                    : new Set(
                                                                          rows.map((row) => row.id),
                                                                      ),
                                                            )
                                                        }
                                                    />
                                                )}
                                                Name
                                            </span>
                                        </th>
                                        <th
                                            scope="col"
                                            className="eyebrow hidden w-36 py-2.5 text-left font-medium text-muted-foreground sm:table-cell"
                                        >
                                            Modified
                                        </th>
                                        <th
                                            scope="col"
                                            className="eyebrow w-28 py-2.5 pr-5 text-right font-medium text-muted-foreground sm:pr-8"
                                        >
                                            Size
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
                                                            onContextMenu={(event) => {
                                                                event.stopPropagation();
                                                                if (!isSelected) select(node);
                                                            }}
                                                        />
                                                    }
                                                    className={`cursor-default border-b select-none ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'} ${focused === node.id && !isSelected ? 'ring-1 ring-ring ring-inset' : ''} ${dropOver === node.id ? 'bg-primary/15 ring-2 ring-primary ring-inset' : ''}`}
                                                >
                                                    <td className="min-w-0 p-0">
                                                        <button
                                                            type="button"
                                                            className="flex w-full min-w-0 items-center gap-3 py-2 pl-5 text-left text-sm outline-none sm:pl-8"
                                                            onClick={(event) => select(node, event)}
                                                            onDoubleClick={() => open(node)}
                                                        >
                                                            {selecting ? (
                                                                <SelectMark
                                                                    checked={isSelected}
                                                                    name={node.name}
                                                                    className="relative size-6 shrink-0"
                                                                    onToggle={() => toggle(node)}
                                                                />
                                                            ) : (
                                                                <NodeThumb
                                                                    node={node}
                                                                    className="size-6 shrink-0"
                                                                    iconClassName="size-4"
                                                                />
                                                            )}
                                                            <NodeName
                                                                node={node}
                                                                rootId={rootId}
                                                                folderId={folderId}
                                                                onOpen={() => {
                                                                    if (node.kind === 'file')
                                                                        pushedPreview.current = true;
                                                                }}
                                                            />
                                                        </button>
                                                    </td>
                                                    <td className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                                                        {formatWhen(
                                                            node.metadata?.modified ??
                                                                node.updatedAt,
                                                        )}
                                                    </td>
                                                    <td className="py-2.5 pr-5 text-right font-mono text-xs text-muted-foreground tabular-nums sm:pr-8">
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
                                                    onInfo={setInfoOf}
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
                                </tbody>
                            </table>
                            <ListFooter count={rows.length} />
                        </div>
                    )}
                    {listing.data && rows.length > 0 && view === 'grid' && (
                        <div ref={listRef} className="flex flex-col">
                            <div
                                aria-label={`Contents of ${folder?.name ?? 'folder'}`}
                                className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] sm:px-8"
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
                                                className={`flex cursor-default flex-col border select-none ${isSelected ? 'border-primary bg-accent text-accent-foreground' : 'hover:bg-muted/60'} ${focused === node.id && !isSelected ? 'ring-1 ring-ring' : ''} ${dropOver === node.id ? 'bg-primary/15 ring-2 ring-primary' : ''}`}
                                            >
                                                <button
                                                    type="button"
                                                    aria-label={node.name}
                                                    aria-pressed={isSelected}
                                                    className="flex w-full min-w-0 flex-col text-left outline-none"
                                                    onClick={(event) => select(node, event)}
                                                    onDoubleClick={() => open(node)}
                                                >
                                                    <div className="relative flex aspect-4/3 w-full items-center justify-center overflow-hidden border-b bg-muted/40 sm:aspect-square">
                                                        <NodeThumb
                                                            node={node}
                                                            className="h-full w-full"
                                                            iconClassName="size-8"
                                                        />
                                                        {selecting && (
                                                            <SelectMark
                                                                checked={isSelected}
                                                                name={node.name}
                                                                className="absolute top-2 left-2 size-8 border bg-popover shadow-hard"
                                                                onToggle={() => toggle(node)}
                                                            />
                                                        )}
                                                    </div>
                                                    <div className="min-w-0 px-2.5 py-2">
                                                        <p className="truncate text-sm">
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
                                                        <p className="eyebrow mt-0.5 truncate text-muted-foreground">
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
                                                onInfo={setInfoOf}
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
                            <ListFooter count={rows.length} />
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
                open={infoOf !== null}
                onOpenChange={(open) => !open && setInfoOf(null)}
            />
            <ShareDialog
                node={sharing}
                open={sharing !== null}
                onOpenChange={(open) => !open && setSharing(null)}
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
