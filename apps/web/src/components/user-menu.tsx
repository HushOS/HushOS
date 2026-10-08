import { useQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import {
    CircleHelpIcon,
    CreditCardIcon,
    GiftIcon,
    KeyRoundIcon,
    LockKeyholeIcon,
    LockKeyholeOpenIcon,
    LogOutIcon,
    SettingsIcon,
    Volume2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { NavItem } from '@/components/app-sidebar';
import { lockDevice, openDeviceDialog } from '@/components/device-control';
import { TextSwap } from '@/components/motion';
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
import { authClient } from '@/lib/auth-client';
import { forgetSession } from '@/lib/session';
import { useBillingEnabled } from '@/lib/queries';
import { helpContactQueryOptions } from '@/lib/social';
import { cue, setSoundsEnabled, useSoundsEnabled } from '@/lib/sounds';

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

export function initials(name: string) {
    return (
        name
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('') || '?'
    );
}

export function Avatar({ name, className = '' }: { name: string; className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={`grid size-7 shrink-0 place-items-center rounded-full bg-avatar1 text-xs font-bold text-on-avatar1 ${className}`}
        >
            {initials(name)}
        </span>
    );
}

/*
 * The account menu, opened from the avatar at the top right: identity, the
 * account's pages, Help, appearance, sounds, lock and sign out. It is the one
 * place preferences live inside the app.
 */
export function UserMenu({ user }: { user: { id: string; name: string; email: string } }) {
    const soundsEnabled = useSoundsEnabled();
    const billing = useBillingEnabled();
    const { data: contact } = useQuery(helpContactQueryOptions);
    const unlocked = useStore(authClient.store, (state) => state.unlockedUserId) === user.id;
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const [signingOut, setSigningOut] = useState(false);
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger
                    aria-label="Account menu"
                    title={user.name}
                    className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full transition-colors outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-expanded:bg-muted"
                >
                    <Avatar name={user.name} className="size-8" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end" sideOffset={6} className="w-66">
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
                    <DropdownMenuItem disabled={restoring} onClick={openDeviceDialog}>
                        {unlocked ? (
                            <LockKeyholeIcon aria-hidden="true" />
                        ) : (
                            <LockKeyholeOpenIcon aria-hidden="true" />
                        )}
                        {unlocked ? 'Lock on this browser' : 'Unlock on this browser'}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setSigningOut(true)}>
                        <LogOutIcon aria-hidden="true" />
                        Sign out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <SignOutDialog open={signingOut} onOpenChange={setSigningOut} unlocked={unlocked} />
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
            await authClient.logout();
            forgetSession(router.options.context.queryClient, false);
            await router.navigate({ to: '/login' });
            // Clearing before leaving would refetch queries the old page still holds.
            router.options.context.queryClient.clear();
        } catch {
            cue('error');
            setFailed(true);
        } finally {
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
                        You’ll need your email and password to get back in.
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
