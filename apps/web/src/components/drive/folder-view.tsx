import {
    AccessBanner,
    AccessCell,
    AccessMarker,
    accessSentence,
    useAccessIndex,
} from '@/components/drive/access';
import { CreateFolderDialog } from '@/components/drive/create-folder-dialog';
import { DetailsPanel } from '@/components/drive/details-panel';
import { useDrive } from '@/components/drive/drive-shell';
import { AreaNotice } from '@/components/drive/area-notice';
import { useFamilyArea, waitsForKeyChange, type FamilyArea } from '@/components/drive/family-area';
import {
    CornerCheck,
    EmptyState,
    HiddenSortToggle,
    LIST_COLUMN,
    MarqueeBox,
    ROW_FOCUS,
    ROW_FOCUS_WITHIN,
    RowName,
    SelectableMark,
    SkeletonRows,
    SortButton,
    TILE_FOCUS,
    TILE_FOCUS_WITHIN,
    useHiddenColumn,
    useListSelection,
} from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { useIsMobile } from '@/hooks/use-mobile';
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
import { UnverifiedMark } from '@/components/drive/unverified-mark';
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
    clientFor,
    copyInto,
    displayName,
    driveError,
    driveKeys,
    folderQueryOptions,
    formatWhen,
    invalidateFolders,
    refreshFolders,
    refreshSharing,
    restoreNodes,
    trashNodes,
    refuseWrite,
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
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';

/*
 * One folder at a time: its path as the page title, the rows, and the actions.
 * Selection follows desktop conventions (click, Mod-click, Shift-click, a box
 * drawn on empty space, arrows), a double click or Enter opens, and every action
 * is also a keyboard shortcut and a palette entry.
 */

/* Where a folder's page is: one's own Drive, or a family folder's under its family's space. */
type Here = { rootId: string; groupId: string | null };
function folderLink(here: Here, folderId: string) {
    if (here.groupId)
        return {
            to: '/app/s/$groupId/f/$folderId',
            params: { groupId: here.groupId, folderId },
        } as const;
    return folderId === here.rootId
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
    here,
    folderId,
    onOpen,
}: {
    node: DriveNode;
    here: Here;
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
    if (here.groupId)
        return (
            <Link
                to="/app/s/$groupId/f/$folderId"
                params={{ groupId: here.groupId, folderId: target }}
                search={search}
                {...props}
            />
        );
    return target === here.rootId ? (
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
    const drive = useDrive();
    // A family folder's page (the family space), or this account's own Drive.
    const area = useFamilyArea();
    const rootId = area?.rootId ?? drive.rootId;
    const workspaceId = area?.workspaceId ?? drive.workspaceId;
    const here: Here = { rootId, groupId: area?.groupId ?? null };
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const listing = useQuery(folderQueryOptions(folderId, area?.workspaceId));
    const [order, setOrder] = useSortOrder();
    // The list's table, to tell when the column it is sorted by is hidden for room.
    const [table, setTable] = useState<HTMLTableElement | null>(null);
    const sortColumn = order.key === 'name' ? null : order.key;
    const sortHidden = useHiddenColumn(table, sortColumn);
    // Trashed from here, or put back by Undo: the list changes as each lands, ahead of the
    // listing, until the one refresh after the batch has the listing say so itself.
    const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
    const [back, setBack] = useState<ReadonlyMap<string, DriveNode>>(new Map());
    const rows = useMemo(() => {
        if (!listing.data) return [];
        const listed = new Map(listing.data.children.map((node) => [node.id, node]));
        for (const [id, node] of back) if (!listed.has(id)) listed.set(id, node);
        return sortNodesBy(
            [...listed.values()].filter((node) => !gone.has(node.id)),
            order,
        );
    }, [listing.data, order, gone, back]);
    const ids = useMemo(() => rows.map((row) => row.id), [rows]);
    const dropRef = useRef<HTMLDivElement>(null);
    const mobile = useIsMobile();
    const {
        coarse,
        selected,
        setSelected,
        marquee,
        select,
        toggle,
        clear,
        selectAll,
        moveFocus,
        focusShown,
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
    const registry = useQuery({ ...tagsQueryOptions, enabled: !area }).data ?? null;
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
    const page = folderLink(here, folderId);
    function showPreview(node: DriveNode | null, replace = false) {
        if (node) {
            if (!replace) pushedPreview.current = true;
            void navigate({ ...page, search: { preview: node.id }, replace });
        } else if (pushedPreview.current) {
            pushedPreview.current = false;
            router.history.back();
        } else void navigate({ ...page, search: {}, replace: true });
    }

    const selecting = selection.length > 0;
    const single = selection.length === 1 ? selection[0]! : null;
    const allSelected = rows.length > 0 && selection.length === rows.length;
    /*
     * Tags need this workspace's registry, so only items of one's own can be tagged; a family
     * folder's items are neither tagged nor shared from here yet.
     */
    const ownSelection =
        !area &&
        selection.length > 0 &&
        selection.every((node) => node.workspaceId === workspaceId);
    /*
     * In a family folder, nothing is changed or added unless this device may write there
     * (F9), and nothing is added to a folder a key change has not reached yet (D9).
     */
    const writable = !area || area.write === 'writable';
    const waiting = listing.data ? waitsForKeyChange(area, listing.data.folder) : false;
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
        if (node.kind === 'folder') void navigate(folderLink(here, node.id));
        else showPreview(node);
    }
    /* A re-encrypted copy of something shared with this person, into the top of their own files. */
    async function saveToMyDrive(nodes: DriveNode[]) {
        if (!nodes.length) return;
        try {
            const root = (await queryClient.fetchQuery(folderQueryOptions(drive.rootId))).folder;
            const made = await saveCopy(queryClient, nodes, root, 'drive');
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
    /*
     * The toast's Undo: puts back what moved, a few at a time, each row returning as it
     * lands. The toast itself says it is working, and then how it went.
     */
    async function undoTrash(nodes: DriveNode[], toastId: string) {
        const one = nodes.length === 1;
        toast.update(toastId, {
            type: 'loading',
            title: one ? `Putting “${nodes[0]!.name}” back` : `Putting ${nodes.length} items back`,
            description: undefined,
            actionProps: undefined,
            timeout: 0,
        });
        const { back: returned, error } = await restoreNodes(nodes, (landed) => {
            const ids = new Set(landed.map((node) => node.id));
            setGone((current) => new Set([...current].filter((id) => !ids.has(id))));
            setBack(
                (current) =>
                    new Map([...current, ...landed.map((node) => [node.id, node] as const)]),
            );
        });
        if (returned.length > 0) void refreshSharing(queryClient);
        if (returned.length === nodes.length) {
            cue('success');
            toast.update(toastId, {
                type: 'success',
                title: one ? `“${nodes[0]!.name}” is back` : `${returned.length} items are back`,
                timeout: 3_500,
            });
        } else {
            cue('error');
            toast.update(toastId, {
                type: 'error',
                title:
                    returned.length === 0
                        ? 'Couldn’t bring it back'
                        : `${returned.length} of ${nodes.length} are back`,
                description: `${driveError(error)} The rest are still in Trash.`,
                timeout: 8_000,
            });
        }
        // One refresh for the whole batch, in the background; then the listing holds them itself.
        const ids = new Set(returned.map((node) => node.id));
        void refreshFolders(queryClient, folderId).then(() =>
            setBack((current) => new Map([...current].filter(([id]) => !ids.has(id)))),
        );
    }
    async function trash(nodes: DriveNode[]) {
        if (!nodes.length || trashing) return;
        setTrashing(true);
        let went: string[] = [];
        try {
            const result = await trashNodes(nodes, (ids) => {
                setGone((current) => new Set([...current, ...ids]));
                setBack((current) => new Map([...current].filter(([id]) => !ids.includes(id))));
            });
            const { moved, error } = result;
            went = result.gone;
            // Everything picked is in the trash, itself or inside a folder that went.
            if (went.length === nodes.length) {
                cue('droplet');
                const id = toast.add({
                    type: 'success',
                    title:
                        nodes.length === 1
                            ? `“${nodes[0]!.name}” moved to Trash`
                            : `${nodes.length} items moved to Trash`,
                    description:
                        nodes.length === 1
                            ? 'It stays in Trash for 30 days.'
                            : 'They stay in Trash for 30 days.',
                    timeout: 8_000,
                    actionProps: { children: 'Undo', onClick: () => void undoTrash(moved, id) },
                });
            } else {
                cue('error');
                const id = toast.add({
                    type: 'error',
                    title:
                        moved.length === 0
                            ? 'Couldn’t move to Trash'
                            : `${went.length} of ${nodes.length} moved to Trash`,
                    description: driveError(error),
                    ...(moved.length > 0 && {
                        timeout: 8_000,
                        actionProps: {
                            children: 'Undo',
                            onClick: () => void undoTrash(moved, id),
                        },
                    }),
                });
            }
        } finally {
            setTrashing(false);
            // One refresh for the whole batch, in the background: the rows have already gone,
            // and once it lands the listing leaves them out itself.
            const ids = new Set(went);
            void refreshFolders(queryClient, folderId).then(() =>
                setGone((current) => new Set([...current].filter((id) => !ids.has(id)))),
            );
        }
    }

    // Nothing else acts on a selection while part of it is on its way to the trash.
    const idle = enabled && !trashing;
    useHotkey('Shift+N', () => canMakeFolder && setCreating(true), { enabled });
    useHotkey('F2', () => writable && selection.length === 1 && setRenaming(selection[0]!), {
        enabled: idle,
    });
    useHotkey('M', () => writable && selection.length > 0 && setMoving(selection), {
        enabled: idle,
    });
    useHotkey('C', () => writable && selection.length > 0 && setCopying(selection), {
        enabled: idle,
    });
    useHotkey('D', () => download(selection), { enabled: idle });
    useHotkey('I', toggleInfo, { enabled });
    useHotkey('T', () => ownSelection && setTagging(selection), { enabled: idle });
    useHotkey('Backspace', () => writable && void trash(selection), { enabled });
    useHotkey('Delete', () => writable && void trash(selection), { enabled });
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
        crumb.parentId === null && !area && crumb.workspaceId === workspaceId
            ? 'My files'
            : crumb.name;
    const shared = crumbs.length > 0 && crumbs[0]!.workspaceId !== workspaceId;
    // Without a Who can open column (a family or shared folder), Changed and Size keep their room longer.
    const changedColumn = !shared && !area ? LIST_COLUMN.changed : LIST_COLUMN.changedAlone;
    const sizeColumn = !shared && !area ? LIST_COLUMN.size : LIST_COLUMN.sizeAlone;
    /*
     * Whether things may be added here: one's own folder, or a family folder this device may
     * write. While a key change has yet to reach it, uploads wait in the queue (D9); anything
     * else added says so and waits for the person.
     */
    const canAdd = !shared && writable;
    /* A new folder is wrapped under this one's key, so it waits for the key change too. */
    const canMakeFolder = canAdd && !waiting;
    const title = folder ? crumbName(folder) : crumbs.length ? crumbName(crumbs.at(-1)!) : '';
    // Who can open what, from everything this person shares; a folder in the path that is
    // shared means everything here is open to the same people. A family folder is open to
    // the family, which its space page says.
    const access = useAccessIndex(!shared && !area);
    const inheritedFrom = [...crumbs].reverse().find((crumb) => access.has(crumb.id)) ?? null;
    const mounts = useQuery({ ...sharedQueryOptions, enabled: shared });
    const sharedBy = shared
        ? (mounts.data?.find((mount) => mount.node.id === crumbs[0]?.id) ?? null)
        : null;
    // The whole view takes drops, not only the list: an empty folder has no list.
    const over = useDropZone(dropRef, canAdd ? folder : undefined, rows);
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
                newFolder: () => canMakeFolder && setCreating(true),
                upload: () => canAdd && picker.current?.pickFiles(),
                // Like the hotkeys: nothing acts on a selection while part of it is being trashed.
                rename: () =>
                    !trashing && writable && selection.length === 1 && setRenaming(selection[0]!),
                move: () => !trashing && writable && selection.length > 0 && setMoving(selection),
                copy: () => !trashing && writable && selection.length > 0 && setCopying(selection),
                versions: () =>
                    !trashing &&
                    selection.length === 1 &&
                    selection[0]!.kind === 'file' &&
                    setVersionsOf(selection[0]!),
                share: () =>
                    !trashing &&
                    ownSelection &&
                    selection.length === 1 &&
                    setSharing(selection[0]!),
                tags: () => !trashing && ownSelection && setTagging(selection),
                download: () => !trashing && paletteHandlers.current.download(selection),
                trash: () => writable && void paletteHandlers.current.trash(selection),
            },
        });
        // `setSelected` is a state setter and never changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        trashing,
        rows,
        folder,
        selection,
        ownSelection,
        view,
        workspaceId,
        canAdd,
        canMakeFolder,
        writable,
        area,
    ]);
    useEffect(() => () => lendPaletteContext(null), []);

    /* Moves dragged rows into a folder row or a crumb further up; with Alt held, copies them. */
    async function moveTo(dragged: string[], destination: DriveNode, copy = false) {
        const nodes = rows.filter((row) => dragged.includes(row.id) && row.id !== destination.id);
        if (!nodes.length || movingByDrag || !writable) return;
        const refused = refuseWrite(destination);
        if (refused) {
            toast.add({ type: 'error', title: 'Couldn’t move', description: refused });
            return;
        }
        setMovingByDrag(true);
        const where =
            destination.parentId === null ? displayName(destination) : `“${destination.name}”`;
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
                done.push(await clientFor(node.workspaceId).move(node, destination));
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
                await clientFor(node.workspaceId).move(node, origin);
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
        if (!node || movingByDrag || !writable) return;
        const refused = refuseWrite(destination);
        if (refused) {
            toast.add({ type: 'error', title: 'Couldn’t move', description: refused });
            return;
        }
        setMovingByDrag(true);
        const where =
            destination.parentId === null ? displayName(destination) : `“${destination.name}”`;
        try {
            await clientFor(node.workspaceId).move(node, destination);
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
    const dragState = useRef({ selected, select, moveTo, moveCrumb, rows, crumbs });
    useEffect(() => {
        dragState.current = { selected, select, moveTo, moveCrumb, rows, crumbs };
    });
    /*
     * Registered again whenever the rows or the path change, but not during a drag: a
     * refetch mid-drag hands back new objects for the same items, and tearing the
     * handlers down then cancels the drag, so the drop lands on nothing. The drop's
     * check reads the latest path, and the handlers catch up once the drag ends.
     */
    const [dragging, setDragging] = useState(false);
    const registered = useRef<(() => void) | null>(null);
    useEffect(() => () => registered.current?.(), []);
    useEffect(() => {
        if (dragging) return;
        registered.current?.();
        registered.current = null;
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
                        const path = dragState.current.crumbs;
                        const from = path.findIndex((crumb) => crumb.id === source.data.id);
                        const to = path.findIndex((crumb) => crumb.id === destination.id);
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
        registered.current = combine(...cleanups);
    }, [rows, crumbs, view, dragging]);

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
                onDragStart: ({ source, location }) => {
                    setDragging(true);
                    setGhost({
                        x: location.current.input.clientX,
                        y: location.current.input.clientY,
                        ids:
                            source.data.type === 'drive-crumb'
                                ? [source.data.id as string]
                                : (source.data.ids as string[]),
                        copy: source.data.type === 'drive-nodes' && location.current.input.altKey,
                    });
                },
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
                onDrop: () => {
                    setGhost(null);
                    setDragging(false);
                },
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
    /*
     * A node's menu: its own actions, or the selection's when it is part of one. A family
     * folder's items are copied within it (judged by the family) but not shared, tagged or
     * reported from here, and nothing in one is changed while this device may not write there.
     */
    function entriesFor(node: DriveNode) {
        const own = !area && node.workspaceId === workspaceId;
        const isSelected = selected.has(node.id);
        return nodeEntries(node, isSelected && selection.length > 1 ? selection : [node], {
            ...actions,
            onTags: own ? actions.onTags : null,
            onShare: own ? actions.onShare : null,
            onSaveCopy: own || area ? null : actions.onSaveCopy,
            onReport: own || area ? null : actions.onReport,
            onCopy: writable ? actions.onCopy : null,
            onRename: writable ? actions.onRename : null,
            onMove: writable ? actions.onMove : null,
            onTrash: writable ? actions.onTrash : null,
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
                <div className="flex min-w-0 items-center gap-3">
                    <FolderPath
                        crumbs={crumbs}
                        title={title}
                        shared={shared}
                        here={here}
                        area={area}
                        workspaceId={workspaceId}
                        dropOver={dropOver}
                        crumbName={crumbName}
                    />
                    {/* Beside the path where there is room for both; narrower, the banner below says it. */}
                    {inheritedFrom && (
                        <AccessMarker
                            access={access.get(inheritedFrom.id)!}
                            via={inheritedFrom.id === folder?.id ? null : crumbName(inheritedFrom)}
                            onOpen={() => setSharing(inheritedFrom)}
                            className="max-lg:hidden"
                        />
                    )}
                </div>
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
                                className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                            >
                                <Icon className="size-4" aria-hidden="true" />
                            </button>
                        ))}
                    </fieldset>
                    {folder && canAdd && (
                        <AddMenu
                            picker={picker}
                            onNewFolder={canMakeFolder ? () => setCreating(true) : null}
                        />
                    )}
                    {folder && <UploadInputs folder={folder} known={rows} handle={picker} />}
                </div>
            </div>
            {inheritedFrom && (
                <div className="lg:hidden">
                    <AccessBanner
                        text={accessSentence(access.get(inheritedFrom.id)!)}
                        action="Manage access"
                        onAction={() => setSharing(inheritedFrom)}
                    />
                </div>
            )}
            {area && <AreaNotice area={area} waiting={waiting} />}
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
                        className="@container/list flex min-h-0 min-w-0 flex-1 flex-col"
                    >
                        {listing.isPending && <SkeletonRows />}
                        {listing.isError && (
                            <EmptyState
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
                                title="Nothing here yet"
                                body={
                                    !canAdd
                                        ? 'When something is added to this folder, it shows up here.'
                                        : 'Drop files or folders anywhere on this page, or use Add.'
                                }
                            >
                                {canAdd && (
                                    <>
                                        {/* Outline: the header's Add is the page's one blue button. */}
                                        <Button
                                            variant="outline"
                                            onClick={() => picker.current?.pickFiles()}
                                        >
                                            <FileUpIcon />
                                            Upload files
                                        </Button>
                                        {canMakeFolder && (
                                            <Button
                                                variant="outline"
                                                onClick={() => setCreating(true)}
                                            >
                                                <FolderPlusIcon />
                                                New folder
                                            </Button>
                                        )}
                                    </>
                                )}
                            </EmptyState>
                        )}
                        {listing.data && rows.length > 0 && view === 'list' && (
                            <table
                                ref={setTable}
                                aria-label={`Contents of ${title || 'folder'}`}
                                aria-multiselectable="true"
                                className="w-full table-fixed border-collapse"
                            >
                                <thead>
                                    <tr className="h-10 border-b border-rule">
                                        <th
                                            scope="col"
                                            // While the sorted column is hidden, its order is said here.
                                            aria-sort={
                                                sortHidden
                                                    ? ariaSort(order, order.key)
                                                    : ariaSort(order, 'name')
                                            }
                                            className="pl-4 text-left md:pl-8"
                                        >
                                            <span className="flex items-center gap-3 md:gap-4">
                                                <span className="w-8 shrink-0 md:w-10" />
                                                <SortButton
                                                    label="Name"
                                                    {...sortProps(order, 'name', setOrder)}
                                                />
                                                {sortHidden && sortColumn && (
                                                    <span className="ml-auto pr-2">
                                                        <HiddenSortToggle
                                                            label={
                                                                sortColumn === 'size'
                                                                    ? 'size'
                                                                    : 'date changed'
                                                            }
                                                            ascending={order.ascending}
                                                            order={
                                                                sortColumn === 'size'
                                                                    ? order.ascending
                                                                        ? 'smallest first'
                                                                        : 'largest first'
                                                                    : order.ascending
                                                                      ? 'oldest first'
                                                                      : 'newest first'
                                                            }
                                                            onClick={() =>
                                                                setOrder({
                                                                    key: sortColumn,
                                                                    ascending: !order.ascending,
                                                                })
                                                            }
                                                        />
                                                    </span>
                                                )}
                                            </span>
                                        </th>
                                        {!shared && !area && (
                                            <th
                                                scope="col"
                                                className={cn(
                                                    LIST_COLUMN.access,
                                                    'w-44 text-left text-xs font-semibold text-muted-foreground',
                                                )}
                                            >
                                                Who can open
                                            </th>
                                        )}
                                        <th
                                            scope="col"
                                            data-column="modified"
                                            aria-sort={ariaSort(order, 'modified')}
                                            className={cn(changedColumn, 'w-40 text-left')}
                                        >
                                            <SortButton
                                                label="Changed"
                                                {...sortProps(order, 'modified', setOrder)}
                                            />
                                        </th>
                                        <th
                                            scope="col"
                                            data-column="size"
                                            aria-sort={ariaSort(order, 'size')}
                                            className={cn(sizeColumn, 'w-28 pr-2 text-right')}
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
                                                        ROW_FOCUS_WITHIN,
                                                        dropOver === node.id
                                                            ? 'bg-accent ring-2 ring-primary ring-inset'
                                                            : isSelected
                                                              ? 'bg-accent'
                                                              : 'hover:bg-muted',
                                                        focusShown(node.id) && ROW_FOCUS,
                                                    )}
                                                >
                                                    <td className="min-w-0 p-0">
                                                        <RowName
                                                            node={node}
                                                            onSelect={(event) =>
                                                                select(node.id, event)
                                                            }
                                                            thumbnail={
                                                                <SelectableMark
                                                                    name={node.name}
                                                                    checked={isSelected}
                                                                    revealed={coarse && selecting}
                                                                    onToggle={() => toggle(node.id)}
                                                                >
                                                                    <FileMark
                                                                        node={node}
                                                                        size={
                                                                            mobile ? 'row' : 'list'
                                                                        }
                                                                    />
                                                                </SelectableMark>
                                                            }
                                                            name={
                                                                <NodeName
                                                                    node={node}
                                                                    here={here}
                                                                    folderId={folderId}
                                                                    onOpen={markOpened(node)}
                                                                />
                                                            }
                                                            tags={
                                                                tagIds(node).length > 0 && (
                                                                    <TagStamps
                                                                        tagIds={tagIds(node)}
                                                                        registry={registry}
                                                                        itemName={node.name}
                                                                        onEdit={
                                                                            node.workspaceId ===
                                                                            workspaceId
                                                                                ? () =>
                                                                                      setTagging([
                                                                                          node,
                                                                                      ])
                                                                                : undefined
                                                                        }
                                                                        max={2}
                                                                    />
                                                                )
                                                            }
                                                        />
                                                    </td>
                                                    {!shared && !area && (
                                                        <td
                                                            className={cn(
                                                                LIST_COLUMN.access,
                                                                'min-w-0 pr-4',
                                                            )}
                                                        >
                                                            <AccessCell
                                                                access={access.get(node.id)}
                                                                inherited={inheritedFrom !== null}
                                                            />
                                                        </td>
                                                    )}
                                                    <td
                                                        className={cn(
                                                            changedColumn,
                                                            'text-[13px] text-muted-foreground tabular-nums',
                                                        )}
                                                    >
                                                        {formatWhen(
                                                            node.metadata?.modified ??
                                                                node.updatedAt,
                                                        )}
                                                    </td>
                                                    <td
                                                        className={cn(
                                                            sizeColumn,
                                                            'pr-2 text-right text-[13px] text-muted-foreground tabular-nums',
                                                        )}
                                                    >
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
                                                    TILE_FOCUS_WITHIN,
                                                    dropOver === node.id || isSelected
                                                        ? 'bg-accent ring-2 ring-primary ring-inset'
                                                        : 'hover:bg-muted',
                                                    focusShown(node.id) && TILE_FOCUS,
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    aria-label={node.name}
                                                    aria-pressed={isSelected}
                                                    data-row-name
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
                                                                here={here}
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
                                                <UnverifiedMark
                                                    node={node}
                                                    variant="icon"
                                                    className="absolute top-3.5 right-3.5 bg-card shadow-md hover:bg-card"
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
                        {canAdd && (
                            <>
                                <ContextMenuItem
                                    disabled={!canMakeFolder}
                                    onClick={() => setCreating(true)}
                                >
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
                            !area && single?.workspaceId === workspaceId
                                ? (node) => setTagging([node])
                                : undefined
                        }
                        onShare={
                            !area && single?.workspaceId === workspaceId ? setSharing : undefined
                        }
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
                    onMove={writable ? () => setMoving(selection) : null}
                    onCopy={writable ? () => setCopying(selection) : null}
                    onRename={writable ? setRenaming : null}
                    onTags={() => setTagging(selection)}
                    onTrash={writable ? () => void trash(selection) : null}
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
                writable={writable}
                open={versionsOf !== null}
                onOpenChange={(open) => !open && setVersionsOf(null)}
            />
            <InfoDialog
                node={infoOf}
                location={crumbs.map(crumbName).join(' / ')}
                onShare={
                    !area && infoOf && infoOf.workspaceId === workspaceId
                        ? (node) => {
                              setInfoOf(null);
                              setSharing(node);
                          }
                        : undefined
                }
                onTags={
                    !area && infoOf && infoOf.workspaceId === workspaceId
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
                onShare={!area && folder?.workspaceId === workspaceId ? setSharing : undefined}
                access={
                    shared || area
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
            data-drag-card
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
 * folders. A deep path folds its middle into "…". Where the row is short of room
 * the folders above give it up first, down to a few letters each, and on a phone a
 * path with more than one folder above folds them all into "…", so the heading that
 * says where you are is the last thing to be cut. Crumbs take dropped rows, and every
 * folder in the path but the top one can be dragged onto a crumb further up.
 */
function FolderPath({
    crumbs,
    title,
    shared,
    here,
    area,
    workspaceId,
    dropOver,
    crumbName,
}: {
    crumbs: DriveNode[];
    title: string;
    shared: boolean;
    here: Here;
    area: FamilyArea | null;
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
        '-mx-1.5 min-w-0 truncate rounded-md px-1.5 py-0.5 text-lg font-semibold tracking-[-0.02em] text-foreground transition-colors hover:bg-muted sm:text-2xl';
    // The "…" menus: a 44px target on touch, as every control there.
    const foldClass =
        'inline-flex shrink-0 cursor-pointer items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11';
    // On a phone, two or more places above fold into one "…" menu holding them all.
    const fold = (area ? 1 : 0) + (shared ? 1 : 0) + above.length > 1;
    // Each folder above gives up its room before the heading loses a pixel, down to about three
    // letters (a mere hundred times faster still cost the heading a fraction, enough for its
    // ellipsis).
    const aboveClass = cn(
        'flex min-w-[3.25rem] shrink-[100000] items-center gap-1',
        fold && 'max-sm:hidden',
    );
    const chevron = (
        <ChevronRightIcon
            className="size-5 shrink-0 text-muted-foreground"
            strokeWidth={2.2}
            aria-hidden="true"
        />
    );
    return (
        <nav aria-label="Folder path" className="flex h-11 min-w-0 items-center gap-1">
            {fold && (
                <span className="flex shrink-0 items-center gap-1 sm:hidden">
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            aria-label="Folders above"
                            className={cn(crumbClass, foldClass)}
                        >
                            …
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-48">
                            {area && (
                                <DropdownMenuItem
                                    render={
                                        <Link
                                            to="/app/s/$groupId"
                                            params={{ groupId: area.groupId }}
                                        />
                                    }
                                >
                                    {area.family}
                                </DropdownMenuItem>
                            )}
                            {shared && (
                                <DropdownMenuItem render={<Link to="/app/shared" />}>
                                    Shared with me
                                </DropdownMenuItem>
                            )}
                            {above.map((crumb) => (
                                <DropdownMenuItem
                                    key={crumb.id}
                                    render={<Link {...folderLink(here, crumb.id)} />}
                                >
                                    {crumbName(crumb)}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {chevron}
                </span>
            )}
            {area && (
                <span className={aboveClass}>
                    <Link
                        to="/app/s/$groupId"
                        params={{ groupId: area.groupId }}
                        title={area.family}
                        className={crumbClass}
                    >
                        {area.family}
                    </Link>
                    <ChevronRightIcon
                        className="size-5 shrink-0 text-muted-foreground"
                        strokeWidth={2.2}
                        aria-hidden="true"
                    />
                </span>
            )}
            {shared && (
                <span className={aboveClass}>
                    <Link to="/app/shared" title="Shared with me" className={crumbClass}>
                        Shared with me
                    </Link>
                    <ChevronRightIcon
                        className="size-5 shrink-0 text-muted-foreground"
                        strokeWidth={2.2}
                        aria-hidden="true"
                    />
                </span>
            )}
            {shown.map((crumb) => (
                <span
                    key={crumb?.id ?? 'fold'}
                    className={
                        crumb
                            ? aboveClass
                            : cn('flex shrink-0 items-center gap-1', fold && 'max-sm:hidden')
                    }
                >
                    {crumb ? (
                        <Link
                            {...folderLink(here, crumb.id)}
                            data-crumb-id={crumb.id}
                            data-crumb-drag={draggableCrumb(crumb, crumbs.indexOf(crumb))}
                            title={crumbName(crumb)}
                            className={cn(
                                crumbClass,
                                dropOver === crumb.id &&
                                    'bg-accent text-accent-foreground outline-2 outline-solid outline-primary',
                            )}
                        >
                            {crumbName(crumb)}
                        </Link>
                    ) : (
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                aria-label="More folders"
                                className={cn(crumbClass, foldClass)}
                            >
                                …
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-48">
                                {folded.map((hidden) => (
                                    <DropdownMenuItem
                                        key={hidden.id}
                                        render={<Link {...folderLink(here, hidden.id)} />}
                                    >
                                        {hidden.name}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    <ChevronRightIcon
                        className="size-5 shrink-0 text-muted-foreground"
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
