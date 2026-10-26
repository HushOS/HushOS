import { cn } from 'cn';
import { Brand } from '@/components/brand';
import { Spinner } from '@/components/motion';
import { PersonAvatar } from '@/components/person-avatar';
import { formatDay, useCatalogueState } from '@/lib/drive';
import { familyTierName } from '@/lib/plans';
import { Progress, ProgressValue } from '@/components/ui/progress';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarGroupContent,
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
import { lapsedPlan, livePlan, planStanding } from '@hushos/billing/protocol';
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
    FoldersIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { activeFamily, familiesQueryOptions, useGroupsEnabled } from '@/lib/families-shell';

export type NavItem = {
    to:
        | '/app'
        | '/app/drive'
        | '/app/trash'
        | '/app/shared'
        | '/app/account'
        | '/app/contacts'
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
        to: '/app/contacts',
        label: 'Contacts',
        icon: ContactIcon,
        active: under('/app/contacts'),
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
        <output className="flex items-center gap-2 px-2 text-xs text-muted-foreground rail:hidden">
            {state.phase !== 'failed' && <Spinner className="size-3 shrink-0" />}
            <span className="truncate">{line}</span>
        </output>
    );
}

/*
 * The storage at the foot of the sidebar (docs/families-shared-pool.md 7.1). While the person's
 * files draw from their family's pool, it is the pool, named after the family, on every page:
 * My files and the family folders spend the same storage. Otherwise it is their own space,
 * labelled My files when they are in a family (a family without a live plan, or a server that
 * sells none), so it never reads as the family's.
 */
function StorageMeter({ userId }: { userId: string }) {
    const { data: storage } = useQuery(storageQueryOptions);
    const family = useYourFamily(userId);
    if (storage?.pool) return <PoolMeter family={storage.pool.name} storage={storage} />;
    return <OwnMeter label={family ? 'My files' : null} />;
}

/*
 * The family's pool, as the server counts it for a member (each part in whole GB): what is
 * stored, what is free, and when nothing is, that the family's storage is full. Uploads stop
 * for everyone then, in My files and the family folders alike; nothing is deleted.
 */
function PoolMeter({
    family,
    storage,
}: {
    family: string;
    storage: { usedBytes: string; quotaBytes: string; availableBytes: string };
}) {
    const billing = useBillingEnabled();
    const quota = Number(storage.quotaBytes);
    const used = quota > 0 ? Math.min(1, Math.max(0, Number(storage.usedBytes) / quota)) : 1;
    const full = BigInt(storage.availableBytes) <= 0n;
    const nearlyFull = full || used >= 0.95;
    const usedLine = `${formatSpace(storage.usedBytes)} of ${formatQuota(storage.quotaBytes)} used`;
    const line = full
        ? 'The family’s storage is full'
        : `${formatSpace(storage.availableBytes)} free`;
    return (
        <>
            <CollapsedMeter
                used={used}
                nearlyFull={nearlyFull}
                line={`${family}: ${usedLine}, ${line}`}
            />
            <div className="flex flex-col gap-2 px-2 rail:hidden" data-storage-meter="pool">
                <span className="truncate text-[13px] text-foreground">{family}</span>
                <Progress
                    value={Math.round(used * 100)}
                    aria-label={`${family}’s storage used`}
                    className={cn(
                        'gap-2 **:data-[slot=progress-track]:h-1.5 **:data-[slot=progress-track]:rounded-full',
                        nearlyFull && '**:data-[slot=progress-indicator]:bg-destructive',
                    )}
                >
                    <ProgressValue className="ml-0 text-[13px] text-foreground tabular-nums">
                        {() => usedLine}
                    </ProgressValue>
                </Progress>
                <span
                    className={cn(
                        'text-[13px] tabular-nums',
                        nearlyFull ? 'text-destructive' : 'text-muted-foreground',
                    )}
                >
                    {line}
                </span>
                {billing && (
                    <Link
                        to="/app/billing"
                        className="self-start text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                    >
                        Plan and storage
                    </Link>
                )}
            </div>
        </>
    );
}

/* The person's own space; `label` names it where it could be read as something else's. */
function OwnMeter({ label }: { label: string | null }) {
    const { data: storage } = useQuery(storageQueryOptions);
    const billing = useBillingEnabled();
    const { data: catalogue } = useQuery({ ...catalogueQueryOptions, enabled: billing });
    const { data: summary } = useQuery({ ...billingQueryOptions, enabled: billing });
    const used = storage ? Number(storage.usedBytes) / Number(storage.quotaBytes) : 0;
    // "Get more room" only while a plan with more room than the current one is on sale.
    const current = livePlan(summary?.subscription);
    const lapsed = lapsedPlan(summary?.subscription);
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
          : lapsed
            ? `${familyTierName({ name: lapsed.productName })}${planStanding(lapsed) === 'paused' ? ' is paused' : '’s payment failed'}`
            : `${formatSpace(storage.availableBytes)} free`;
    const usedLine = storage
        ? `${formatSpace(storage.usedBytes)} of ${formatQuota(storage.quotaBytes)} used`
        : 'Storage';
    return (
        <>
            <CollapsedMeter
                used={used}
                nearlyFull={nearlyFull && !ending}
                line={`${label ? `${label}: ` : ''}${usedLine}${line ? `, ${line}` : ''}`}
            />
            <div className="flex flex-col gap-2 px-2 rail:hidden" data-storage-meter="own">
                {label && <span className="text-[13px] text-foreground">{label}</span>}
                <Progress
                    value={Math.round(used * 100)}
                    aria-label="Storage used"
                    className={cn(
                        'gap-2 **:data-[slot=progress-track]:h-1.5 **:data-[slot=progress-track]:rounded-full',
                        nearlyFull && '**:data-[slot=progress-indicator]:bg-destructive',
                    )}
                >
                    <ProgressValue className="ml-0 text-[13px] text-foreground tabular-nums">
                        {() => usedLine}
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
        </>
    );
}

/*
 * The meter in the icon rail: a short bar in the places' 40px square, its words in the tooltip and
 * the button's name (aria-label, never a second text node: the page holds one storage reading,
 * and only one of the two meters is shown at a time). Pressing it opens the sidebar, where the
 * whole meter is.
 */
function CollapsedMeter({
    used,
    nearlyFull,
    line,
}: {
    used: number;
    nearlyFull: boolean;
    line: string;
}) {
    const { setOpen } = useSidebar();
    return (
        <SidebarMenu className="hidden rail:flex">
            <SidebarMenuItem>
                <SidebarMenuButton
                    tooltip={line}
                    aria-label={line}
                    data-storage-rail
                    onClick={() => setOpen(true)}
                    className={cn(item, collapsed)}
                >
                    {/* A short bar, as the open meter draws it: still, so it never reads as loading. */}
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                        <rect x="1" y="8" width="18" height="4" rx="2" className="fill-field" />
                        <rect
                            x="1"
                            y="8"
                            width={Math.max(used > 0 ? 4 : 0, 18 * Math.min(1, Math.max(0, used)))}
                            height="4"
                            rx="2"
                            className={nearlyFull ? 'fill-destructive' : 'fill-primary'}
                        />
                    </svg>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

/*
 * Collapsed, every place is a 40px square (the expanded row's height) with its icon in the
 * middle, and the label leaves the layout instead of being clipped beside it. It stays the
 * link's name for a screen reader (sr-only, not hidden); the tooltip shows it on hover or focus.
 */
const collapsed = 'rail:size-10! rail:justify-center rail:p-0! rail:[&>span:last-child]:sr-only';
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
    className,
}: {
    items: NavItem[];
    pathname: string;
    small?: boolean;
    className?: string;
}) {
    return (
        <SidebarGroupContent className={className}>
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

/*
 * The account's family (one at most, docs/families-shared-pool.md 7.1): its
 * name and avatar head the sidebar, under the brand, leading to Account →
 * Family (/app/family); that slot is where the switcher goes when companies
 * arrive. Someone in no family, or only waiting to join, has none.
 */
function useYourFamily(userId: string) {
    const enabled = useGroupsEnabled();
    const { data } = useQuery({ ...familiesQueryOptions(userId), enabled });
    return enabled ? activeFamily(data) : undefined;
}

function FamilyHeader({ userId, pathname }: { userId: string; pathname: string }) {
    const family = useYourFamily(userId);
    if (!family) return null;
    return (
        <SidebarMenu data-family-header>
            <SidebarMenuItem>
                <SidebarMenuButton
                    render={<Link to="/app/family" />}
                    isActive={pathname === '/app/family' || pathname === '/app/family/'}
                    tooltip={family.name}
                    className={cn(item, collapsed)}
                >
                    {/* Collapsed, the avatar stays and the name goes (the last span). */}
                    <PersonAvatar
                        name={family.name}
                        seed={family.id}
                        size={20}
                        className="-mx-px"
                    />
                    <span className="truncate font-semibold">{family.name}</span>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

/* Family folders, beside My files (which stays private to you): the family's space. */
function FamilyFolders({ userId, pathname }: { userId: string; pathname: string }) {
    const family = useYourFamily(userId);
    if (!family) return null;
    const space = `/app/s/${family.id}`;
    return (
        <SidebarMenu className="mt-0.5 gap-0.5">
            <SidebarMenuItem>
                <SidebarMenuButton
                    render={<Link to="/app/s/$groupId" params={{ groupId: family.id }} />}
                    isActive={pathname === space || pathname.startsWith(`${space}/`)}
                    tooltip="Family folders"
                    className={cn(item, collapsed)}
                >
                    <FoldersIcon aria-hidden="true" />
                    <span className="truncate">Family folders</span>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
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
            <SidebarHeader className="px-4 pt-4 pb-0 rail:px-2">
                {/* The logo's square shares the nav icons' centre line (37px in); the name then starts near their labels. */}
                <Brand
                    to="/app"
                    compact={state === 'collapsed'}
                    className="h-9 self-start rounded-md border-r-0 pr-1 pl-[9px] rail:size-10 rail:justify-center rail:px-0 rail:[&_[data-wordmark-name]]:sr-only"
                />
            </SidebarHeader>
            <SidebarContent className="gap-5 px-4 pt-5 rail:px-2">
                <FamilyHeader userId={user.id} pathname={pathname} />
                <SidebarGroup className={group}>
                    <NavGroup items={workspace.slice(0, 2)} pathname={pathname} />
                    <FamilyFolders userId={user.id} pathname={pathname} />
                    <NavGroup items={workspace.slice(2)} pathname={pathname} className="mt-0.5" />
                </SidebarGroup>
                <SidebarGroup className={group}>
                    <NavGroup items={organise} pathname={pathname} small />
                </SidebarGroup>
                {user.role === 'admin' && (
                    // The rule sets the operator's pages apart; the name is for assistive tech only.
                    <SidebarGroup className="border-t border-rule p-0 pt-4">
                        <SidebarGroupLabel className="sr-only">Operator</SidebarGroupLabel>
                        <NavGroup
                            items={operator.filter((entry) => !entry.billing || billing)}
                            pathname={pathname}
                            small
                        />
                    </SidebarGroup>
                )}
            </SidebarContent>
            <SidebarFooter className="gap-4 px-4 pt-2 pb-4 rail:px-2">
                <CatalogueStatus />
                <StorageMeter userId={user.id} />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
