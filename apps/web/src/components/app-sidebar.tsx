import { Brand } from '@/components/brand';
import { Spinner } from '@/components/motion';
import { useCatalogueState } from '@/lib/drive';
import { Progress, ProgressValue } from '@/components/ui/progress';
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
import { ProfileTrigger, UserMenu } from '@/components/user-menu';
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatGiB,
    storageQueryOptions,
    useBillingEnabled,
} from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import {
    FlagIcon,
    FolderIcon,
    PercentIcon,
    Share2Icon,
    ShieldCheckIcon,
    Trash2Icon,
    SearchIcon,
    UsersIcon,
} from 'lucide-react';
import { useEffect } from 'react';

export type NavItem = {
    to:
        | '/app/drive'
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
export const workspace: NavItem[] = [
    // Drive is the app's home: the root and every folder page.
    {
        to: '/app/drive',
        label: 'Drive',
        icon: FolderIcon,
        active: (p) => p === '/app/drive' || under('/app/drive/f')(p),
    },
    {
        to: '/app/shared',
        label: 'Shared',
        icon: Share2Icon,
        active: under('/app/shared'),
    },
    { to: '/app/contacts', label: 'Contacts', icon: UsersIcon, active: under('/app/contacts') },
    { to: '/app/trash', label: 'Trash', icon: Trash2Icon, active: under('/app/trash') },
];
export const operator: NavItem[] = [
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

/* The catalogue build, while it runs: the tree pulled into this device, then opened. Silent once ready. */
function CatalogueStatus() {
    const state = useCatalogueState();
    if (state.phase === 'idle' || state.phase === 'ready') return null;
    const line =
        state.phase === 'pulling'
            ? `Indexing your Drive · ${state.pulled.toLocaleString()} fetched`
            : state.phase === 'opening'
              ? `Indexing your Drive · ${state.opened.toLocaleString()} opened`
              : 'Indexing stopped. It resumes on the next open.';
    return (
        <output className="flex items-center gap-2 px-2 text-xs text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden">
            {state.phase !== 'failed' && <Spinner className="size-3 shrink-0" />}
            <span className="truncate">{line}</span>
        </output>
    );
}

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
        <div className="flex flex-col gap-2 px-2 group-data-[collapsible=icon]:hidden">
            <Progress
                value={Math.round(used * 100)}
                aria-label="Storage used"
                className="gap-2 **:data-[slot=progress-track]:h-1 **:data-[slot=progress-track]:rounded-xl"
            >
                <ProgressValue className="ml-0 text-[13px]">
                    {() =>
                        storage ? (
                            <>
                                <span className="font-semibold text-foreground">
                                    {formatGiB(storage.usedBytes)}
                                </span>{' '}
                                of {formatGiB(storage.quotaBytes)} used
                            </>
                        ) : (
                            '-'
                        )
                    }
                </ProgressValue>
            </Progress>
            <p className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
                <span>
                    {storage
                        ? `${formatGiB(storage.availableBytes)} available.`
                        : 'Opening your account…'}
                </span>
                {billing && catalogue && summary && (
                    <Link to="/app/billing" className="text-link">
                        {current?.cancelAtPeriodEnd ? 'Resume' : canUpgrade ? 'Upgrade' : 'Plan'}
                    </Link>
                )}
            </p>
        </div>
    );
}

/*
 * The active item is a tab cut into the sheet's edge: it takes the sheet's colour
 * and runs to the sidebar's right edge, where the sheet begins. Collapsed to
 * icons there is no edge to join, so it is a plain square.
 */
const tab =
    'rounded-l-md rounded-r-none data-active:bg-card data-active:font-bold data-active:text-foreground data-active:shadow-[-1px_1px_0_var(--shade-a)] group-data-[collapsible=icon]:rounded-md';
const group = 'py-1.5 pr-0 pl-3 group-data-[collapsible=icon]:px-2';

function NavGroup({ items, pathname }: { items: NavItem[]; pathname: string }) {
    return (
        <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
                {items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                            render={<Link to={item.to} />}
                            isActive={item.active(pathname)}
                            tooltip={item.label}
                            className={tab}
                        >
                            <item.icon aria-hidden="true" />
                            <span>{item.label}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                ))}
            </SidebarMenu>
        </SidebarGroupContent>
    );
}

export function AppSidebar({
    user,
    onSearch,
}: {
    user: { id: string; name: string; email: string; role?: 'member' | 'admin' };
    onSearch: () => void;
}) {
    const pathname = useLocation({ select: (location) => location.pathname });
    const { state, setOpenMobile } = useSidebar();
    const router = useRouter();
    useEffect(
        () => router.subscribe('onBeforeNavigate', () => setOpenMobile(false)),
        [router, setOpenMobile],
    );
    return (
        <Sidebar collapsible="icon" className="group-data-[side=left]:border-r-0">
            <SidebarHeader className="px-3 pt-4 pb-2 group-data-[collapsible=icon]:px-2">
                <Brand
                    to="/app/drive"
                    compact={state === 'collapsed'}
                    className="h-9 self-start rounded-md border-r-0 px-2.5 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
                />
                {/* Search lives here, not beside the page title, so it never shifts as the title changes. */}
                <button
                    type="button"
                    onClick={onSearch}
                    aria-label="Search"
                    className="mt-2 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-rule bg-muted px-2.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
                >
                    <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="truncate group-data-[collapsible=icon]:hidden">Search</span>
                    <kbd className="ml-auto text-[11px] group-data-[collapsible=icon]:hidden">
                        / ⌘K
                    </kbd>
                </button>
            </SidebarHeader>
            <SidebarContent className="gap-3">
                <SidebarGroup className={group}>
                    <NavGroup items={workspace} pathname={pathname} />
                </SidebarGroup>
                {user.role === 'admin' && (
                    <SidebarGroup className={group}>
                        <SidebarGroupLabel>Operator</SidebarGroupLabel>
                        <NavGroup items={operator} pathname={pathname} />
                    </SidebarGroup>
                )}
            </SidebarContent>
            <SidebarFooter className="gap-3 px-3 pt-2 pb-4 group-data-[collapsible=icon]:px-2">
                <CatalogueStatus />
                <StorageMeter />
                <UserMenu user={user} trigger={<ProfileTrigger user={user} />} side="top" />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
