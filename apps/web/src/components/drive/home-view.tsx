import { tagsOf, type DriveNode, type Tag } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useHotkey } from '@tanstack/react-hotkeys';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { cn } from 'cn';
import { CheckIcon, FileUpIcon, FolderPlusIcon } from 'lucide-react';
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { AccessCell, useAccessIndex } from '@/components/drive/access';
import { AddMenu } from '@/components/drive/add-menu';
import { CreateFolderDialog } from '@/components/drive/create-folder-dialog';
import { DetailsPanel } from '@/components/drive/details-panel';
import { useDrive } from '@/components/drive/drive-shell';
import {
    EmptyState,
    MarqueeBox,
    SelectableMark,
    SkeletonRows,
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
import { ShareDialog } from '@/components/drive/share-dialog';
import { Swatch } from '@/components/drive/tag-colour';
import { TagDialog } from '@/components/drive/tag-dialog';
import { TagStamps } from '@/components/drive/tag-stamp';
import { UploadInputs, useDropZone, type UploadPicker } from '@/components/drive/upload-controls';
import { VersionsDialog } from '@/components/drive/versions-dialog';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { toast } from '@/components/ui/toast';
import { downloadNodes } from '@/lib/downloads';
import {
    driveClient,
    driveError,
    folderQueryOptions,
    formatWhen,
    invalidateFolders,
    useCatalogueState,
} from '@/lib/drive';
import { usePaletteOpen } from '@/lib/palette';
import { previewKind } from '@/lib/previews';
import { cue } from '@/lib/sounds';
import { tagsQueryOptions } from '@/lib/tags';

/*
 * Home: where the app opens. What changed lately across every folder, from the
 * catalogue on this device, narrowed by a type or a tag. Rows select, open and offer the same menu as in a folder;
 * a folder opens where it lives, a file opens in the viewer over Home.
 */

const LIMIT = 50;

type TypeFilter = 'All' | 'Folders' | 'Images' | 'Videos' | 'Documents';
const TYPES: TypeFilter[] = ['All', 'Folders', 'Images', 'Videos', 'Documents'];
const DOCUMENT_KINDS = new Set(['pdf', 'office', 'markdown', 'text']);

function matchesType(node: DriveNode, type: TypeFilter) {
    switch (type) {
        case 'All':
            return true;
        case 'Folders':
            return node.kind === 'folder';
        case 'Images':
            return previewKind(node) === 'image';
        case 'Videos':
            return previewKind(node) === 'video';
        case 'Documents':
            return DOCUMENT_KINDS.has(previewKind(node));
    }
}

function folderLink(rootId: string, folderId: string) {
    return folderId === rootId
        ? ({ to: '/app/drive' } as const)
        : ({ to: '/app/drive/f/$folderId', params: { folderId } } as const);
}

/* When an item last changed in HushOS: an upload, a new version, a rename or a move. */
const changedAt = (node: DriveNode) => Date.parse(node.updatedAt) || 0;

export function HomeView() {
    const { rootId, workspaceId } = useDrive();
    const navigate = useNavigate();
    const router = useRouter();
    const queryClient = useQueryClient();
    const catalogue = useCatalogueState();
    const top = useQuery(folderQueryOptions(rootId));
    const registry = useQuery(tagsQueryOptions).data ?? null;
    const tags = registry?.tags ?? [];
    const [type, setType] = useState<TypeFilter>('All');
    const [tagId, setTagId] = useState<string | null>(null);
    // A tag removed elsewhere stops filtering here.
    const tag = tags.find((entry) => entry.id === tagId) ?? null;
    // Trashed from here: gone at once, before the change feed tells the catalogue.
    const [gone, setGone] = useState<Set<string>>(new Set());

    // The catalogue knows every folder; the top folder's own listing is fresher right
    // after something is added here, so it wins for the items it holds.
    const rows = useMemo(() => {
        const keep = (node: DriveNode) =>
            !gone.has(node.id) &&
            matchesType(node, type) &&
            (!tag || (registry !== null && tagsOf(registry, node.id).includes(tag.id)));
        const found = new Map<string, DriveNode>();
        for (const node of driveClient.recent(LIMIT, keep)) found.set(node.id, node);
        for (const node of top.data?.children ?? [])
            if (!node.trashedAt && keep(node)) found.set(node.id, node);
        return [...found.values()]
            .sort((a, b) => changedAt(b) - changedAt(a) || a.name.localeCompare(b.name))
            .slice(0, LIMIT);
        // The catalogue state stands in for the catalogue's contents, which it follows.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [catalogue, top.data, type, tag, registry, gone]);
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
    const picker = useRef<UploadPicker>(null);
    const [creating, setCreating] = useState(false);
    const [renaming, setRenaming] = useState<DriveNode | null>(null);
    const [moving, setMoving] = useState<DriveNode[] | null>(null);
    const [copying, setCopying] = useState<DriveNode[] | null>(null);
    const [versionsOf, setVersionsOf] = useState<DriveNode | null>(null);
    const [infoOf, setInfoOf] = useState<DriveNode | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const wide = useWideScreen();
    const [sharing, setSharing] = useState<DriveNode | null>(null);
    const [tagging, setTagging] = useState<DriveNode[] | null>(null);
    const [trashing, setTrashing] = useState(false);
    const paletteOpen = usePaletteOpen();
    const search = useSearch({ strict: false }) as { preview?: string };
    const pushedPreview = useRef(false);

    const selection = rows.filter((row) => selected.has(row.id));
    const single = selection.length === 1 ? selection[0]! : null;
    const allSelected = rows.length > 0 && selection.length === rows.length;
    const previewing = useMemo(
        () =>
            search.preview
                ? (rows.find((row) => row.id === search.preview && row.kind === 'file') ?? null)
                : null,
        [rows, search.preview],
    );
    const enabled = !(
        creating ||
        renaming !== null ||
        moving !== null ||
        copying !== null ||
        versionsOf !== null ||
        sharing !== null ||
        tagging !== null ||
        paletteOpen ||
        previewing !== null
    );

    const access = useAccessIndex(true);
    const inherited = (node: DriveNode) =>
        driveClient.ancestorsOf(node.id).some((ancestor) => access.has(ancestor.id));
    const location = (node: DriveNode) => {
        const chain = driveClient.ancestorsOf(node.id);
        if (!chain.length) return node.parentId === rootId ? 'My files' : undefined;
        return chain
            .map((folder) => (folder.parentId === null ? 'My files' : folder.name))
            .join(' / ');
    };
    const siblings = (node: DriveNode) =>
        node.parentId === rootId
            ? (top.data?.children ?? [])
            : node.parentId
              ? (driveClient.localListing(node.parentId)?.children ?? [])
              : [];

    function showPreview(node: DriveNode | null, replace = false) {
        if (node) {
            if (!replace) pushedPreview.current = true;
            void navigate({ to: '/app', search: { preview: node.id }, replace });
        } else if (pushedPreview.current) {
            pushedPreview.current = false;
            router.history.back();
        } else void navigate({ to: '/app', search: {}, replace: true });
    }
    function open(node: DriveNode) {
        if (node.kind === 'folder') void navigate(folderLink(rootId, node.id));
        else showPreview(node);
    }
    function showInfo(node: DriveNode) {
        if (wide) {
            setSelected(new Set([node.id]));
            setDetailsOpen(true);
        } else setInfoOf(node);
    }
    function toggleInfo() {
        if (wide && detailsOpen) setDetailsOpen(false);
        else if (selection.length === 1) showInfo(selection[0]!);
    }
    function download(nodes: DriveNode[]) {
        if (nodes.length) downloadNodes(nodes);
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
            const restored = new Set(nodes.slice(0, back).map((node) => node.id));
            setGone((current) => new Set([...current].filter((id) => !restored.has(id))));
            await invalidateFolders(queryClient, ...nodes.map((node) => node.parentId));
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
            setGone((current) => new Set([...current, ...done.map((node) => node.id)]));
            await invalidateFolders(queryClient, ...nodes.map((node) => node.parentId));
        }
    }

    useHotkey('F2', () => selection.length === 1 && setRenaming(selection[0]!), { enabled });
    useHotkey('M', () => selection.length > 0 && setMoving(selection), { enabled });
    useHotkey('C', () => selection.length > 0 && setCopying(selection), { enabled });
    useHotkey('D', () => download(selection), { enabled });
    useHotkey('I', toggleInfo, { enabled });
    useHotkey('Shift+N', () => setCreating(true), {
        enabled: enabled && Boolean(top.data?.folder),
    });
    useHotkey('T', () => selection.length > 0 && setTagging(selection), { enabled });
    useHotkey('Backspace', () => void trash(selection), { enabled });
    useHotkey('Delete', () => void trash(selection), { enabled });
    // Enter on a focused link or button is that control's, not the selection's.
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
    useHotkey('Mod+A', selectAll, { enabled, ignoreInputs: true });
    useHotkey('Escape', clear, { enabled });

    const actions: NodeActions = {
        onOpen: open,
        onDownload: download,
        onRename: setRenaming,
        onMove: setMoving,
        onCopy: setCopying,
        onVersions: setVersionsOf,
        onInfo: showInfo,
        // The catalogue holds only one's own items, so each can be tagged and shared.
        onTags: (nodes) => setTagging(nodes),
        onShare: setSharing,
        onSaveCopy: null,
        onReport: null,
        onTrash: (nodes) => void trash(nodes),
    };
    const entriesFor = (node: DriveNode) =>
        nodeEntries(
            node,
            selected.has(node.id) && selection.length > 1 ? selection : [node],
            actions,
        );

    // The whole page takes dropped files, into the top folder, as a folder page does.
    const folder = top.data?.folder;
    const over = useDropZone(dropRef, folder, top.data?.children ?? []);
    // A brand-new account: nothing in the top folder means nothing anywhere.
    const firstRun = top.data !== undefined && top.data.children.length === 0 && gone.size === 0;
    const building =
        catalogue.phase === 'idle' ||
        catalogue.phase === 'pulling' ||
        catalogue.phase === 'opening';
    const heading = tag ? tag.name : type === 'All' ? 'Recent' : `Recent ${type.toLowerCase()}`;

    return (
        <div
            ref={dropRef}
            className={cn('relative flex flex-[1_0_auto] flex-col', marquee && 'select-none')}
        >
            <MarqueeBox marquee={marquee} />
            {over && folder && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-3 top-0 bottom-3 z-20 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-[color-mix(in_oklab,var(--accent)_88%,transparent)] sm:inset-x-6 sm:bottom-6"
                >
                    <FileUpIcon className="size-8 text-primary" strokeWidth={1.8} />
                    <p className="px-6 text-center text-xl font-bold text-accent-foreground">
                        Drop to add to “My files”
                    </p>
                    <p className="text-sm text-accent-foreground">
                        Files and whole folders both work.
                    </p>
                </div>
            )}
            <PageHeader title="Home">
                {/* Adds into My files, as dropping onto Home does. */}
                {folder && <AddMenu picker={picker} onNewFolder={() => setCreating(true)} />}
            </PageHeader>
            {firstRun ? (
                <EmptyState
                    icon={FileUpIcon}
                    title="Nothing here yet"
                    body="Files you add or change show up here. Drop some anywhere on this page to start."
                    className="sm:pt-16"
                >
                    <Button onClick={() => picker.current?.pickFiles()}>
                        <FileUpIcon />
                        Upload files
                    </Button>
                    <Button variant="outline" onClick={() => setCreating(true)}>
                        <FolderPlusIcon />
                        New folder
                    </Button>
                </EmptyState>
            ) : (
                <>
                    {/* Recent is the page: its title first, then its own filters. */}
                    <h2 className="shrink-0 px-5 pb-3 text-lg leading-tight font-bold tracking-[-0.015em] sm:px-8 sm:text-[22px]">
                        {heading}
                    </h2>
                    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 pb-4 sm:px-8">
                        <TypeChips value={type} onChange={setType} />
                        {/* Hidden until there is a tag to choose. */}
                        {tags.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                                {tags.map((entry) => (
                                    <TagPill
                                        key={entry.id}
                                        tag={entry}
                                        selected={tag?.id === entry.id}
                                        onClick={() =>
                                            setTagId(tag?.id === entry.id ? null : entry.id)
                                        }
                                    />
                                ))}
                                <Link
                                    to="/app/tags"
                                    className="pl-1 text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                >
                                    Manage tags
                                </Link>
                            </div>
                        )}
                    </div>
                    <div className="flex min-h-0 flex-1">
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                            {rows.length === 0 &&
                                (building || top.isPending ? (
                                    <SkeletonRows rows={5} />
                                ) : (
                                    <FilterEmpty type={type} tagged={tag !== null} />
                                ))}
                            {rows.length > 0 && (
                                <table
                                    aria-label={heading}
                                    aria-multiselectable="true"
                                    className="w-full table-fixed border-collapse"
                                >
                                    <thead>
                                        <tr className="h-10 border-b border-rule text-xs font-semibold text-muted-foreground">
                                            <th scope="col" className="pl-5 text-left sm:pl-8">
                                                <span className="flex items-center gap-4">
                                                    <span className="w-10 shrink-0" />
                                                    Name
                                                </span>
                                            </th>
                                            <th
                                                scope="col"
                                                className="hidden w-[22%] text-left lg:table-cell"
                                            >
                                                Who can open
                                            </th>
                                            <th
                                                scope="col"
                                                className="hidden w-40 text-left sm:table-cell"
                                            >
                                                Changed
                                            </th>
                                            <th
                                                scope="col"
                                                className="w-24 pr-2 text-right sm:w-28"
                                            >
                                                Size
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
                                                                    if (!isSelected)
                                                                        select(node.id);
                                                                }}
                                                            />
                                                        }
                                                        className={cn(
                                                            'group/row h-14 cursor-default border-b border-rule select-none',
                                                            isSelected
                                                                ? 'bg-accent'
                                                                : 'hover:bg-muted',
                                                            focused === node.id &&
                                                                !isSelected &&
                                                                'ring-1 ring-ring ring-inset',
                                                        )}
                                                    >
                                                        <td className="min-w-0 p-0">
                                                            <span className="inline-flex max-w-full min-w-0 items-center gap-4">
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
                                                                        revealed={
                                                                            coarse &&
                                                                            selection.length > 0
                                                                        }
                                                                        onToggle={() =>
                                                                            toggle(node.id)
                                                                        }
                                                                    >
                                                                        <FileMark
                                                                            node={node}
                                                                            size="list"
                                                                        />
                                                                    </SelectableMark>
                                                                    <HomeName
                                                                        node={node}
                                                                        rootId={rootId}
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
                                                                    onEdit={() =>
                                                                        setTagging([node])
                                                                    }
                                                                    max={2}
                                                                />
                                                            </span>
                                                        </td>
                                                        <td className="hidden min-w-0 pr-4 lg:table-cell">
                                                            <AccessCell
                                                                access={access.get(node.id)}
                                                                inherited={inherited(node)}
                                                            />
                                                        </td>
                                                        <td className="hidden text-[13px] text-muted-foreground tabular-nums sm:table-cell">
                                                            {formatWhen(node.updatedAt)}
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
                            {catalogue.phase === 'failed' && (
                                <p className="px-5 py-3 text-[13px] text-muted-foreground sm:px-8">
                                    Only your top folder is shown. HushOS couldn’t look through your
                                    other folders in this browser, and tries again next time you
                                    open it.
                                </p>
                            )}
                        </div>
                        {wide && detailsOpen && (
                            <DetailsPanel
                                node={single}
                                location={single ? location(single) : undefined}
                                onTags={(node) => setTagging([node])}
                                onShare={setSharing}
                                inherited={single ? inherited(single) : false}
                                onClose={() => setDetailsOpen(false)}
                            />
                        )}
                    </div>
                </>
            )}

            {selection.length > 0 && (
                <NodeSelectionBar
                    selection={selection}
                    own={selection.every((node) => node.workspaceId === workspaceId)}
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
                <>
                    <UploadInputs
                        folder={folder}
                        known={top.data?.children ?? []}
                        handle={picker}
                    />
                    <CreateFolderDialog
                        parent={folder}
                        open={creating}
                        onOpenChange={setCreating}
                    />
                </>
            )}
            <RenameDialog
                node={renaming}
                siblings={renaming ? siblings(renaming) : []}
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
                location={infoOf ? location(infoOf) : undefined}
                onShare={(node) => {
                    setInfoOf(null);
                    setSharing(node);
                }}
                onTags={(node) => {
                    setInfoOf(null);
                    setTagging([node]);
                }}
                inherited={infoOf ? inherited(infoOf) : false}
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
            <Preview
                files={rows.filter((row) => row.kind === 'file')}
                current={previewing}
                onChange={(node) => showPreview(node, node !== null)}
                onDownload={(node) => download([node])}
                onShare={setSharing}
                access={(node) => (
                    <AccessCell access={access.get(node.id)} inherited={inherited(node)} />
                )}
            />
            <HotkeyHints />
        </div>
    );
}

/*
 * The name is the link: a folder opens where it lives, a file opens in the viewer
 * over Home. A modifier-click opens it in a new tab; selection stays on the row.
 */
function HomeName({
    node,
    rootId,
    onOpen,
}: {
    node: DriveNode;
    rootId: string;
    onOpen: () => void;
}) {
    const props = {
        draggable: false,
        className: cn('truncate hover:underline', node.openError && 'text-muted-foreground italic'),
        onClick: (event: MouseEvent) => {
            event.stopPropagation();
            if (!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) onOpen();
        },
        onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
        children: node.name,
    };
    return node.kind === 'folder' ? (
        <Link {...folderLink(rootId, node.id)} {...props} />
    ) : (
        <Link to="/app" search={{ preview: node.id }} {...props} />
    );
}

/* What to show: everything, or one kind. The chosen one is ink with a check. */
function TypeChips({
    value,
    onChange,
}: {
    value: TypeFilter;
    onChange: (value: TypeFilter) => void;
}) {
    return (
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
            <legend className="sr-only">Show</legend>
            {TYPES.map((filter) => (
                <button
                    key={filter}
                    type="button"
                    aria-pressed={value === filter}
                    onClick={() => onChange(filter)}
                    className={cn(
                        'flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10',
                        value === filter
                            ? 'border-ink bg-ink text-secondary-foreground'
                            : 'border-rule bg-card text-foreground hover:bg-muted',
                    )}
                >
                    {value === filter && filter !== 'All' && (
                        <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden="true" />
                    )}
                    {filter}
                </button>
            ))}
        </fieldset>
    );
}

/* A tag to narrow Recent by: its colour and name; chosen, a tint and a check. */
function TagPill({ tag, selected, onClick }: { tag: Tag; selected: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            aria-pressed={selected}
            onClick={onClick}
            className={cn(
                'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-10',
                selected
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-rule bg-card text-foreground hover:bg-muted',
            )}
        >
            {selected ? (
                <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden="true" />
            ) : (
                <Swatch colour={tag.colour} className="size-2 rounded-full" />
            )}
            <span className="max-w-32 truncate">{tag.name}</span>
        </button>
    );
}

/* A chip or a tag that matches nothing says so, in the words of what was chosen. */
function FilterEmpty({ type, tagged }: { type: TypeFilter; tagged: boolean }) {
    const kind = type === 'All' ? null : type.toLowerCase();
    if (tagged)
        return (
            <EmptyState
                title={kind ? `No ${kind} with this tag yet` : 'Nothing has this tag yet'}
                body="Select items and press T to tag them."
                className="sm:py-12"
            />
        );
    return (
        <EmptyState
            title={`No ${kind ?? 'recent files'} yet`}
            body={`${type === 'All' ? 'Files' : type} you add or change show up here.`}
            className="sm:py-12"
        />
    );
}
