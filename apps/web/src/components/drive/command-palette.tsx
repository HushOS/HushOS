import type { DriveNode } from '@hushos/drive/client';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useNavigate } from '@tanstack/react-router';
import {
    ArrowUpIcon,
    CopyIcon,
    DownloadIcon,
    FolderIcon,
    FolderPlusIcon,
    FolderInputIcon,
    HistoryIcon,
    HouseIcon,
    PencilIcon,
    Share2Icon,
    Trash2Icon,
    UploadIcon,
} from 'lucide-react';
import { Kbd } from '@/components/drive/hotkey-hints';
import { keyLabel, shortcuts } from '@/components/drive/shortcuts';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from '@/components/ui/command';

export type PaletteActions = {
    newFolder: () => void;
    rename: () => void;
    move: () => void;
    copy: () => void;
    versions: () => void;
    share: () => void;
    download: () => void;
    trash: () => void;
    upload?: () => void;
};

function Keys({ id }: { id: string }) {
    const shortcut = shortcuts.find((entry) => entry.id === id);
    if (!shortcut) return null;
    return (
        <CommandShortcut className="flex items-center gap-1">
            {shortcut.keys.map((key) => (
                <Kbd key={key}>{keyLabel(key)}</Kbd>
            ))}
        </CommandShortcut>
    );
}

/* Mod+K. Actions on the current folder and selection, then the folders in view. */
export function CommandPalette({
    folders,
    parentId,
    selection,
    actions,
    open,
    onOpenChange: setOpen,
}: {
    folders: DriveNode[];
    parentId: string | null;
    selection: DriveNode[];
    actions: PaletteActions;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const navigate = useNavigate();
    useHotkey('Mod+K', () => setOpen(!open));
    const run = (action: () => void) => () => {
        setOpen(false);
        action();
    };
    const one = selection.length === 1;
    const some = selection.length > 0;
    return (
        <CommandDialog open={open} onOpenChange={setOpen}>
            <CommandInput placeholder="Type a command or a folder name…" />
            <CommandList>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                <CommandGroup heading="Actions">
                    <CommandItem onSelect={run(actions.newFolder)}>
                        <FolderPlusIcon />
                        New folder
                        <Keys id="new-folder" />
                    </CommandItem>
                    {actions.upload && (
                        <CommandItem onSelect={run(actions.upload)}>
                            <UploadIcon />
                            Upload files
                        </CommandItem>
                    )}
                    <CommandItem disabled={!one} onSelect={run(actions.rename)}>
                        <PencilIcon />
                        Rename {one ? `“${selection[0]!.name}”` : ''}
                        <Keys id="rename" />
                    </CommandItem>
                    <CommandItem disabled={!some} onSelect={run(actions.move)}>
                        <FolderInputIcon />
                        Move {some ? `${selection.length} selected` : ''}
                        <Keys id="move" />
                    </CommandItem>
                    <CommandItem disabled={!some} onSelect={run(actions.copy)}>
                        <CopyIcon />
                        Copy {some ? `${selection.length} selected` : ''}
                        <Keys id="copy" />
                    </CommandItem>
                    <CommandItem disabled={!one} onSelect={run(actions.share)}>
                        <Share2Icon />
                        Share {one ? `“${selection[0]!.name}”` : ''}
                    </CommandItem>
                    <CommandItem
                        disabled={!one || selection[0]!.kind !== 'file'}
                        onSelect={run(actions.versions)}
                    >
                        <HistoryIcon />
                        Versions{' '}
                        {one && selection[0]!.kind === 'file' ? `of “${selection[0]!.name}”` : ''}
                    </CommandItem>
                    <CommandItem disabled={!some} onSelect={run(actions.download)}>
                        <DownloadIcon />
                        Download {some ? `${selection.length} selected` : ''}
                        <Keys id="download" />
                    </CommandItem>
                    <CommandItem disabled={!some} onSelect={run(actions.trash)}>
                        <Trash2Icon />
                        Move {some ? `${selection.length} selected` : ''} to trash
                        <Keys id="trash" />
                    </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Go to">
                    <CommandItem onSelect={run(() => void navigate({ to: '/app' }))}>
                        <HouseIcon />
                        Top folder
                    </CommandItem>
                    {parentId && (
                        <CommandItem
                            onSelect={run(
                                () =>
                                    void navigate({
                                        to: '/app/f/$folderId',
                                        params: { folderId: parentId },
                                    }),
                            )}
                        >
                            <ArrowUpIcon />
                            Enclosing folder
                        </CommandItem>
                    )}
                    <CommandItem onSelect={run(() => void navigate({ to: '/app/trash' }))}>
                        <Trash2Icon />
                        Trash
                    </CommandItem>
                </CommandGroup>
                {folders.length > 0 && (
                    <>
                        <CommandSeparator />
                        <CommandGroup heading="Folders here">
                            {folders.map((folder) => (
                                <CommandItem
                                    key={folder.id}
                                    value={`folder ${folder.name}`}
                                    onSelect={run(
                                        () =>
                                            void navigate({
                                                to: '/app/f/$folderId',
                                                params: { folderId: folder.id },
                                            }),
                                    )}
                                >
                                    <FolderIcon className="text-primary" />
                                    <span className="truncate">{folder.name}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </>
                )}
            </CommandList>
        </CommandDialog>
    );
}
