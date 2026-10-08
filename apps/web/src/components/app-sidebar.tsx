import { cn } from 'cn';
import { Brand } from '@/components/brand';
import { Spinner } from '@/components/motion';
import { formatDay, useCatalogueState } from '@/lib/drive';
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
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatQuota,
    formatSpace,
    storageQueryOptions,
    useBillingEnabled,
} from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import {
    FlagIcon,
    FolderIcon,
    HouseIcon,
    PercentIcon,
    Share2Icon,
    ShieldCheckIcon,
    TagIcon,
    Trash2Icon,
    ContactIcon,
} from 'lucide-react';
import { useEffect } from 'react';

export type NavItem = {
    to:
        | '/app'
        | '/app/drive'
        | '/app/trash'
        | '/app/shared'
        | '/app/account'
        | '/app/people'
        | '/app/tags'
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
    // Home is where the app opens; My files is the top folder and every folder page.
    { to: '/app', label: 'Home', icon: HouseIcon, active: (p) => p === '/app' || p === '/app/' },
    {
        to: '/app/drive',
        label: 'My files',
        icon: FolderIcon,
        active: (p) => p === '/app/drive' || under('/app/drive/f')(p),
    },
    {
        to: '/app/shared',
        label: 'Shared',
        icon: Share2Icon,
        active: under('/app/shared'),
    },
    { to: '/app/trash', label: 'Trash', icon: Trash2Icon, active: under('/app/trash') },
];
/* Still one click away, but quieter than the main places. */
export const organise: NavItem[] = [
    { to: '/app/tags', label: 'Tags', icon: TagIcon, active: under('/app/tags') },
    {
        to: '/app/people',
        label: 'People you share with',
        icon: ContactIcon,
        active: under('/app/people'),
    },
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

/*
 * The catalogue build, while it runs: one plain line, no counts of what was pulled or
 * opened, which nobody can act on. Silent once ready.
 */
function CatalogueStatus() {
    const state = useCatalogueState();
    if (state.phase === 'idle' || state.phase === 'ready') return null;
    const line =
        state.phase === 'failed'
            ? 'Search couldn’t get ready. It tries again next time you open HushOS.'
            : 'Getting search ready';
    return (
        <output className="flex items-center gap-2 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
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
    // "Get more room" only while a plan with more room than the current one is on sale.
    const current =
        summary?.subscription && !summary.subscription.endedAt ? summary.subscription : null;
    const currentQuota = current ? BigInt(current.quotaBytes) : 0n;
    const canUpgrade = Boolean(
        catalogue?.plans.some((plan) => BigInt(plan.quotaBytes) > currentQuota),
    );
    // Nearly full: the bar and the line turn red, and the link offers more room.
    const nearlyFull = used >= 0.95;
    const ending = current?.cancelAtPeriodEnd ? current : null;
    const line = !storage
        ? null
        : ending
          ? `${ending.productName} ends ${formatDay(ending.currentPeriodEnd)}`
          : `${formatSpace(storage.availableBytes)} free`;
    return (
        <div className="flex flex-col gap-2 px-2 group-data-[collapsible=icon]:hidden">
            <Progress
                value={Math.round(used * 100)}
                aria-label="Storage used"
                className={cn(
                    'gap-2 **:data-[slot=progress-track]:h-1.5 **:data-[slot=progress-track]:rounded-full',
                    nearlyFull && '**:data-[slot=progress-indicator]:bg-destructive',
                )}
            >
                <ProgressValue className="ml-0 text-[13px] text-foreground tabular-nums">
                    {() =>
                        storage
                            ? `${formatSpace(storage.usedBytes)} of ${formatQuota(storage.quotaBytes)} used`
                            : 'Storage'
                    }
                </ProgressValue>
            </Progress>
            <span
                className={cn(
                    'text-[13px] tabular-nums',
                    nearlyFull && !ending ? 'text-destructive' : 'text-muted-foreground',
                )}
            >
                {line ?? 'Opening your account…'}
            </span>
            {billing && catalogue && summary && (
                <Link
                    to="/app/billing"
                    className="self-start text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                >
                    {ending
                        ? 'Resume plan'
                        : nearlyFull && canUpgrade
                          ? 'Get more room'
                          : 'Plan and storage'}
                </Link>
            )}
        </div>
    );
}

/*
 * Collapsed, every place is a 40px square (the expanded row's height) with its icon in the
 * middle, and the label leaves the layout instead of being clipped beside it.
 */
const collapsed =
    'group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:[&>span]:hidden';
/* The active place is tinted, semibold and its icon heavier: never tint alone. */
/* The quieter rows draw 16px icons in the 18px column (1px each side), so every label starts in one line. */
const item =
    'h-10 gap-3 rounded-md px-3 text-[15px] font-normal text-foreground hover:bg-muted hover:text-foreground data-active:bg-accent data-active:font-semibold data-active:text-accent-foreground data-active:hover:bg-accent [&_svg]:size-[18px] [&_svg]:stroke-[1.9] data-active:[&_svg]:stroke-[2.3]';
const quiet =
    'h-9 gap-3 rounded-md px-3 text-sm font-normal text-foreground hover:bg-muted hover:text-foreground data-active:bg-accent data-active:font-semibold data-active:text-accent-foreground data-active:hover:bg-accent [&_svg]:mx-px [&_svg]:size-4 [&_svg]:stroke-[1.9] data-active:[&_svg]:stroke-[2.3]';
const group = 'p-0';

function NavGroup({
    items,
    pathname,
    small = false,
}: {
    items: NavItem[];
    pathname: string;
    small?: boolean;
}) {
    return (
        <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
                {items.map((entry) => (
                    <SidebarMenuItem key={entry.to}>
                        <SidebarMenuButton
                            render={<Link to={entry.to} />}
                            isActive={entry.active(pathname)}
                            tooltip={entry.label}
                            className={cn(small ? quiet : item, collapsed)}
                        >
                            <entry.icon aria-hidden="true" />
                            <span>{entry.label}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                ))}
            </SidebarMenu>
        </SidebarGroupContent>
    );
}

export function AppSidebar({
    user,
}: {
    user: { id: string; name: string; email: string; role?: 'member' | 'admin' };
}) {
    const pathname = useLocation({ select: (location) => location.pathname });
    const { state, setOpenMobile } = useSidebar();
    const router = useRouter();
    const billing = useBillingEnabled();
    useEffect(
        () => router.subscribe('onBeforeNavigate', () => setOpenMobile(false)),
        [router, setOpenMobile],
    );
    return (
        <Sidebar collapsible="icon" className="group-data-[side=left]:border-r-0">
            <SidebarHeader className="px-4 pt-4 pb-0 group-data-[collapsible=icon]:px-2">
                {/* The logo's square shares the nav icons' centre line (37px in); the name then starts near their labels. */}
                <Brand
                    to="/app"
                    compact={state === 'collapsed'}
                    className="h-9 self-start rounded-md border-r-0 pr-1 pl-[9px] group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
                />
            </SidebarHeader>
            <SidebarContent className="gap-5 px-4 pt-5 group-data-[collapsible=icon]:px-2">
                <SidebarGroup className={group}>
                    <NavGroup items={workspace} pathname={pathname} />
                </SidebarGroup>
                <SidebarGroup className={group}>
                    <NavGroup items={organise} pathname={pathname} small />
                </SidebarGroup>
                {user.role === 'admin' && (
                    <SidebarGroup className="border-t border-rule p-0 pt-4">
                        <SidebarGroupLabel className="h-auto px-3 pb-1 text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                            Operator
                        </SidebarGroupLabel>
                        <NavGroup
                            items={operator.filter((entry) => !entry.billing || billing)}
                            pathname={pathname}
                            small
                        />
                    </SidebarGroup>
                )}
            </SidebarContent>
            <SidebarFooter className="gap-4 px-4 pt-2 pb-4 group-data-[collapsible=icon]:px-2">
                <CatalogueStatus />
                <StorageMeter />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
