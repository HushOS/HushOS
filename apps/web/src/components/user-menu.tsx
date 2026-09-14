import { Link, useRouter } from '@tanstack/react-router';
import {
    ChevronsUpDownIcon,
    CreditCardIcon,
    KeyRoundIcon,
    LogOutIcon,
    SettingsIcon,
    Volume2Icon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
            className={`grid size-8 shrink-0 place-items-center bg-ink font-mono text-[11px] font-semibold text-secondary-foreground ${className}`}
        >
            {initials(name)}
        </span>
    );
}

/*
 * The profile menu: identity, settings, appearance, sounds, sign out. It is
 * the one place preferences live inside the app, so the trigger can sit
 * anywhere (sidebar footer, mobile bar) and the menu stays the same.
 */
export function UserMenu({
    user,
    trigger,
    side = 'top',
    align = 'start',
}: {
    user: { name: string; email: string };
    trigger: ReactNode;
    side?: 'top' | 'bottom' | 'right';
    align?: 'start' | 'end';
}) {
    const router = useRouter();
    const soundsEnabled = useSoundsEnabled();
    const billing = useBillingEnabled();
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
                    data-cuelume-press="press"
                    className="w-full cursor-pointer text-left"
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
                        <DropdownMenuLabel className="flex items-center gap-3 px-2 py-2 normal-case tracking-normal">
                            <Avatar name={user.name} />
                            <span className="min-w-0">
                                <span className="block truncate font-mono text-[13px] font-medium text-foreground">
                                    {user.name}
                                </span>
                                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                    {user.email}
                                </span>
                            </span>
                        </DropdownMenuLabel>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                        <DropdownMenuItem
                            render={<Link to="/app/account" />}
                            data-cuelume-hover="tick"
                        >
                            <SettingsIcon aria-hidden="true" /> Account settings
                        </DropdownMenuItem>
                        {billing && (
                            <DropdownMenuItem
                                render={<Link to="/app/billing" />}
                                data-cuelume-hover="tick"
                            >
                                <CreditCardIcon aria-hidden="true" /> Billing
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                            render={<Link to="/app/recovery-key" />}
                            data-cuelume-hover="tick"
                        >
                            <KeyRoundIcon aria-hidden="true" /> Recovery phrase
                        </DropdownMenuItem>
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
        <span className="flex w-full items-center gap-3 px-3 py-3 transition-colors hover:bg-muted group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
            <Avatar name={user.name} />
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <span className="block truncate font-mono text-[13px] font-medium">
                    {user.name}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {user.email}
                </span>
            </span>
            <ChevronsUpDownIcon
                className="size-4 text-muted-foreground group-data-[collapsible=icon]:hidden"
                aria-hidden="true"
            />
        </span>
    );
}
