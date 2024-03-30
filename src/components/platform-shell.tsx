'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { HardDriveIcon, LogOutIcon } from 'lucide-react';

import { Logo } from '@/components/logo';
import { SidebarItem, SidebarNav } from '@/components/sidebar-nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { client } from '@/server/client';

type PlatformShellProps = {
    defaultLayout?: Array<number>;
    defaultCollapsed?: boolean;
    navCollapsedSize: number;
    children: ReactNode;
    additionalSidebarComponents?: ReactNode;
};

const items: Array<SidebarItem> = [
    {
        icon: HardDriveIcon,
        label: 'Drive',
        route: Routes.drive(),
    },
    {
        icon: LogOutIcon,
        label: 'Logout',
        route: client.api.auth.logout.$url().pathname,
        linkProps: {
            prefetch: false,
        },
    },
];

export function PlatformShell({
    defaultLayout = [14, 86],
    navCollapsedSize,
    defaultCollapsed = false,
    children,
    additionalSidebarComponents,
}: PlatformShellProps) {
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
    const [size, setSize] = useState(defaultLayout);

    useEffect(() => {
        document.cookie = `react-resizable-panels:layout=${JSON.stringify(size)};path=/`;
    }, [size]);

    return (
        <TooltipProvider delayDuration={0}>
            <ResizablePanelGroup
                autoSaveId='persistence'
                direction='horizontal'
                className='h-full items-stretch'>
                <ResizablePanel
                    defaultSize={size[0]}
                    collapsedSize={navCollapsedSize}
                    collapsible={true}
                    minSize={10}
                    maxSize={24}
                    onResize={resize => {
                        setSize(prev => [resize, prev[1]!]);
                    }}
                    onCollapse={() => {
                        setIsCollapsed(true);
                        document.cookie = `react-resizable-panels:collapsed=${JSON.stringify(
                            true
                        )};path=/`;
                    }}
                    onExpand={() => {
                        setIsCollapsed(false);
                        document.cookie = `react-resizable-panels:collapsed=${JSON.stringify(
                            false
                        )};path=/`;
                    }}
                    className={cn(
                        'hidden flex-col lg:flex',
                        false && 'min-w-[50px] transition-all duration-300 ease-in-out'
                    )}>
                    <div
                        className={cn(
                            'flex items-center justify-between text-xl',
                            isCollapsed ? 'flex-col gap-4 py-4' : 'h-[52px] px-4'
                        )}>
                        <Link href={Routes.drive()}>
                            <div className='flex items-center gap-2'>
                                <Logo className='size-6' />
                                <h1
                                    className={cn({
                                        [`hidden`]: isCollapsed,
                                    })}>
                                    HushOS
                                </h1>
                            </div>
                        </Link>
                        <ThemeToggle />
                    </div>
                    <Separator className='mb-4' />
                    <SidebarNav links={items} isCollapsed={isCollapsed} />
                    {additionalSidebarComponents}
                </ResizablePanel>
                <ResizableHandle withHandle className='hidden lg:flex' />
                <ResizablePanel
                    onResize={resize => {
                        setSize(prev => [prev[0]!, resize]);
                    }}
                    defaultSize={size[1]}
                    minSize={30}
                    className='relative'>
                    {children}
                </ResizablePanel>
            </ResizablePanelGroup>
        </TooltipProvider>
    );
}
