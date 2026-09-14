import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { cn } from 'cn';
import { SearchIcon } from 'lucide-react';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/* The command palette: the same rules, faces and row height as the menus. */
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            data-slot="command"
            className={cn(
                'flex size-full flex-col overflow-hidden bg-popover text-popover-foreground',
                className,
            )}
            {...props}
        />
    );
}

function CommandDialog({
    title = 'Command palette',
    description = 'Search for a command to run.',
    children,
    className,
    ...props
}: Omit<React.ComponentProps<typeof Dialog>, 'children'> & {
    title?: string;
    description?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <Dialog {...props}>
            <DialogContent
                className={cn('top-[18%] translate-y-0 gap-0 p-0 sm:max-w-lg', className)}
                showCloseButton={false}
            >
                <DialogHeader className="sr-only">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <Command>{children}</Command>
            </DialogContent>
        </Dialog>
    );
}

function CommandInput({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
    return (
        <div
            data-slot="command-input-wrapper"
            className="flex h-12 items-center gap-2.5 border-b px-3.5"
        >
            <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
                data-slot="command-input"
                className={cn(
                    'h-full w-full bg-transparent font-mono text-sm text-foreground outline-hidden placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50',
                    className,
                )}
                {...props}
            />
        </div>
    );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
    return (
        <CommandPrimitive.List
            data-slot="command-list"
            className={cn(
                'max-h-80 scroll-py-1 overflow-x-hidden overflow-y-auto p-1 outline-none',
                className,
            )}
            {...props}
        />
    );
}

function CommandEmpty({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
    return (
        <CommandPrimitive.Empty
            data-slot="command-empty"
            className={cn('py-8 text-center font-mono text-xs text-muted-foreground', className)}
            {...props}
        />
    );
}

function CommandGroup({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
    return (
        <CommandPrimitive.Group
            data-slot="command-group"
            className={cn(
                'overflow-hidden text-foreground **:[[cmdk-group-heading]]:eyebrow **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-muted-foreground',
                className,
            )}
            {...props}
        />
    );
}

function CommandSeparator({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
    return (
        <CommandPrimitive.Separator
            data-slot="command-separator"
            className={cn('-mx-1 my-1 h-px bg-border', className)}
            {...props}
        />
    );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
    return (
        <CommandPrimitive.Item
            data-slot="command-item"
            className={cn(
                "group/command-item relative flex cursor-default items-center gap-2 px-2 py-2 font-mono text-[13px] outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[selected=true]:*:[svg]:text-accent-foreground",
                className,
            )}
            {...props}
        />
    );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
    return (
        <span
            data-slot="command-shortcut"
            className={cn(
                'ml-auto text-xs tracking-widest text-muted-foreground group-data-[selected=true]/command-item:text-accent-foreground',
                className,
            )}
            {...props}
        />
    );
}

export {
    Command,
    CommandDialog,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
    CommandShortcut,
    CommandSeparator,
};
