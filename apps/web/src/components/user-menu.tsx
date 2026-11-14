import { useQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import {
    ChevronsUpDownIcon,
    CircleHelpIcon,
    CreditCardIcon,
    GiftIcon,
    KeyRoundIcon,
    LockKeyholeIcon,
    LockKeyholeOpenIcon,
    LogOutIcon,
    SettingsIcon,
    TextQuoteIcon,
    Volume2Icon,
} from 'lucide-react';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import type { NavItem } from '@/components/app-sidebar';
import { lockDevice, openDeviceDialog } from '@/components/device-control';
import { TextSwap } from '@/components/motion';
import { OwnWordsDialog } from '@/components/own-words-dialog';
import { PersonAvatar } from '@/components/person-avatar';
import { ThemeRadioItems } from '@/components/theme-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthView } from '@/lib/auth-view';
import { useBillingEnabled } from '@/lib/queries';
import { helpContactQueryOptions } from '@/lib/social';
import { cue, setSoundsEnabled, useSoundsEnabled } from '@/lib/sounds';
import { leaveApp } from '@/lib/sign-out';

const under = (prefix: string) => (pathname: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
/* The account's own pages. They live in the account menu; the command palette lists them too. */
export const account: NavItem[] = [
    { to: '/app/account', label: 'Account', icon: SettingsIcon, active: under('/app/account') },
    {
        to: '/app/billing',
        label: 'Plan and storage',
        icon: CreditCardIcon,
        active: under('/app/billing'),
        billing: true,
    },
    {
        to: '/app/recovery-key',
        label: 'Recovery phrase',
        icon: KeyRoundIcon,
        active: under('/app/recovery-key'),
    },
    {
        to: '/app/referrals',
        label: 'Invite friends',
        icon: GiftIcon,
        active: under('/app/referrals'),
    },
];

/*
 * The account menu, opened from the avatar: on a desk at the end of the brand's line in the
 * sidebar, below that at the right of the compact top bar. Identity, the account's pages, Help,
 * appearance, sounds, lock and sign out. It is the one place preferences live inside the app.
 */
export function UserMenu({
    user,
    side = 'top',
    align = 'start',
    className,
}: {
    user: { id: string; name: string; email: string };
    side?: 'top' | 'right';
    align?: 'start' | 'end';
    className?: string;
}) {
    const soundsEnabled = useSoundsEnabled();
    const billing = useBillingEnabled();
    const { data: contact } = useQuery(helpContactQueryOptions);
    const unlocked = useAuthView((state) => state.unlockedUserId) === user.id;
    const restoring = useAuthView((state) => state.restoring);
    // On a phone this menu is inside the sidebar's sheet: a choice that opens a dialog closes the
    // sheet first, and the dialog is the page's (AccountDialogs), not the sheet's.
    const { setOpenMobile } = useSidebar();
    const ask = (which: AccountDialog) => {
        setOpenMobile(false);
        openAccountDialog(which);
    };
    return (
        <>
            <DropdownMenu>
                {/*
                 * The sidebar's last row, across its width: the avatar, the name (cut with an
                 * ellipsis when long; whole in the tooltip and in the button's name) and
                 * a chevron at the right edge. Folded to icons it is the avatar alone, centred.
                 */}
                <DropdownMenuTrigger
                    // The name it shows is in the name it answers to (WCAG 2.5.3), folded or not.
                    aria-label={`${user.name}, account menu`}
                    title={user.name}
                    className={cn(
                        'flex h-11 w-full min-w-0 shrink-0 cursor-pointer items-center gap-3 rounded-md px-3 text-left transition-colors outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-expanded:bg-highlight rail:size-10 rail:justify-center rail:gap-0 rail:px-0',
                        className,
                    )}
                >
                    <PersonAvatar name={user.name} seed={user.id} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold rail:hidden">
                        {user.name}
                    </span>
                    <ChevronsUpDownIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground rail:hidden"
                    />
                </DropdownMenuTrigger>
                <DropdownMenuContent side={side} align={align} sideOffset={6} className="w-66">
                    <DropdownMenuGroup>
                        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-2">
                            <span className="truncate text-sm font-semibold text-foreground">
                                {user.name}
                            </span>
                            <span className="truncate text-[13px] font-normal text-muted-foreground">
                                {user.email}
                            </span>
                        </DropdownMenuLabel>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                        {account
                            .filter((item) => !item.billing || billing)
                            .map((item) => (
                                <DropdownMenuItem key={item.to} render={<Link to={item.to} />}>
                                    <item.icon aria-hidden="true" /> {item.label}
                                </DropdownMenuItem>
                            ))}
                        {/* Read aloud while someone adds you, from whatever page is open. */}
                        {unlocked && (
                            <DropdownMenuItem onClick={() => ask('words')}>
                                <TextQuoteIcon aria-hidden="true" /> Your twelve words
                            </DropdownMenuItem>
                        )}
                        {contact && (
                            <DropdownMenuItem
                                render={<a href={`mailto:${contact}`} aria-label="Help" />}
                            >
                                <CircleHelpIcon aria-hidden="true" /> Help
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <ThemeRadioItems />
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                        checked={soundsEnabled}
                        onCheckedChange={setSoundsEnabled}
                        closeOnClick={false}
                    >
                        <Volume2Icon aria-hidden="true" /> Interface sounds
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    {/* The device control owns the lock and unlock dialogs; this only opens them. */}
                    <DropdownMenuItem
                        disabled={restoring}
                        onClick={() => {
                            setOpenMobile(false);
                            openDeviceDialog();
                        }}
                    >
                        {unlocked ? (
                            <LockKeyholeIcon aria-hidden="true" />
                        ) : (
                            <LockKeyholeOpenIcon aria-hidden="true" />
                        )}
                        {unlocked ? 'Lock on this browser' : 'Unlock on this browser'}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => ask('sign-out')}>
                        <LogOutIcon aria-hidden="true" />
                        Sign out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}

/*
 * The dialogs the account menu opens, mounted once by the app's layout and asked for from the
 * menu. The menu's own place is the sidebar, which on a phone is a modal sheet: a dialog mounted
 * there would open inside the sheet and go when it closes.
 */
type AccountDialog = 'sign-out' | 'words';
const openers = new Set<(which: AccountDialog) => void>();
function openAccountDialog(which: AccountDialog) {
    for (const open of openers) open(which);
}

export function AccountDialogs({ user }: { user: { id: string } }) {
    const unlocked = useAuthView((state) => state.unlockedUserId) === user.id;
    const [open, setOpen] = useState<AccountDialog | null>(null);
    useEffect(() => {
        openers.add(setOpen);
        return () => void openers.delete(setOpen);
    }, []);
    const close = (next: boolean) => !next && setOpen(null);
    return (
        <>
            <SignOutDialog open={open === 'sign-out'} onOpenChange={close} unlocked={unlocked} />
            <OwnWordsDialog userId={user.id} open={open === 'words'} onOpenChange={close} />
        </>
    );
}

/* Sign out asks first, and offers the lighter choice: lock, which keeps the session. */
function SignOutDialog({
    open,
    onOpenChange,
    unlocked,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    unlocked: boolean;
}) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);
    async function signOut() {
        setPending(true);
        setFailed(false);
        try {
            // Busy here until the sign-in page replaces the app; the page behind holds still.
            await leaveApp(router);
        } catch {
            cue('error');
            setFailed(true);
            setPending(false);
        }
    }
    return (
        <AlertDialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                if (!next) setFailed(false);
                onOpenChange(next);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Sign out of HushOS?</AlertDialogTitle>
                    <AlertDialogDescription>
                        This browser leaves your list of devices, and you’ll need your email and
                        password to get back in.
                        {unlocked &&
                            ' To hide your files without signing out, lock HushOS on this browser instead.'}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {failed && (
                    <Alert variant="destructive">
                        <AlertDescription>
                            HushOS is locked here, but signing out didn’t finish. Check your
                            connection and try again.
                        </AlertDescription>
                    </Alert>
                )}
                <AlertDialogFooter>
                    <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    {unlocked && (
                        <Button
                            variant="outline"
                            disabled={pending}
                            onClick={() => {
                                onOpenChange(false);
                                void lockDevice();
                            }}
                        >
                            <LockKeyholeIcon aria-hidden="true" />
                            Lock instead
                        </Button>
                    )}
                    <Button variant="destructive" disabled={pending} onClick={() => void signOut()}>
                        <TextSwap>
                            {pending ? 'Signing out…' : failed ? 'Try again' : 'Sign out'}
                        </TextSwap>
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
