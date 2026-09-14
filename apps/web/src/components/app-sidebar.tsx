import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import {
    CreditCardIcon,
    FlagIcon,
    FolderIcon,
    GiftIcon,
    PercentIcon,
    KeyRoundIcon,
    SettingsIcon,
    Share2Icon,
    ShieldCheckIcon,
    Trash2Icon,
    UsersIcon,
} from 'lucide-react';
import { Brand } from '@/components/brand';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
    useSidebar,
} from '@/components/ui/sidebar';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { ProfileTrigger, UserMenu } from '@/components/user-menu';
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatGiB,
    storageQueryOptions,
    useBillingEnabled,
} from '@/lib/queries';

type NavItem = {
    to:
        | '/app'
        | '/app/trash'
        | '/app/shared'
        | '/app/account'
        | '/app/contacts'
        | '/app/billing'
        | '/app/recovery-key'
        | '/app/referrals'
        | '/app/admin'
        | '/app/admin/reports'
        | '/app/admin/affiliates';
    label: string;
    icon: typeof FolderIcon;
    active: (pathname: string) => boolean;
    billing?: boolean;
};
const under = (prefix: string) => (pathname: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
const workspace: NavItem[] = [
    // Drive is the app's home: the root and every folder page.
    {
        to: '/app',
        label: 'Drive',
        icon: FolderIcon,
        active: (p) => p === '/app' || under('/app/f')(p),
    },
    {
        to: '/app/shared',
        label: 'Shared',
        icon: Share2Icon,
        active: under('/app/shared'),
    },
    { to: '/app/trash', label: 'Trash', icon: Trash2Icon, active: under('/app/trash') },
];
const account: NavItem[] = [
    { to: '/app/account', label: 'Settings', icon: SettingsIcon, active: under('/app/account') },
    { to: '/app/contacts', label: 'Contacts', icon: UsersIcon, active: under('/app/contacts') },
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
const operator: NavItem[] = [
    {
        to: '/app/admin',
        label: 'Management',
        icon: ShieldCheckIcon,
        active: (pathname) => pathname === '/app/admin',
    },
    {
        to: '/app/admin/reports',
        label: 'Reports',
        icon: FlagIcon,
        active: under('/app/admin/reports'),
    },
    {
        to: '/app/admin/affiliates',
        label: 'Affiliates',
        icon: PercentIcon,
        active: under('/app/admin/affiliates'),
        billing: true,
    },
];

function StorageMeter() {
    const { data: storage } = useQuery(storageQueryOptions);
    const billing = useBillingEnabled();
    const { data: catalogue } = useQuery({ ...catalogueQueryOptions, enabled: billing });
    const { data: summary } = useQuery({ ...billingQueryOptions, enabled: billing });
    const used = storage ? Number(storage.usedBytes) / Number(storage.quotaBytes) : 0;
    // "Upgrade" only while a plan with more room than the current one is on sale.
    const current =
        summary?.subscription && !summary.subscription.endedAt ? summary.subscription : null;
    const currentQuota = current ? BigInt(current.quotaBytes) : 0n;
    const canUpgrade = Boolean(
        catalogue?.plans.some((plan) => BigInt(plan.quotaBytes) > currentQuota),
    );
    return (
        <div className="border-b px-3 py-3 group-data-[collapsible=icon]:hidden">
            <Progress value={Math.round(used * 100)} aria-label="Storage used" className="gap-2">
                <ProgressLabel>Storage</ProgressLabel>
                <ProgressValue>
                    {() =>
                        storage
                            ? `${formatGiB(storage.usedBytes)} / ${formatGiB(storage.quotaBytes)}`
                            : '—'
                    }
                </ProgressValue>
            </Progress>
            <p className="mt-2 flex justify-between gap-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                <span>
                    {storage
                        ? `${formatGiB(storage.availableBytes)} available.`
                        : 'Opening your account…'}
                </span>
                {billing && catalogue && summary && (
                    <Link to="/app/billing" className="text-link" data-cuelume-hover="tick">
                        {current?.cancelAtPeriodEnd ? 'Resume' : canUpgrade ? 'Upgrade' : 'Plan'}
                    </Link>
                )}
            </p>
        </div>
    );
}

export function AppSidebar({
    user,
}: {
    user: { name: string; email: string; role?: 'member' | 'admin' };
}) {
    const pathname = useLocation({ select: (location) => location.pathname });
    const { state, setOpenMobile } = useSidebar();
    const router = useRouter();
    const billing = useBillingEnabled();
    useEffect(
        () => router.subscribe('onResolved', () => setOpenMobile(false)),
        [router, setOpenMobile],
    );
    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="h-11 flex-row items-stretch gap-0 border-b p-0">
                <Brand
                    to="/app"
                    compact={state === 'collapsed'}
                    className="w-full justify-center border-r-0"
                />
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>Workspace</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {workspace.map((item) => (
                                <SidebarMenuItem key={item.to}>
                                    <SidebarMenuButton
                                        render={<Link to={item.to} data-cuelume-hover="tick" />}
                                        isActive={item.active(pathname)}
                                        tooltip={item.label}
                                    >
                                        <item.icon aria-hidden="true" />
                                        <span>{item.label}</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                <SidebarGroup>
                    <SidebarGroupLabel>Account</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {account
                                .filter((item) => !item.billing || billing)
                                .map((item) => (
                                    <SidebarMenuItem key={item.to}>
                                        <SidebarMenuButton
                                            render={<Link to={item.to} data-cuelume-hover="tick" />}
                                            isActive={item.active(pathname)}
                                            tooltip={item.label}
                                        >
                                            <item.icon aria-hidden="true" />
                                            <span>{item.label}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                ))}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                {user.role === 'admin' && (
                    <SidebarGroup>
                        <SidebarGroupLabel>Operator</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {operator.map((item) => (
                                    <SidebarMenuItem key={item.to}>
                                        <SidebarMenuButton
                                            render={<Link to={item.to} data-cuelume-hover="tick" />}
                                            isActive={item.active(pathname)}
                                            tooltip={item.label}
                                        >
                                            <item.icon aria-hidden="true" />
                                            <span>{item.label}</span>
                                        </SidebarMenuButton>
                                    </SidebarMenuItem>
                                ))}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                )}
            </SidebarContent>
            <SidebarFooter className="gap-0 border-t p-0">
                <StorageMeter />
                <UserMenu user={user} trigger={<ProfileTrigger user={user} />} side="top" />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
