import { Link, useRouter } from '@tanstack/react-router';
import {
    ChevronsUpDownIcon,
    CreditCardIcon,
    GiftIcon,
    KeyRoundIcon,
    LockKeyholeIcon,
    LockKeyholeOpenIcon,
    LogOutIcon,
    SettingsIcon,
    Volume2Icon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { NavItem } from '@/components/app-sidebar';
import { openDeviceDialog } from '@/components/device-control';
import { TextSwap } from '@/components/motion';
import { ThemeRadioItems } from '@/components/theme-toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { cue, setSoundsEnabled, useSoundsEnabled } from '@/lib/sounds';

const under = (prefix: string) => (pathname: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
/* The account's own pages. They live in the account menu; the command palette lists them too. */
export const account: NavItem[] = [
    { to: '/app/account', label: 'Settings', icon: SettingsIcon, active: under('/app/account') },
    {
        to: '/app/billing',
        label: 'Billing',
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
            className={`grid size-7 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground ${className}`}
        >
            {initials(name)}
        </span>
    );
}

/*
 * The account menu: identity, the account's pages, appearance, sounds, lock and
 * sign out. It is the one place preferences live inside the app, so the trigger
 * can sit anywhere (sidebar footer, mobile bar) and the menu stays the same.
 */
export function UserMenu({
    user,
    trigger,
    side = 'top',
    align = 'start',
}: {
    user: { id: string; name: string; email: string };
    trigger: ReactNode;
    side?: 'top' | 'bottom' | 'right';
    align?: 'start' | 'end';
}) {
    const router = useRouter();
    const soundsEnabled = useSoundsEnabled();
    const billing = useBillingEnabled();
    const unlocked = useStore(authClient.store, (state) => state.unlockedUserId) === user.id;
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function signOut() {
        setPending(true);
        setError('');
        try {
            await authClient.logout();
            forgetSession(router.options.context.queryClient, false);
            await router.navigate({ to: '/login' });
            // Clearing before leaving would refetch queries the old page still holds.
            router.options.context.queryClient.clear();
        } catch {
            cue('error');
            setError('Your account is locked, but sign-out could not finish. Please try again.');
        } finally {
            setPending(false);
        }
    }
    return (
        <div className="relative">
            <DropdownMenu>
                <DropdownMenuTrigger
                    aria-label="Account menu"
                    disabled={pending}
                    className="w-full cursor-pointer rounded-md text-left"
                >
                    {trigger}
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    side={side}
                    align={align}
                    sideOffset={8}
                    className="w-(--anchor-width) min-w-64"
                >
                    <DropdownMenuGroup>
                        <DropdownMenuLabel className="flex items-center gap-3 px-2 py-2">
                            <Avatar name={user.name} />
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-foreground">
                                    {user.name}
                                </span>
                                <span className="block truncate text-xs font-normal text-muted-foreground">
                                    {user.email}
                                </span>
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
                    {/* The header's device control owns the dialogs; this only opens them. */}
                    <DropdownMenuItem disabled={restoring} onClick={openDeviceDialog}>
                        {unlocked ? (
                            <LockKeyholeIcon aria-hidden="true" />
                        ) : (
                            <LockKeyholeOpenIcon aria-hidden="true" />
                        )}
                        {unlocked ? 'Lock this device' : 'Unlock this device'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        variant="destructive"
                        disabled={pending}
                        onClick={() => void signOut()}
                    >
                        <LogOutIcon aria-hidden="true" />
                        <TextSwap>{pending ? 'Signing out…' : 'Sign out'}</TextSwap>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {error && (
                <Alert variant="destructive" className="absolute bottom-full left-0 z-50 mb-2 w-72">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
        </div>
    );
}

/* The sidebar-footer trigger: avatar, name, email and a disclosure chevron. */
export function ProfileTrigger({ user }: { user: { name: string; email: string } }) {
    return (
        <span className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-card group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
            <Avatar name={user.name} />
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <span className="block truncate text-sm font-semibold text-foreground">
                    {user.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
            </span>
            <ChevronsUpDownIcon
                className="size-4 text-muted-foreground group-data-[collapsible=icon]:hidden"
                aria-hidden="true"
            />
        </span>
    );
}
