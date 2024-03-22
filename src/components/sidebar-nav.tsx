'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LucideIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type SidebarItem = {
    label: string;
    icon: LucideIcon;
    route: string;
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
            <nav className='grid gap-2 px-2 group-[[data-collapsed=true]]:justify-center group-[[data-collapsed=true]]:px-2'>
                {links.map((link, index) => {
                    const isActive = path.startsWith(link.route.toString());

                    return isCollapsed ? (
                        <Tooltip key={index} delayDuration={0}>
                            <TooltipTrigger asChild>
                                <Link
                                    href={link.route}
                                    className={cn(
                                        'inline-flex items-center whitespace-nowrap text-sm font-medium ring-offset-background transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                                        'disabled:pointer-events-none disabled:opacity-50',
                                        'h-9 w-full justify-start rounded-md px-3',
                                        isActive && 'bg-primary/5 text-primary',
                                        !isActive &&
                                            'hover:bg-accent-foreground/5 hover:text-accent-foreground'
                                    )}>
                                    <link.icon className='size-4' />
                                    <span className='sr-only'>{link.label}</span>
                                </Link>
                            </TooltipTrigger>
                            <TooltipContent side='right' className='flex items-center gap-4'>
                                {link.label}
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <Link
                            key={index}
                            href={link.route}
                            className={cn(
                                'inline-flex items-center whitespace-nowrap text-sm font-medium ring-offset-background transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                                'disabled:pointer-events-none disabled:opacity-50',
                                'h-9 w-full justify-start rounded-md px-3',
                                isActive && 'border-l-4 border-primary bg-primary/5 text-primary',
                                !isActive &&
                                    'hover:bg-accent-foreground/5 hover:text-accent-foreground'
                            )}>
                            <link.icon className='mr-2 size-4' />
                            {link.label}
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
