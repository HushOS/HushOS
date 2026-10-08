import type { DriveNode } from '@hushos/drive/client';
import {
    CopyIcon,
    DownloadIcon,
    EllipsisIcon,
    EyeIcon,
    FlagIcon,
    FolderInputIcon,
    FolderPlusIcon,
    HistoryIcon,
    InfoIcon,
    ListChecksIcon,
    PencilIcon,
    Share2Icon,
    TagIcon,
    Trash2Icon,
    UserPlusIcon,
    type LucideIcon,
} from 'lucide-react';
import { RowMenuButton, SelectionAction, SelectionBar } from '@/components/drive/file-list';
import { keyLabel } from '@/components/drive/shortcuts';
import {
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
} from '@/components/ui/context-menu';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatBytes, nodeSize } from '@/lib/drive';
import { useSyncExternalStore } from 'react';

/*
 * What every list of items shares beyond selection itself: what a row's size
 * says, the row's menu (right-click and ⋯ alike), and the bar that acts on a
 * selection. Files and Home draw their rows from these, so an item offers the
 * same actions wherever it is listed.
 */

/* Whether there is room for the details panel beside the list; below this it is a dialog. */
export function useWideScreen() {
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

/* The store lost this file's bytes: the audit marked it, and the row says so instead of failing later. */
function unavailable(node: DriveNode) {
    return node.currentVersion?.objectStatus === 'missing';
}

const MISSING_HINT =
    'The stored copy of this file is missing. Upload it again, or move it to Trash.';

/* What a row's or tile's size line says. */
export function SizeText({ node, folderWord }: { node: DriveNode; folderWord: string }) {
    if (node.kind === 'folder') return <>{folderWord}</>;
    if (unavailable(node))
        return (
            <span className="font-semibold text-destructive" title={MISSING_HINT}>
                Missing
            </span>
        );
    return <>{formatBytes(nodeSize(node))}</>;
}

export type MenuEntry = {
    label: string;
    icon: LucideIcon;
    onSelect: () => void;
    shortcut?: string;
    destructive?: boolean;
};

export type NodeActions = {
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
};

/*
 * What a row or tile's menu offers, in groups: getting at it, organising it, what
 * it is, and Trash last on its own. The same order as the phones. `targets` is
 * the selection when the node is part of it.
 */
export function nodeEntries(
    node: DriveNode,
    targets: DriveNode[],
    actions: NodeActions,
): MenuEntry[][] {
    const { onTags, onShare, onSaveCopy, onReport } = actions;
    const many = targets.length > 1;
    const open: MenuEntry[] = [
        {
            label: node.kind === 'folder' ? 'Open' : 'Preview',
            icon: EyeIcon,
            onSelect: () => actions.onOpen(node),
            shortcut: keyLabel('Enter'),
        },
    ];
    if (onShare && !many)
        open.push({ label: 'Share', icon: UserPlusIcon, onSelect: () => onShare(node) });
    open.push({
        label: many ? `Download ${targets.length} items` : 'Download',
        icon: DownloadIcon,
        onSelect: () => actions.onDownload(targets),
        shortcut: 'D',
    });
    if (onSaveCopy)
        open.push({
            label: 'Save a copy to my files',
            icon: FolderPlusIcon,
            onSelect: () => onSaveCopy(targets),
        });
    const organise: MenuEntry[] = [];
    if (!many)
        organise.push({
            label: 'Rename',
            icon: PencilIcon,
            onSelect: () => actions.onRename(node),
            shortcut: 'F2',
        });
    organise.push(
        {
            label: 'Move',
            icon: FolderInputIcon,
            onSelect: () => actions.onMove(targets),
            shortcut: 'M',
        },
        {
            label: 'Copy',
            icon: CopyIcon,
            onSelect: () => actions.onCopy(targets),
            shortcut: 'C',
        },
    );
    if (onTags)
        organise.push({
            label: 'Tags',
            icon: TagIcon,
            onSelect: () => onTags(targets),
            shortcut: 'T',
        });
    const about: MenuEntry[] = [];
    if (!many && node.kind === 'file')
        about.push({
            label: 'Versions',
            icon: HistoryIcon,
            onSelect: () => actions.onVersions(node),
        });
    if (!many)
        about.push({
            label: 'Info',
            icon: InfoIcon,
            onSelect: () => actions.onInfo(node),
            shortcut: 'I',
        });
    const groups = [open, organise, about];
    if (onReport && !many)
        groups.push([{ label: 'Report', icon: FlagIcon, onSelect: () => onReport(node) }]);
    groups.push([
        {
            label: 'Move to Trash',
            icon: Trash2Icon,
            onSelect: () => actions.onTrash(targets),
            shortcut: keyLabel('Backspace'),
            destructive: true,
        },
    ]);
    return groups.filter((group) => group.length > 0);
}

/* The same entries as a right-click menu. */
export function NodeContextMenu({ entries }: { entries: MenuEntry[][] }) {
    return (
        <ContextMenuContent className="w-60">
            {entries.map((group, index) => (
                <ContextMenuGroup key={group[0]!.label}>
                    {index > 0 && <ContextMenuSeparator />}
                    {group.map((entry) => (
                        <ContextMenuItem
                            key={entry.label}
                            variant={entry.destructive ? 'destructive' : 'default'}
                            onClick={entry.onSelect}
                        >
                            <entry.icon aria-hidden="true" />
                            {entry.label}
                            {entry.shortcut && (
                                <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut>
                            )}
                        </ContextMenuItem>
                    ))}
                </ContextMenuGroup>
            ))}
        </ContextMenuContent>
    );
}

/* And as the row's ⋯ button, for people who never right-click. */
export function NodeMoreMenu({ name, entries }: { name: string; entries: MenuEntry[][] }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger render={<RowMenuButton aria-label={`More for ${name}`} />}>
                <EllipsisIcon className="size-5" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="w-60">
                {entries.map((group, index) => (
                    <DropdownMenuGroup key={group[0]!.label}>
                        {index > 0 && <DropdownMenuSeparator />}
                        {group.map((entry) => (
                            <DropdownMenuItem
                                key={entry.label}
                                variant={entry.destructive ? 'destructive' : 'default'}
                                onClick={entry.onSelect}
                            >
                                <entry.icon aria-hidden="true" />
                                {entry.label}
                                {entry.shortcut && (
                                    <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut>
                                )}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuGroup>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/*
 * The floating bar for a selection of items: the common actions as buttons, the
 * rest, and on a phone everything the bar has no room for, under More. `own` is
 * whether every selected item is one's own, which sharing and tags need.
 */
export function NodeSelectionBar({
    selection,
    own,
    allSelected,
    trashing,
    infoOpen,
    onShare,
    onDownload,
    onMove,
    onCopy,
    onRename,
    onTags,
    onTrash,
    onVersions,
    onInfo,
    onSelectAll,
    onClear,
}: {
    selection: DriveNode[];
    own: boolean;
    allSelected: boolean;
    trashing: boolean;
    /* The details panel is open beside the list, so Info puts it away. */
    infoOpen: boolean;
    onShare: (node: DriveNode) => void;
    onDownload: () => void;
    onMove: () => void;
    onCopy: () => void;
    onRename: (node: DriveNode) => void;
    onTags: () => void;
    onTrash: () => void;
    onVersions: (node: DriveNode) => void;
    onInfo: () => void;
    onSelectAll: () => void;
    onClear: () => void;
}) {
    const single = selection.length === 1 ? selection[0]! : null;
    /* What More holds on a wide screen: Versions, Info, Select all. */
    const moreWide = selection.length === 1 || !allSelected;
    return (
        <SelectionBar label={`${selection.length} selected`} onClear={onClear}>
            {single && own && (
                <SelectionAction
                    icon={Share2Icon}
                    label="Share"
                    className="max-sm:hidden"
                    onClick={() => onShare(single)}
                />
            )}
            <SelectionAction icon={DownloadIcon} label="Download" onClick={onDownload} />
            <SelectionAction icon={FolderInputIcon} label="Move" onClick={onMove} />
            <SelectionAction
                icon={CopyIcon}
                label="Copy"
                className="max-sm:hidden"
                onClick={onCopy}
            />
            {single && (
                <SelectionAction
                    icon={PencilIcon}
                    label="Rename"
                    className="max-sm:hidden"
                    onClick={() => onRename(single)}
                />
            )}
            {own && (
                <SelectionAction
                    icon={TagIcon}
                    label="Tags"
                    className="max-sm:hidden"
                    onClick={onTags}
                />
            )}
            <SelectionAction
                icon={Trash2Icon}
                label="Move to Trash"
                disabled={trashing}
                onClick={onTrash}
            />
            {/* The less common actions, and on a phone every action the bar has no room for. */}
            <DropdownMenu>
                <DropdownMenuTrigger
                    render={
                        <SelectionAction
                            icon={EllipsisIcon}
                            label="More actions"
                            iconOnly
                            // On a wide screen everything else has its own button; with
                            // nothing left to offer there, More would open empty.
                            className={moreWide ? undefined : 'sm:hidden'}
                        />
                    }
                />
                <DropdownMenuContent side="top" align="end" sideOffset={10} className="w-52">
                    {single && own && (
                        <DropdownMenuItem className="sm:hidden" onClick={() => onShare(single)}>
                            <Share2Icon aria-hidden="true" /> Share
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="sm:hidden" onClick={onCopy}>
                        <CopyIcon aria-hidden="true" /> Copy
                    </DropdownMenuItem>
                    {single && (
                        <DropdownMenuItem className="sm:hidden" onClick={() => onRename(single)}>
                            <PencilIcon aria-hidden="true" /> Rename
                        </DropdownMenuItem>
                    )}
                    {own && (
                        <DropdownMenuItem className="sm:hidden" onClick={onTags}>
                            <TagIcon aria-hidden="true" /> Tags
                        </DropdownMenuItem>
                    )}
                    {single?.kind === 'file' && (
                        <DropdownMenuItem onClick={() => onVersions(single)}>
                            <HistoryIcon aria-hidden="true" /> Versions
                        </DropdownMenuItem>
                    )}
                    {single && (
                        <DropdownMenuItem onClick={onInfo}>
                            <InfoIcon aria-hidden="true" />
                            {infoOpen ? 'Hide info' : 'Info'}
                        </DropdownMenuItem>
                    )}
                    {!allSelected && (
                        <DropdownMenuItem onClick={onSelectAll}>
                            <ListChecksIcon aria-hidden="true" /> Select all
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </SelectionBar>
    );
}
