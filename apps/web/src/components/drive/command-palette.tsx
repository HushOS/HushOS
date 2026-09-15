import { useHotkey } from '@tanstack/react-hotkeys';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import {
    ArrowUpIcon,
    CopyIcon,
    DownloadIcon,
    FolderIcon,
    FolderPlusIcon,
    FolderInputIcon,
    HistoryIcon,
    HouseIcon,
    LayoutGridIcon,
    ListIcon,
    LockKeyholeIcon,
    LogOutIcon,
    MonitorIcon,
    MoonIcon,
    PencilIcon,
    Share2Icon,
    SquareCheckIcon,
    SquareIcon,
    SunIcon,
    Trash2Icon,
    UploadIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { account, operator, workspace } from '@/components/app-sidebar';
import { Kbd } from '@/components/drive/hotkey-hints';
import { keyLabel, shortcuts } from '@/components/drive/shortcuts';
import { useTheme } from '@/components/theme-provider';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { driveError } from '@/lib/drive';
import { setPaletteOpen, usePaletteState } from '@/lib/palette';
import { useBillingEnabled } from '@/lib/queries';
import { forgetSession } from '@/lib/session';
import { cue } from '@/lib/sounds';
import { emptyTrashAll } from '@/lib/trash';

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

/*
 * Mod+K, anywhere under /app: what can be done here (the folder view lends its
 * actions and the folders in view while it is on screen), where to go, the
 * trash, and this device. Anything that destroys or shuts something asks first.
 */
export function CommandCenter({ user }: { user: { id: string; role: string } }) {
    const { open, context } = usePaletteState();
    const navigate = useNavigate();
    const router = useRouter();
    const queryClient = useQueryClient();
    const billing = useBillingEnabled();
    const { theme, setTheme } = useTheme();
    const unlocked = useStore(authClient.store, (state) => state.unlockedUserId) === user.id;
    const [confirm, setConfirm] = useState<'empty-trash' | 'lock' | null>(null);
    const [busy, setBusy] = useState(false);
    useHotkey('Mod+K', () => setPaletteOpen(!open));
    const run = (action: () => void) => () => {
        setPaletteOpen(false);
        action();
    };
    const go = (to: string, search?: Record<string, string>) =>
        run(() => void navigate({ to, search } as never));
    const selection = context?.selection ?? [];
    const one = selection.length === 1;
    const some = selection.length > 0;

    async function emptyTrash() {
        setBusy(true);
        try {
            const purged = await emptyTrashAll(queryClient, user.id);
            cue('droplet');
            toast.add({
                type: 'success',
                title: purged === 1 ? 'Trash emptied: 1 item' : `Trash emptied: ${purged} items`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not empty the trash',
                description: driveError(error),
            });
        } finally {
            setBusy(false);
            setConfirm(null);
        }
    }
    async function lock() {
        setConfirm(null);
        try {
            await authClient.lock();
            cue('droplet');
        } catch {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not lock this device',
                description: 'Saved device access could not be removed. Try signing out.',
            });
        }
    }
    async function signOut() {
        try {
            await authClient.logout();
            forgetSession(queryClient, false);
            await router.navigate({ to: '/login' });
            queryClient.clear();
        } catch {
            cue('error');
            toast.add({ type: 'error', title: 'Could not sign out. Please try again.' });
        }
    }

    const places = [
        ...workspace,
        ...account.filter((item) => !item.billing || billing),
        ...(user.role === 'admin' ? operator.filter((item) => !item.billing || billing) : []),
    ];
    return (
        <>
            <CommandDialog open={open} onOpenChange={setPaletteOpen}>
                <CommandInput
                    // No "name" in here: password managers read that word as a username field.
                    placeholder="Type a command, a place, or a folder…"
                    name="command"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    data-form-type="other"
                />
                <CommandList>
                    <CommandEmpty>Nothing matches.</CommandEmpty>
                    {context && (
                        <>
                            <CommandGroup heading="Here">
                                <CommandItem onSelect={run(context.actions.newFolder)}>
                                    <FolderPlusIcon />
                                    New folder
                                    <Keys id="new-folder" />
                                </CommandItem>
                                {context.actions.upload && (
                                    <CommandItem onSelect={run(context.actions.upload)}>
                                        <UploadIcon />
                                        Upload files
                                    </CommandItem>
                                )}
                                <CommandItem disabled={!one} onSelect={run(context.actions.rename)}>
                                    <PencilIcon />
                                    Rename {one ? `“${selection[0]!.name}”` : ''}
                                    <Keys id="rename" />
                                </CommandItem>
                                <CommandItem disabled={!some} onSelect={run(context.actions.move)}>
                                    <FolderInputIcon />
                                    Move {some ? `${selection.length} selected` : ''}
                                    <Keys id="move" />
                                </CommandItem>
                                <CommandItem disabled={!some} onSelect={run(context.actions.copy)}>
                                    <CopyIcon />
                                    Copy {some ? `${selection.length} selected` : ''}
                                    <Keys id="copy" />
                                </CommandItem>
                                <CommandItem disabled={!one} onSelect={run(context.actions.share)}>
                                    <Share2Icon />
                                    Share {one ? `“${selection[0]!.name}”` : ''}
                                </CommandItem>
                                <CommandItem
                                    disabled={!one || selection[0]!.kind !== 'file'}
                                    onSelect={run(context.actions.versions)}
                                >
                                    <HistoryIcon />
                                    Versions{' '}
                                    {one && selection[0]!.kind === 'file'
                                        ? `of “${selection[0]!.name}”`
                                        : ''}
                                </CommandItem>
                                <CommandItem
                                    disabled={!some}
                                    onSelect={run(context.actions.download)}
                                >
                                    <DownloadIcon />
                                    Download {some ? `${selection.length} selected` : ''}
                                    <Keys id="download" />
                                </CommandItem>
                                <CommandItem disabled={!some} onSelect={run(context.actions.trash)}>
                                    <Trash2Icon />
                                    Move {some ? `${selection.length} selected` : ''} to trash
                                    <Keys id="trash" />
                                </CommandItem>
                                <CommandItem
                                    disabled={!context.rows}
                                    onSelect={run(
                                        selection.length === context.rows
                                            ? context.clearSelection
                                            : context.selectAll,
                                    )}
                                >
                                    {selection.length === context.rows && context.rows > 0 ? (
                                        <SquareIcon />
                                    ) : (
                                        <SquareCheckIcon />
                                    )}
                                    {selection.length === context.rows && context.rows > 0
                                        ? 'Clear selection'
                                        : 'Select all'}
                                    <Keys id="select-all" />
                                </CommandItem>
                                <CommandItem
                                    onSelect={run(() =>
                                        context.setView(context.view === 'grid' ? 'list' : 'grid'),
                                    )}
                                >
                                    {context.view === 'grid' ? <ListIcon /> : <LayoutGridIcon />}
                                    {context.view === 'grid' ? 'Show as list' : 'Show as grid'}
                                </CommandItem>
                            </CommandGroup>
                            <CommandSeparator />
                        </>
                    )}
                    <CommandGroup heading="Go to">
                        {context && (
                            <CommandItem onSelect={go('/app')}>
                                <HouseIcon />
                                Top folder
                            </CommandItem>
                        )}
                        {context?.parentId && (
                            <CommandItem
                                onSelect={run(
                                    () =>
                                        void navigate({
                                            to: '/app/f/$folderId',
                                            params: { folderId: context.parentId! },
                                        }),
                                )}
                            >
                                <ArrowUpIcon />
                                Enclosing folder
                            </CommandItem>
                        )}
                        {places.map((item) => (
                            <CommandItem key={item.to} onSelect={go(item.to)}>
                                <item.icon />
                                {item.label}
                            </CommandItem>
                        ))}
                        <CommandItem value="shared with me" onSelect={go('/app/shared')}>
                            <Share2Icon />
                            Shared with me
                        </CommandItem>
                        <CommandItem
                            value="shared by me"
                            onSelect={go('/app/shared', { view: 'by-me' })}
                        >
                            <Share2Icon />
                            Shared by me
                        </CommandItem>
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="Trash">
                        <CommandItem
                            value="empty trash"
                            onSelect={run(() => setConfirm('empty-trash'))}
                        >
                            <Trash2Icon />
                            Empty trash…
                        </CommandItem>
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="This device">
                        {unlocked && (
                            <CommandItem
                                value="lock device"
                                onSelect={run(() => setConfirm('lock'))}
                            >
                                <LockKeyholeIcon />
                                Lock this device…
                            </CommandItem>
                        )}
                        {(
                            [
                                ['light', 'Appearance: light', SunIcon],
                                ['dark', 'Appearance: dark', MoonIcon],
                                ['system', 'Appearance: system', MonitorIcon],
                            ] as const
                        ).map(([value, label, Icon]) => (
                            <CommandItem
                                key={value}
                                value={label}
                                disabled={theme === value}
                                onSelect={run(() => setTheme(value))}
                            >
                                <Icon />
                                {label}
                                {theme === value && (
                                    <CommandShortcut className="normal-case">now</CommandShortcut>
                                )}
                            </CommandItem>
                        ))}
                        <CommandItem value="sign out" onSelect={run(() => void signOut())}>
                            <LogOutIcon />
                            Sign out
                        </CommandItem>
                    </CommandGroup>
                    {context && context.folders.length > 0 && (
                        <>
                            <CommandSeparator />
                            <CommandGroup heading="Folders here">
                                {context.folders.map((folder) => (
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
            <AlertDialog
                open={confirm !== null}
                onOpenChange={(value) => !value && !busy && setConfirm(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirm === 'lock' ? 'Lock this device?' : 'Empty the trash?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirm === 'lock'
                                ? 'Your keys leave this browser. Unlocking again needs your password.'
                                : 'Everything in the trash is deleted for good. This cannot be undone.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={busy}
                            onClick={() => void (confirm === 'lock' ? lock() : emptyTrash())}
                        >
                            {confirm === 'lock'
                                ? 'Lock device'
                                : busy
                                  ? 'Emptying…'
                                  : 'Empty trash'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
