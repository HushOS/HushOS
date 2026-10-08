import {
    AccessBanner,
    AccessCell,
    accessSentence,
    useAccessIndex,
} from '@/components/drive/access';
import { CreateFolderDialog } from '@/components/drive/create-folder-dialog';
import { DetailsPanel } from '@/components/drive/details-panel';
import { useDrive } from '@/components/drive/drive-shell';
import {
    CornerCheck,
    EmptyState,
    MarqueeBox,
    SelectableMark,
    SkeletonRows,
    SortButton,
    useListSelection,
} from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { HotkeyHints } from '@/components/drive/hotkey-hints';
import { InfoDialog } from '@/components/drive/info-dialog';
import { MoveDialog } from '@/components/drive/move-dialog';
import {
    NodeContextMenu,
    nodeEntries,
    NodeMoreMenu,
    NodeSelectionBar,
    SizeText,
    useWideScreen,
    type NodeActions,
} from '@/components/drive/node-actions';
import { Preview } from '@/components/drive/preview';
import { RenameDialog } from '@/components/drive/rename-dialog';
import { ReportDialog } from '@/components/drive/report-dialog';
import { ShareDialog } from '@/components/drive/share-dialog';
import { TagDialog } from '@/components/drive/tag-dialog';
import { TagStamps } from '@/components/drive/tag-stamp';
import { keyLabel } from '@/components/drive/shortcuts';
import { AddMenu } from '@/components/drive/add-menu';
import { UploadInputs, useDropZone, type UploadPicker } from '@/components/drive/upload-controls';
import { VersionsDialog } from '@/components/drive/versions-dialog';
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
    formatWhen,
    invalidateFolders,
    sharedQueryOptions,
    sortNodesBy,
    DEFAULT_SORT,
    type SortKey,
    type SortOrder,
} from '@/lib/drive';
import { previewKind } from '@/lib/previews';
import { saveCopy } from '@/lib/save-copy';
import { cue } from '@/lib/sounds';
import { tagsQueryOptions } from '@/lib/tags';
import { tagsOf } from '@hushos/drive/client';
import { useThumbnail } from '@/lib/thumbnails';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
    draggable,
    dropTargetForElements,
    monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { disableNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/disable-native-drag-preview';
import type { DriveNode, FolderListing } from '@hushos/drive/client';
import { useHotkey } from '@tanstack/react-hotkeys';
import { lendPaletteContext, usePaletteOpen } from '@/lib/palette';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { cn } from 'cn';
import {
    ChevronRightIcon,
    CopyIcon,
    FileUpIcon,
    FolderPlusIcon,
    FolderUpIcon,
    LayoutGridIcon,
    ListChecksIcon,
    ListIcon,
    RotateCcwIcon,
    TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';

/*
 * One folder at a time: its path as the page title, the rows, and the actions.
 * Selection follows desktop conventions (click, Mod-click, Shift-click, a box
 * drawn on empty space, arrows), a double click or Enter opens, and every action
 * is also a keyboard shortcut and a palette entry.
 */

function folderLink(rootId: string, folderId: string) {
    return folderId === rootId
        ? ({ to: '/app/drive' } as const)
        : ({ to: '/app/drive/f/$folderId', params: { folderId } } as const);
}

const VIEW_KEY = 'hushos.drive.view';

/* A tile's face: a photo or a video frame fills it; everything else is its mark, centred. */
function NodeFace({ node }: { node: DriveNode }) {
    const url = useThumbnail(node);
    const kind = previewKind(node);
    if (url && (kind === 'image' || kind === 'video'))
        return (
            <>
                <img src={url} alt="" draggable={false} className="size-full object-cover" />
                {kind === 'video' && (
                    <span className="absolute flex size-10 items-center justify-center rounded-full bg-black/45">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                            <path d="M8 5.5v13l11-6.5z" />
                        </svg>
                    </span>
                )}
            </>
        );
    return <FileMark node={node} size="large" />;
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
    const ids = useMemo(() => rows.map((row) => row.id), [rows]);
    const dropRef = useRef<HTMLDivElement>(null);
    const {
        coarse,
        selected,
        setSelected,
        focused,
        marquee,
        select,
        toggle,
        clear,
        selectAll,
        moveFocus,
    } = useListSelection(ids, dropRef);
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
    const picker = useRef<UploadPicker>(null);

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
    /* The Info key: it opens the details, and puts an open panel away. */
    function toggleInfo() {
        if (wide && detailsOpen) setDetailsOpen(false);
        else if (selection.length === 1) showInfo(selection[0]!);
    }
    function open(node: DriveNode) {
        if (node.kind === 'folder') void navigate(folderLink(rootId, node.id));
        else showPreview(node);
    }
    /* A re-encrypted copy of something shared with this person, into the top of their own files. */
    async function saveToMyDrive(nodes: DriveNode[]) {
        if (!nodes.length) return;
        try {
            const root = (await queryClient.fetchQuery(folderQueryOptions(rootId))).folder;
            const made = await saveCopy(queryClient, nodes, root);
            cue('droplet');
            toast.add({
                type: 'success',
                // The same words as the Shared page: no keys, just where it lands.
                title:
                    made === 1 && nodes[0]!.kind === 'file'
                        ? `Saving “${nodes[0]!.name}” to your files`
                        : `Saving ${made} items to your files`,
                description:
                    made === 1
                        ? 'It shows up in My files as it copies.'
                        : 'They show up in My files as they copy.',
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t save a copy',
                description: driveError(error),
            });
        }
    }
    function download(nodes: DriveNode[]) {
        if (!nodes.length) return;
        const here = listing.data?.folder;
        downloadNodes(nodes, here?.parentId === null ? undefined : here?.name);
    }
    /* Puts trashed items back where they were: the toast's Undo. */
    async function undoTrash(nodes: DriveNode[]) {
        let back = 0;
        try {
            for (const node of nodes) {
                await driveClient.restore(node);
                back++;
            }
            cue('success');
            toast.add({
                type: 'success',
                title: back === 1 ? `“${nodes[0]!.name}” is back` : `${back} items are back`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title:
                    back === 0 ? 'Couldn’t bring it back' : `${back} of ${nodes.length} are back`,
                description: `${driveError(error)} The rest are still in Trash.`,
            });
        } finally {
            await invalidateFolders(queryClient, folderId);
        }
    }
    async function trash(nodes: DriveNode[]) {
        if (!nodes.length || trashing) return;
        setTrashing(true);
        const done: DriveNode[] = [];
        try {
            for (const node of nodes) done.push(await driveClient.trash(node));
            cue('droplet');
            toast.add({
                type: 'success',
                title:
                    done.length === 1
                        ? `“${nodes[0]!.name}” moved to Trash`
                        : `${done.length} items moved to Trash`,
                description:
                    done.length === 1
                        ? 'It stays in Trash for 30 days.'
                        : 'They stay in Trash for 30 days.',
                timeout: 8_000,
                actionProps: { children: 'Undo', onClick: () => void undoTrash(done) },
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title:
                    done.length === 0
                        ? 'Couldn’t move to Trash'
                        : `${done.length} of ${nodes.length} moved to Trash`,
                description: driveError(error),
            });
        } finally {
            setTrashing(false);
            await invalidateFolders(queryClient, folderId);
        }
    }

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
    useHotkey('Mod+A', selectAll, { enabled, ignoreInputs: true });
    useHotkey('Escape', clear, { enabled });

    const folder = listing.data?.folder;
    // While a folder loads for the first time, its path is already known from the
    // listing it was opened from, so the title never blanks on the way in.
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
    /* A folder's name as the path shows it: one's own top folder is "My files". */
    const crumbName = (crumb: DriveNode) =>
        crumb.parentId === null && crumb.workspaceId === workspaceId ? 'My files' : crumb.name;
    const shared = crumbs.length > 0 && crumbs[0]!.workspaceId !== workspaceId;
    const title = folder ? crumbName(folder) : crumbs.length ? crumbName(crumbs.at(-1)!) : '';
    // Who can open what, from everything this person shares; a folder in the path that is
    // shared means everything here is open to the same people.
    const access = useAccessIndex(!shared);
    const inheritedFrom = [...crumbs].reverse().find((crumb) => access.has(crumb.id)) ?? null;
    const mounts = useQuery({ ...sharedQueryOptions, enabled: shared });
    const sharedBy = shared
        ? (mounts.data?.find((mount) => mount.node.id === crumbs[0]?.id) ?? null)
        : null;
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
        // `setSelected` is a state setter and never changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, folder, selection, ownSelection, view, workspaceId]);
    useEffect(() => () => lendPaletteContext(null), []);

    /* Moves dragged rows into a folder row or a crumb further up; with Alt held, copies them. */
    async function moveTo(dragged: string[], destination: DriveNode, copy = false) {
        const nodes = rows.filter((row) => dragged.includes(row.id) && row.id !== destination.id);
        if (!nodes.length || movingByDrag) return;
        setMovingByDrag(true);
        const where = destination.parentId === null ? 'My files' : `“${destination.name}”`;
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
                    description: 'The copies count against your storage.',
                });
                return;
            }
            const done: DriveNode[] = [];
            for (const node of nodes) {
                done.push(await driveClient.move(node, destination));
                moved++;
            }
            const origin = folder;
            cue('droplet');
            toast.add({
                type: 'success',
                title:
                    moved === 1
                        ? `“${nodes[0]!.name}” moved to ${where}`
                        : `${moved} items moved to ${where}`,
                timeout: 8_000,
                actionProps: origin
                    ? { children: 'Undo', onClick: () => void moveBack(done, origin) }
                    : undefined,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: copy ? 'Couldn’t copy' : 'Couldn’t move',
                description: driveError(error),
            });
        } finally {
            setMovingByDrag(false);
            await invalidateFolders(queryClient, folderId, destination.id);
        }
    }
    /* The Undo on a move made by dragging: everything goes back where it came from. */
    async function moveBack(nodes: DriveNode[], origin: DriveNode) {
        let back = 0;
        try {
            for (const node of nodes) {
                await driveClient.move(node, origin);
                back++;
            }
            cue('success');
            toast.add({
                type: 'success',
                title: back === 1 ? `“${nodes[0]!.name}” is back` : `${back} items are back`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: back === 0 ? 'Couldn’t move it back' : `${back} of ${nodes.length} are back`,
                description: driveError(error),
            });
        } finally {
            await invalidateFolders(queryClient, origin.id, ...nodes.map((node) => node.parentId));
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
        const where = destination.parentId === null ? 'My files' : `“${destination.name}”`;
        try {
            await driveClient.move(node, destination);
            cue('droplet');
            toast.add({ type: 'success', title: `“${node.name}” moved to ${where}` });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Couldn’t move', description: driveError(error) });
        } finally {
            setMovingByDrag(false);
            await invalidateFolders(queryClient, folderId, node.parentId, destination.id);
        }
    }
    // Rows drag as themselves, or as the whole selection when they are part of it.
    // Folder rows and crumbs further up take the drop; the current folder does not.
    const dragState = useRef({ selected, select, moveTo, moveCrumb });
    useEffect(() => {
        dragState.current = { selected, select, moveTo, moveCrumb };
    });
    useEffect(() => {
        const root = dropRef.current;
        if (!root) return;
        const cleanups: (() => void)[] = [];
        const dragged = (id: string) =>
            dragState.current.selected.has(id) ? [...dragState.current.selected] : [id];
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
                        void dragState.current.moveCrumb(source.data.id as string, destination);
                        return;
                    }
                    void dragState.current.moveTo(
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
                    onGenerateDragPreview: ({ nativeSetDragImage }) =>
                        disableNativeDragPreview({ nativeSetDragImage }),
                    onDragStart: () => {
                        if (!dragState.current.selected.has(id)) dragState.current.select(id);
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
                draggable({
                    element,
                    getInitialData: () => ({ type: 'drive-crumb', id }),
                    onGenerateDragPreview: ({ nativeSetDragImage }) =>
                        disableNativeDragPreview({ nativeSetDragImage }),
                }),
            );
        }
        return combine(...cleanups);
    }, [rows, crumbs, view]);

    /* The card that follows the pointer while rows or a crumb are dragged, in place of the browser's snapshot. */
    const [ghost, setGhost] = useState<{
        x: number;
        y: number;
        ids: string[];
        copy: boolean;
    } | null>(null);
    useEffect(
        () =>
            monitorForElements({
                canMonitor: ({ source }) =>
                    source.data.type === 'drive-nodes' || source.data.type === 'drive-crumb',
                onDragStart: ({ source, location }) =>
                    setGhost({
                        x: location.current.input.clientX,
                        y: location.current.input.clientY,
                        ids:
                            source.data.type === 'drive-crumb'
                                ? [source.data.id as string]
                                : (source.data.ids as string[]),
                        copy: source.data.type === 'drive-nodes' && location.current.input.altKey,
                    }),
                onDrag: ({ source, location }) =>
                    setGhost((current) =>
                        current
                            ? {
                                  ...current,
                                  x: location.current.input.clientX,
                                  y: location.current.input.clientY,
                                  copy:
                                      source.data.type === 'drive-nodes' &&
                                      location.current.input.altKey,
                              }
                            : current,
                    ),
                onDrop: () => setGhost(null),
            }),
        [],
    );
    const ghostNodes = ghost
        ? [...rows, ...crumbs].filter(
              (node, index, all) =>
                  ghost.ids.includes(node.id) &&
                  all.findIndex((other) => other.id === node.id) === index,
          )
        : [];
    const ghostTarget = dropOver
        ? [...rows, ...crumbs].find((node) => node.id === dropOver)
        : undefined;

    const actions: NodeActions = {
        onOpen: open,
        onDownload: download,
        onRename: setRenaming,
        onMove: setMoving,
        onCopy: setCopying,
        onVersions: setVersionsOf,
        onInfo: showInfo,
        onTags: (nodes) => setTagging(nodes),
        onShare: setSharing,
        onSaveCopy: (nodes) => void saveToMyDrive(nodes),
        onReport: setReporting,
        onTrash: (nodes) => void trash(nodes),
    };
    /* A node's menu: its own actions, or the selection's when it is part of one. */
    function entriesFor(node: DriveNode) {
        const own = node.workspaceId === workspaceId;
        const isSelected = selected.has(node.id);
        return nodeEntries(node, isSelected && selection.length > 1 ? selection : [node], {
            ...actions,
            onTags: own ? actions.onTags : null,
            onShare: own ? actions.onShare : null,
            onSaveCopy: own ? null : actions.onSaveCopy,
            onReport: own ? null : actions.onReport,
        });
    }
    const markOpened = (node: DriveNode) => () => {
        if (node.kind === 'file') pushedPreview.current = true;
    };
    const tagIds = (node: DriveNode) => (registry ? tagsOf(registry, node.id) : []);

    return (
        <div
            ref={dropRef}
            className={cn('relative flex flex-[1_0_auto] flex-col', marquee && 'select-none')}
        >
            <MarqueeBox marquee={marquee} />
            {ghost && ghostNodes.length > 0 && (
                <DragCard
                    x={ghost.x}
                    y={ghost.y}
                    nodes={ghostNodes}
                    copy={ghost.copy}
                    target={ghostTarget ? crumbName(ghostTarget) : null}
                />
            )}
            {over && folder && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-3 top-0 bottom-3 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-[color-mix(in_oklab,var(--accent)_88%,transparent)] sm:inset-x-6 sm:bottom-6"
                >
                    <FileUpIcon className="size-8 text-primary" strokeWidth={1.8} />
                    <p className="px-6 text-center text-xl font-bold text-accent-foreground">
                        Drop to add to “{title}”
                    </p>
                    <p className="text-sm text-accent-foreground">
                        Files and whole folders both work.
                    </p>
                </div>
            )}
            <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-1 pb-3 sm:gap-6 sm:px-8 sm:pb-4">
                <FolderPath
                    crumbs={crumbs}
                    title={title}
                    shared={shared}
                    rootId={rootId}
                    workspaceId={workspaceId}
                    dropOver={dropOver}
                    crumbName={crumbName}
                />
                <div className="flex shrink-0 items-center gap-2">
                    <fieldset className="m-0 flex min-w-0 items-center rounded-md border border-input bg-card p-0.5">
                        <legend className="sr-only">View</legend>
                        {(
                            [
                                ['list', 'Show as list', ListIcon],
                                ['grid', 'Show as grid', LayoutGridIcon],
                            ] as const
                        ).map(([value, label, Icon]) => (
                            <button
                                key={value}
                                type="button"
                                aria-label={label}
                                aria-pressed={view === value}
                                title={label}
                                onClick={() => setView(value)}
                                className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            >
                                <Icon className="size-4" aria-hidden="true" />
                            </button>
                        ))}
                    </fieldset>
                    {folder && !shared && (
                        <AddMenu picker={picker} onNewFolder={() => setCreating(true)} />
                    )}
                    {folder && <UploadInputs folder={folder} known={rows} handle={picker} />}
                </div>
            </div>
            {inheritedFrom && (
                <AccessBanner
                    text={accessSentence(access.get(inheritedFrom.id)!)}
                    action="Manage access"
                    onAction={() => setSharing(inheritedFrom)}
                />
            )}
            {sharedBy && (
                <AccessBanner
                    text={`${sharedBy.granter.name} shared this folder with you. You can ${
                        sharedBy.role === 'editor' ? 'view, add and change' : 'view and download'
                    } what’s inside.`}
                />
            )}
            {/* Always there in the grid, the same height, so selecting never moves the tiles. */}
            {view === 'grid' && rows.length > 0 && (
                <div className="flex h-8 shrink-0 items-center gap-3 px-5 text-[13px] text-muted-foreground tabular-nums sm:px-8">
                    {selecting
                        ? `${selection.length} of ${rows.length} selected`
                        : `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`}
                    <button
                        type="button"
                        onClick={allSelected ? clear : selectAll}
                        className="cursor-pointer font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                    >
                        {allSelected ? 'Clear selection' : 'Select all'}
                    </button>
                </div>
            )}

            <div className="flex min-h-0 flex-1">
                {/* The space itself has a menu too: what you can do here, without a selection. */}
                <ContextMenu>
                    <ContextMenuTrigger
                        render={<div />}
                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                    >
                        {listing.isPending && <SkeletonRows />}
                        {listing.isError && (
                            <EmptyState
                                icon={TriangleAlertIcon}
                                tone="danger"
                                title="This folder couldn’t be opened"
                                body={driveError(listing.error)}
                            >
                                <Button variant="outline" onClick={() => void listing.refetch()}>
                                    <RotateCcwIcon />
                                    Try again
                                </Button>
                            </EmptyState>
                        )}
                        {listing.data && rows.length === 0 && (
                            <EmptyState
                                icon={FolderPlusIcon}
                                title="Nothing here yet"
                                body={
                                    shared
                                        ? 'When something is added to this folder, it shows up here.'
                                        : 'Drop files or folders anywhere on this page, or use Add.'
                                }
                            >
                                {!shared && (
                                    <>
                                        <Button onClick={() => picker.current?.pickFiles()}>
                                            <FileUpIcon />
                                            Upload files
                                        </Button>
                                        <Button variant="outline" onClick={() => setCreating(true)}>
                                            <FolderPlusIcon />
                                            New folder
                                        </Button>
                                    </>
                                )}
                            </EmptyState>
                        )}
                        {listing.data && rows.length > 0 && view === 'list' && (
                            <table
                                aria-label={`Contents of ${title || 'folder'}`}
                                aria-multiselectable="true"
                                className="w-full table-fixed border-collapse"
                            >
                                <thead>
                                    <tr className="h-10 border-b border-rule">
                                        <th
                                            scope="col"
                                            aria-sort={ariaSort(order, 'name')}
                                            className="pl-5 text-left sm:pl-8"
                                        >
                                            <span className="flex items-center gap-4">
                                                <span className="w-10 shrink-0" />
                                                <SortButton
                                                    label="Name"
                                                    {...sortProps(order, 'name', setOrder)}
                                                />
                                            </span>
                                        </th>
                                        {!shared && (
                                            <th
                                                scope="col"
                                                className="hidden w-[22%] text-left text-xs font-semibold text-muted-foreground lg:table-cell"
                                            >
                                                Who can open
                                            </th>
                                        )}
                                        <th
                                            scope="col"
                                            aria-sort={ariaSort(order, 'modified')}
                                            className="hidden w-40 text-left sm:table-cell"
                                        >
                                            <SortButton
                                                label="Changed"
                                                {...sortProps(order, 'modified', setOrder)}
                                            />
                                        </th>
                                        <th
                                            scope="col"
                                            aria-sort={ariaSort(order, 'size')}
                                            className="w-24 pr-2 text-right sm:w-28"
                                        >
                                            <SortButton
                                                label="Size"
                                                align="end"
                                                {...sortProps(order, 'size', setOrder)}
                                            />
                                        </th>
                                        <th scope="col" className="w-14 pr-3 sm:w-16 sm:pr-5">
                                            <span className="sr-only">More</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((node) => {
                                        const isSelected = selected.has(node.id);
                                        const entries = entriesFor(node);
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
                                                                if (!isSelected) select(node.id);
                                                            }}
                                                        />
                                                    }
                                                    className={cn(
                                                        'group/row h-14 cursor-default border-b border-rule select-none',
                                                        dropOver === node.id
                                                            ? 'bg-accent ring-2 ring-primary ring-inset'
                                                            : isSelected
                                                              ? 'bg-accent'
                                                              : 'hover:bg-muted',
                                                        focused === node.id &&
                                                            !isSelected &&
                                                            'ring-1 ring-ring ring-inset',
                                                    )}
                                                >
                                                    <td className="min-w-0 p-0">
                                                        {/* Only as wide as the name: the blank rest of the cell is row, where a second click lets go. */}
                                                        <span className="inline-flex max-w-full min-w-0 items-center gap-4">
                                                            {/* The padding, the thumbnail and the name are one target that selects; only the name's text opens. */}
                                                            <button
                                                                type="button"
                                                                className="inline-flex min-w-0 cursor-default items-center gap-4 py-2 pl-5 text-left text-[15px] font-medium outline-none sm:pl-8"
                                                                onClick={(event) =>
                                                                    select(node.id, event)
                                                                }
                                                            >
                                                                <SelectableMark
                                                                    name={node.name}
                                                                    checked={isSelected}
                                                                    revealed={coarse && selecting}
                                                                    onToggle={() => toggle(node.id)}
                                                                >
                                                                    <FileMark
                                                                        node={node}
                                                                        size="list"
                                                                    />
                                                                </SelectableMark>
                                                                <NodeName
                                                                    node={node}
                                                                    rootId={rootId}
                                                                    folderId={folderId}
                                                                    onOpen={markOpened(node)}
                                                                />
                                                            </button>
                                                            <TagStamps
                                                                tagIds={tagIds(node)}
                                                                registry={registry}
                                                                itemName={node.name}
                                                                onEdit={
                                                                    node.workspaceId === workspaceId
                                                                        ? () => setTagging([node])
                                                                        : undefined
                                                                }
                                                                max={2}
                                                            />
                                                        </span>
                                                    </td>
                                                    {!shared && (
                                                        <td className="hidden min-w-0 pr-4 lg:table-cell">
                                                            <AccessCell
                                                                access={access.get(node.id)}
                                                                inherited={inheritedFrom !== null}
                                                            />
                                                        </td>
                                                    )}
                                                    <td className="hidden text-[13px] text-muted-foreground tabular-nums sm:table-cell">
                                                        {formatWhen(
                                                            node.metadata?.modified ??
                                                                node.updatedAt,
                                                        )}
                                                    </td>
                                                    <td className="pr-2 text-right text-[13px] text-muted-foreground tabular-nums">
                                                        <SizeText node={node} folderWord="–" />
                                                    </td>
                                                    <td className="pr-3 text-right sm:pr-5">
                                                        <NodeMoreMenu
                                                            name={node.name}
                                                            entries={entries}
                                                        />
                                                    </td>
                                                </ContextMenuTrigger>
                                                <NodeContextMenu entries={entries} />
                                            </ContextMenu>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                        {listing.data && rows.length > 0 && view === 'grid' && (
                            <div
                                aria-label={`Contents of ${title || 'folder'}`}
                                className="grid grid-cols-2 content-start gap-2 px-3 pt-1 pb-6 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] sm:gap-3 sm:px-6"
                            >
                                {rows.map((node) => {
                                    const isSelected = selected.has(node.id);
                                    const entries = entriesFor(node);
                                    return (
                                        <ContextMenu key={node.id}>
                                            <ContextMenuTrigger
                                                render={
                                                    <div
                                                        data-node-id={node.id}
                                                        data-selected={isSelected || undefined}
                                                        onContextMenu={(event) => {
                                                            event.stopPropagation();
                                                            if (!isSelected) select(node.id);
                                                        }}
                                                    />
                                                }
                                                className={cn(
                                                    'group/row relative flex cursor-default flex-col gap-2 rounded-xl p-2 select-none',
                                                    dropOver === node.id || isSelected
                                                        ? 'bg-accent ring-2 ring-primary ring-inset'
                                                        : 'hover:bg-muted',
                                                    focused === node.id &&
                                                        !isSelected &&
                                                        'ring-1 ring-ring ring-inset',
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    aria-label={node.name}
                                                    aria-pressed={isSelected}
                                                    className="flex w-full min-w-0 cursor-default flex-col gap-2 text-left outline-none"
                                                    onClick={(event) => select(node.id, event)}
                                                    onDoubleClick={() => open(node)}
                                                >
                                                    <span className="relative flex aspect-4/3 w-full items-center justify-center overflow-hidden rounded-md bg-muted">
                                                        <NodeFace node={node} />
                                                    </span>
                                                    <span className="flex min-w-0 flex-col gap-0.5 px-1 pb-0.5">
                                                        <span className="truncate text-sm font-medium">
                                                            <NodeName
                                                                node={node}
                                                                rootId={rootId}
                                                                folderId={folderId}
                                                                onOpen={markOpened(node)}
                                                            />
                                                        </span>
                                                        <span className="truncate text-xs text-muted-foreground tabular-nums">
                                                            <SizeText
                                                                node={node}
                                                                folderWord="Folder"
                                                            />
                                                        </span>
                                                    </span>
                                                </button>
                                                <CornerCheck
                                                    name={node.name}
                                                    checked={isSelected}
                                                    revealed={coarse && selecting}
                                                    onToggle={() => toggle(node.id)}
                                                    className="top-3.5 left-3.5 size-5 shadow-md"
                                                    iconClassName="size-3"
                                                />
                                            </ContextMenuTrigger>
                                            <NodeContextMenu entries={entries} />
                                        </ContextMenu>
                                    );
                                })}
                            </div>
                        )}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        {!shared && (
                            <>
                                <ContextMenuItem onClick={() => setCreating(true)}>
                                    <FolderPlusIcon aria-hidden="true" />
                                    New folder
                                    <ContextMenuShortcut>{keyLabel('Shift')}N</ContextMenuShortcut>
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => picker.current?.pickFiles()}>
                                    <FileUpIcon aria-hidden="true" />
                                    Upload files
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => picker.current?.pickFolder()}>
                                    <FolderUpIcon aria-hidden="true" />
                                    Upload folder
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                            </>
                        )}
                        <ContextMenuItem disabled={!rows.length} onClick={selectAll}>
                            <ListChecksIcon aria-hidden="true" />
                            Select all
                            <ContextMenuShortcut>{keyLabel('Mod')}A</ContextMenuShortcut>
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
                {wide && detailsOpen && (
                    <DetailsPanel
                        node={single}
                        location={crumbs.map(crumbName).join(' / ')}
                        onTags={
                            single?.workspaceId === workspaceId
                                ? (node) => setTagging([node])
                                : undefined
                        }
                        onShare={single?.workspaceId === workspaceId ? setSharing : undefined}
                        inherited={inheritedFrom !== null}
                        onClose={() => setDetailsOpen(false)}
                    />
                )}
            </div>

            {selecting && (
                <NodeSelectionBar
                    selection={selection}
                    own={ownSelection}
                    allSelected={allSelected}
                    trashing={trashing}
                    infoOpen={wide && detailsOpen}
                    onShare={setSharing}
                    onDownload={() => download(selection)}
                    onMove={() => setMoving(selection)}
                    onCopy={() => setCopying(selection)}
                    onRename={setRenaming}
                    onTags={() => setTagging(selection)}
                    onTrash={() => void trash(selection)}
                    onVersions={setVersionsOf}
                    onInfo={toggleInfo}
                    onSelectAll={selectAll}
                    onClear={clear}
                />
            )}
            {folder && (
                <CreateFolderDialog parent={folder} open={creating} onOpenChange={setCreating} />
            )}
            <RenameDialog
                node={renaming}
                siblings={rows}
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
                location={crumbs.map(crumbName).join(' / ')}
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
                inherited={inheritedFrom !== null}
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
                onShare={folder?.workspaceId === workspaceId ? setSharing : undefined}
                access={
                    shared
                        ? undefined
                        : (node) => (
                              <AccessCell
                                  access={access.get(node.id)}
                                  inherited={inheritedFrom !== null}
                              />
                          )
                }
            />
            <HotkeyHints />
        </div>
    );
}

/*
 * What is being dragged and what the drop will do, beside the pointer: the first
 * item's thumbnail on a small pile when there are several, then "Move to …" over a
 * folder or a crumb, or "Copy to …" while Alt (⌥) is held.
 */
function DragCard({
    x,
    y,
    nodes,
    copy,
    target,
}: {
    x: number;
    y: number;
    nodes: DriveNode[];
    copy: boolean;
    target: string | null;
}) {
    const first = nodes[0]!;
    const verb = copy ? 'Copy' : 'Move';
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[60] flex max-w-80 items-center gap-3 rounded-xl border border-edge bg-popover py-2 pr-4 pl-2 shadow-xl"
            style={{ left: x + 14, top: y + 10 }}
        >
            <span className="relative shrink-0">
                {nodes.length > 1 && (
                    <span className="absolute -top-1 -right-1 size-9 rotate-6 rounded-md bg-ink/10" />
                )}
                <FileMark node={first} size="list" className="relative" />
            </span>
            <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-semibold">
                    {nodes.length === 1 ? first.name : `${nodes.length} items`}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {copy && <CopyIcon className="size-3 shrink-0" aria-hidden="true" />}
                    <span className="truncate">
                        {target ? `${verb} to “${target}”` : 'Drop on a folder'}
                        {!copy && ` · hold ${keyLabel('Alt')} to copy`}
                    </span>
                </span>
            </span>
        </div>
    );
}

/*
 * The folder path is the page title: folders above are links, the folder you are in
 * is the heading. One row at every depth, so nothing moves as you go in and out of
 * folders. A deep path folds its middle into "…". Crumbs take dropped rows, and every
 * folder in the path but the top one can be dragged onto a crumb further up.
 */
function FolderPath({
    crumbs,
    title,
    shared,
    rootId,
    workspaceId,
    dropOver,
    crumbName,
}: {
    crumbs: DriveNode[];
    title: string;
    shared: boolean;
    rootId: string;
    workspaceId: string;
    dropOver: string | null;
    crumbName: (crumb: DriveNode) => string;
}) {
    const above = crumbs.slice(0, -1);
    const current = crumbs.at(-1);
    const folded = above.length > 3 ? above.slice(1, -2) : [];
    const shown = above.length > 3 ? [above[0]!, null, ...above.slice(-2)] : above;
    const draggableCrumb = (crumb: DriveNode, index: number) =>
        index > 0 && crumb.workspaceId === workspaceId ? crumb.id : undefined;
    const crumbClass =
        '-mx-1.5 shrink-0 rounded-md px-1.5 py-0.5 text-lg font-semibold tracking-[-0.02em] text-foreground transition-colors hover:bg-muted sm:text-2xl';
    return (
        <nav aria-label="Folder path" className="flex h-11 min-w-0 items-center gap-1">
            {shared && (
                <>
                    <Link to="/app/shared" className={crumbClass}>
                        Shared with me
                    </Link>
                    <ChevronRightIcon
                        className="size-5 shrink-0 text-muted-foreground"
                        strokeWidth={2.2}
                        aria-hidden="true"
                    />
                </>
            )}
            {shown.map((crumb) => (
                <span key={crumb?.id ?? 'fold'} className="flex shrink-0 items-center gap-1">
                    {crumb ? (
                        <Link
                            {...folderLink(rootId, crumb.id)}
                            data-crumb-id={crumb.id}
                            data-crumb-drag={draggableCrumb(crumb, crumbs.indexOf(crumb))}
                            className={cn(
                                crumbClass,
                                dropOver === crumb.id &&
                                    'bg-accent text-accent-foreground outline-2 outline-primary',
                            )}
                        >
                            {crumbName(crumb)}
                        </Link>
                    ) : (
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                aria-label="More folders"
                                className={cn(crumbClass, 'cursor-pointer')}
                            >
                                …
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-48">
                                {folded.map((hidden) => (
                                    <DropdownMenuItem
                                        key={hidden.id}
                                        render={<Link {...folderLink(rootId, hidden.id)} />}
                                    >
                                        {hidden.name}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    <ChevronRightIcon
                        className="size-5 text-muted-foreground"
                        strokeWidth={2.2}
                        aria-hidden="true"
                    />
                </span>
            ))}
            <h1
                aria-current="page"
                data-crumb-drag={
                    current && crumbs.length > 1 && current.workspaceId === workspaceId
                        ? current.id
                        : undefined
                }
                className="min-w-0 truncate text-xl leading-tight font-extrabold tracking-[-0.03em] sm:text-[28px]"
            >
                {title || '…'}
            </h1>
        </nav>
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

/* A column's sort state; a second click flips the direction. Newest and largest come first on the first click. */
function sortProps(order: SortOrder, key: SortKey, onOrder: (order: SortOrder) => void) {
    const active = order.key === key;
    return {
        active,
        ascending: order.ascending,
        onClick: () =>
            onOrder(
                active ? { key, ascending: !order.ascending } : { key, ascending: key === 'name' },
            ),
    };
}
