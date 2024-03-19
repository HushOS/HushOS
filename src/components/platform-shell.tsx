'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';

import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Routes } from '@/lib/routes';
import { cn } from '@/lib/utils';

type PlatformShellProps = {
    defaultLayout?: Array<number>;
    defaultCollapsed?: boolean;
    navCollapsedSize: number;
    children: ReactNode;
};

export function PlatformShell({
    defaultLayout = [20, 80],
    navCollapsedSize,
    defaultCollapsed = false,
    children,
}: PlatformShellProps) {
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
    const [size, setSize] = useState(defaultLayout);

    useEffect(() => {
        document.cookie = `react-resizable-panels:layout=${JSON.stringify(size)}`;
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
                    maxSize={20}
                    onResize={resize => {
                        setSize(prev => [resize, prev[1]!]);
                    }}
                    onCollapse={() => {
                        setIsCollapsed(true);
                        document.cookie = `react-resizable-panels:collapsed=${JSON.stringify(
                            true
                        )}`;
                    }}
                    onExpand={() => {
                        setIsCollapsed(false);
                        document.cookie = `react-resizable-panels:collapsed=${JSON.stringify(
                            false
                        )}`;
                    }}
                    className={cn(
                        'hidden lg:block',
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
                                    Drive
                                </h1>
                            </div>
                        </Link>
                        <ThemeToggle />
                    </div>
                    <Separator className='mb-4' />
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
