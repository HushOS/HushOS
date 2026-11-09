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
    UsersIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import {
    activeFamily,
    canManage,
    useWaitingOn,
    familiesQueryOptions,
    familyItemActive,
    useGroupsEnabled,
} from '@/lib/families-shell';
import { SearchButton } from '@/components/search-button';
import { UserMenu } from '@/components/user-menu';
import { Badge } from '@/components/ui/badge';

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
/*
 * The places, in the sidebar's order: one list, one size. The family (or Family, for someone in
 * none) goes in after My files (FAMILY_SLOT), where the sidebar draws it.
 */
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
    { to: '/app/tags', label: 'Tags', icon: TagIcon, active: under('/app/tags') },
    {
        to: '/app/contacts',
        label: 'Contacts',
        icon: ContactIcon,
        active: under('/app/contacts'),
    },
    { to: '/app/trash', label: 'Trash', icon: Trash2Icon, active: under('/app/trash') },
];
const FAMILY_SLOT = 2;
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
        <output className="flex items-center gap-2 px-3 text-xs text-muted-foreground rail:hidden">
            {state.phase !== 'failed' && <Spinner className="size-3 shrink-0" />}
            <span className="truncate">{line}</span>
        </output>
    );
}

/*
 * The storage at the foot of the sidebar (docs/families-shared-pool.md 7.1). While the person's
 * files draw from their family's pool, it is the pool on every page (named after the family for
 * assistive tech and in the rail's tooltip; the family item above shows the name): My files and
 * the family folders spend the same storage. Otherwise it is their own space,
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
            {/* The family item above names the family; the bar's name still says whose pool it is. */}
            <div className="flex flex-col gap-2 px-3 rail:hidden" data-storage-meter="pool">
                <Progress
                    value={Math.round(used * 100)}
                    aria-label={`Storage used, ${family}`}
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
            <div className="flex flex-col gap-2 px-3 rail:hidden" data-storage-meter="own">
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
/* Every place is one size: a 40px row, 15px label, 18px icon. */
/* The active place is tinted, semibold and its icon heavier: never tint alone. */
const item =
    'h-10 gap-3 rounded-md px-3 text-[15px] font-normal text-foreground hover:bg-muted hover:text-foreground data-active:bg-accent data-active:font-semibold data-active:text-accent-foreground data-active:hover:bg-accent [&_svg]:size-[18px] [&_svg]:stroke-[1.9] data-active:[&_svg]:stroke-[2.3]';
const group = 'p-0';

function NavItems({ items, pathname }: { items: NavItem[]; pathname: string }) {
    return items.map((entry) => (
        <SidebarMenuItem key={entry.to}>
            <SidebarMenuButton
                render={<Link to={entry.to} />}
                isActive={entry.active(pathname)}
                tooltip={entry.label}
                className={cn(item, collapsed)}
            >
                <entry.icon aria-hidden="true" />
                <span>{entry.label}</span>
            </SidebarMenuButton>
        </SidebarMenuItem>
    ));
}

/*
 * The account's family (one at most, docs/families-shared-pool.md 7.1). Someone in no family,
 * or only waiting to join, has none.
 */
function useYourFamily(userId: string) {
    const enabled = useGroupsEnabled();
    const { data } = useQuery({ ...familiesQueryOptions(userId), enabled });
    return enabled ? activeFamily(data) : undefined;
}

/* Collapsed, the avatar stays and the name goes; a count stays too, at the square's corner. */
const familyCollapsed =
    'rail:size-10! rail:justify-center rail:p-0! rail:[&>[data-family-name]]:sr-only';

/*
 * The family, one place after My files: its avatar and name, opening the family's folders
 * (/app/s/<family>), and active there and on the family's own page (/app/family), which the
 * folders' Family settings and Account → Family lead to. A count shows while people wait to be
 * let in or members wait to be checked; it is still, never pulsing. This slot is where the
 * switcher goes when companies arrive.
 */
function FamilyItem({ userId, pathname }: { userId: string; pathname: string }) {
    const family = useYourFamily(userId);
    const waiting = useWaitingOn(
        userId,
        family?.id ?? '',
        family !== undefined && canManage(family.roles),
    );
    if (!family) return null;
    const name = waiting > 0 ? `${family.name}, ${waiting} waiting for you` : family.name;
    return (
        <SidebarMenuItem data-family-item>
            <SidebarMenuButton
                render={<Link to="/app/s/$groupId" params={{ groupId: family.id }} />}
                isActive={familyItemActive(pathname, family.id)}
                tooltip={name}
                aria-label={waiting > 0 ? name : undefined}
                className={cn(item, familyCollapsed, 'relative')}
            >
                <PersonAvatar name={family.name} seed={family.id} size={20} className="-mx-px" />
                <span data-family-name className="truncate">
                    {family.name}
                </span>
                {waiting > 0 && (
                    <Badge
                        aria-hidden="true"
                        data-family-waiting={waiting}
                        className="ml-auto h-5 min-w-5 rounded-full bg-secondary px-1.5 text-secondary-foreground tabular-nums rail:absolute rail:top-0.5 rail:right-0.5 rail:ml-0 rail:h-4 rail:min-w-4 rail:px-1 rail:text-[10px]"
                    >
                        {waiting}
                    </Badge>
                )}
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

/*
 * Family for someone in no family, or only waiting to join one, where families are served: it
 * opens Account → Family (/app/family), where they create one or finish joining. In a family,
 * the family's own item stands there instead (FamilyItem).
 */
function FamilyPlace({ userId, pathname }: { userId: string; pathname: string }) {
    const enabled = useGroupsEnabled();
    const families = useQuery({ ...familiesQueryOptions(userId), enabled });
    if (!enabled || families.isPending || activeFamily(families.data)) return null;
    return (
        <SidebarMenuItem data-family-place>
            <SidebarMenuButton
                render={<Link to="/app/family" />}
                isActive={under('/app/family')(pathname)}
                tooltip="Family"
                className={cn(item, collapsed)}
            >
                <UsersIcon aria-hidden="true" />
                <span>Family</span>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

export function AppSidebar({
    user,
}: {
    user: { id: string; name: string; email: string; role?: 'member' | 'admin' };
}) {
    const pathname = useLocation({ select: (location) => location.pathname });
    const { state, isMobile, setOpenMobile } = useSidebar();
    const rail = state === 'collapsed' && !isMobile;
    const router = useRouter();
    const billing = useBillingEnabled();
    useEffect(
        () => router.subscribe('onBeforeNavigate', () => setOpenMobile(false)),
        [router, setOpenMobile],
    );
    return (
        <Sidebar collapsible="icon" className="group-data-[side=left]:border-r-0">
            {/*
             * The brand's line: on a desk the page has no top bar, so search and the account menu
             * sit here, at the right; collapsed they stack under the logo as 40px squares. Below a
             * desk the page's compact top bar holds them (app/route.tsx), so they are not here.
             */}
            <SidebarHeader className="flex-row items-center gap-1 px-4 pt-4 pb-0 rail:flex-col rail:gap-2 rail:px-2">
                {/*
                 * The column's text edge is the places' icons, 28px in (DESIGN.md: align the text, not
                 * the box); their tinted rows hang 12px outside it. The logo's square starts on that
                 * edge, and its 6px gap puts the name on the labels' edge, 58px in.
                 */}
                <Brand
                    to="/app"
                    compact={state === 'collapsed'}
                    className="mr-auto h-9 rounded-md border-r-0 pr-1 pl-3 rail:mr-0 rail:size-10 rail:justify-center rail:px-0 rail:[&_[data-wordmark-name]]:sr-only [&>span]:gap-1.5"
                />
                <SearchButton
                    side={rail ? 'right' : 'bottom'}
                    className="max-lg:hidden rail:size-10"
                />
                <UserMenu
                    user={user}
                    side={rail ? 'right' : 'bottom'}
                    align="start"
                    className="max-lg:hidden rail:size-10"
                />
            </SidebarHeader>
            <SidebarContent className="gap-5 px-4 pt-5 rail:px-2">
                <SidebarGroup className={group}>
                    <SidebarGroupContent>
                        <SidebarMenu className="gap-0.5">
                            <NavItems items={workspace.slice(0, FAMILY_SLOT)} pathname={pathname} />
                            <FamilyItem userId={user.id} pathname={pathname} />
                            <FamilyPlace userId={user.id} pathname={pathname} />
                            <NavItems items={workspace.slice(FAMILY_SLOT)} pathname={pathname} />
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                {user.role === 'admin' && (
                    // The rule sets the operator's pages apart; the name is for assistive tech only.
                    <SidebarGroup className="border-t border-rule p-0 pt-4">
                        <SidebarGroupLabel className="sr-only">Operator</SidebarGroupLabel>
                        <SidebarGroupContent>
                            <SidebarMenu className="gap-0.5">
                                <NavItems
                                    items={operator.filter((entry) => !entry.billing || billing)}
                                    pathname={pathname}
                                />
                            </SidebarMenu>
                        </SidebarGroupContent>
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
