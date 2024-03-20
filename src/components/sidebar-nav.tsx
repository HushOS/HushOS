'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LucideIcon } from 'lucide-react';

import { ButtonProps, buttonVariants } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type SidebarItem = {
    label: string;
    icon: LucideIcon;
    routeOrAction: string | (() => Promise<void>);
};

type SidebarNavProps = {
    isCollapsed: boolean;
    links: Array<SidebarItem>;
};

export function SidebarNav({ links, isCollapsed }: SidebarNavProps) {
    const path = usePathname();

    return (
        <div
            data-collapsed={isCollapsed}
            className='group flex flex-1 flex-col gap-4 py-2 data-[collapsed=true]:py-2'>
            <nav className='grid gap-1 px-2 group-[[data-collapsed=true]]:justify-center group-[[data-collapsed=true]]:px-2'>
                {links.map((link, index) => {
                    const variant: ButtonProps['variant'] = path.startsWith(
                        link.routeOrAction.toString()
                    )
                        ? 'default'
                        : 'ghost';

                    let routeOrAction;
                    if (typeof link.routeOrAction === 'function') {
                        routeOrAction = isCollapsed ? (
                            <form action={link.routeOrAction}>
                                <button
                                    className={cn(
                                        buttonVariants({ variant, size: 'icon' }),
                                        'size-9',
                                        variant === 'default' &&
                                            'dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-white'
                                    )}>
                                    <link.icon className='size-4' />
                                    <span className='sr-only'>{link.label}</span>
                                </button>
                            </form>
                        ) : (
                            <form action={link.routeOrAction}>
                                <button
                                    className={cn(
                                        buttonVariants({ variant, size: 'sm' }),
                                        variant === 'default' &&
                                            'dark:bg-muted dark:text-white dark:hover:bg-muted dark:hover:text-white',
                                        'w-full justify-start'
                                    )}>
                                    <link.icon className='mr-2 size-4' />
                                    {link.label}
                                </button>
                            </form>
                        );
                    } else {
                        routeOrAction = isCollapsed ? (
                            <Link
                                href={link.routeOrAction}
                                className={cn(
                                    buttonVariants({ variant, size: 'icon' }),
                                    'size-9',
                                    variant === 'default' &&
                                        'dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-white'
                                )}>
                                <link.icon className='size-4' />
                                <span className='sr-only'>{link.label}</span>
                            </Link>
                        ) : (
                            <Link
                                href={link.routeOrAction}
                                className={cn(
                                    buttonVariants({ variant, size: 'sm' }),
                                    variant === 'default' &&
                                        'dark:bg-muted dark:text-white dark:hover:bg-muted dark:hover:text-white',
                                    'w-full justify-start'
                                )}>
                                <link.icon className='mr-2 size-4' />
                                {link.label}
                            </Link>
                        );
                    }

                    return isCollapsed ? (
                        <Tooltip key={index} delayDuration={0}>
                            <TooltipTrigger asChild>{routeOrAction}</TooltipTrigger>
                            <TooltipContent side='right' className='flex items-center gap-4'>
                                {link.label}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <Fragment key={index}>{routeOrAction}</Fragment>
                    );
                })}
            </nav>
        </div>
    );
}
