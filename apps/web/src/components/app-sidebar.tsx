import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { KeyRoundIcon, LayoutGridIcon, SettingsIcon } from 'lucide-react';
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
import { formatGiB, storageQueryOptions } from '@/lib/queries';

const workspace = [{ to: '/app', label: 'Overview', icon: LayoutGridIcon, exact: true }] as const;
const account = [
    { to: '/app/account', label: 'Settings', icon: SettingsIcon, exact: false },
    { to: '/app/recovery-key', label: 'Recovery phrase', icon: KeyRoundIcon, exact: false },
] as const;

function StorageMeter() {
    const { data: storage } = useQuery(storageQueryOptions);
    const used = storage ? Number(storage.usedBytes) / Number(storage.quotaBytes) : 0;
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
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {storage
                    ? `${formatGiB(storage.availableBytes)} available.`
                    : 'Opening your account…'}
            </p>
        </div>
    );
}

export function AppSidebar({ user }: { user: { name: string; email: string } }) {
    const pathname = useLocation({ select: (location) => location.pathname });
    const { state, setOpenMobile } = useSidebar();
    const router = useRouter();
    useEffect(
        () => router.subscribe('onResolved', () => setOpenMobile(false)),
        [router, setOpenMobile],
    );
    const active = (to: string, exact: boolean) =>
        exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
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
                                        isActive={active(item.to, item.exact)}
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
                            {account.map((item) => (
                                <SidebarMenuItem key={item.to}>
                                    <SidebarMenuButton
                                        render={<Link to={item.to} data-cuelume-hover="tick" />}
                                        isActive={active(item.to, item.exact)}
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
            </SidebarContent>
            <SidebarFooter className="gap-0 border-t p-0">
                <StorageMeter />
                <UserMenu user={user} trigger={<ProfileTrigger user={user} />} side="top" />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
