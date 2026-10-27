import { useDialKit } from 'dialkit';
import {
    CopyIcon,
    DownloadIcon,
    FolderInputIcon,
    MoreHorizontalIcon,
    PencilIcon,
    Share2Icon,
    TagIcon,
    Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
    CommandShortcut,
} from '@/components/ui/command';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Demo, Row } from '@/dev/demo';

export function DialogDemo() {
    return (
        <Demo
            id="dialog"
            title="Dialog and alert dialog"
            note="Sheet radius, xl shadow over the scrim. The confirm repeats the verb."
        >
            <Row>
                <Dialog>
                    <DialogTrigger render={<Button variant="outline" />}>Rename</DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Rename</DialogTitle>
                            <DialogDescription>
                                Only the name changes. Links keep working.
                            </DialogDescription>
                        </DialogHeader>
                        <Input defaultValue="Lisbon 2026" aria-label="Name" />
                        <DialogFooter>
                            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                            <DialogClose render={<Button />}>Rename</DialogClose>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
                <AlertDialog>
                    <AlertDialogTrigger render={<Button variant="destructive-outline" />}>
                        Turn off link
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Turn off this link?</AlertDialogTitle>
                            <AlertDialogDescription>
                                Anyone who has it can’t open “Lisbon 2026” any more.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                                className={buttonVariants({ variant: 'destructive' })}
                            >
                                Turn off link
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </Row>
        </Demo>
    );
}

export function SheetDemo() {
    return (
        <Demo
            id="sheet"
            title="Sheet"
            note="Slides in from an edge: the phone's sidebar, a details panel on a narrow window."
        >
            <Row>
                {(['right', 'bottom', 'left', 'top'] as const).map((side) => (
                    <Sheet key={side}>
                        <SheetTrigger render={<Button variant="outline" />}>
                            From the {side}
                        </SheetTrigger>
                        <SheetContent side={side}>
                            <SheetHeader>
                                <SheetTitle>Info</SheetTitle>
                                <SheetDescription>
                                    You and Sam can open this folder.
                                </SheetDescription>
                            </SheetHeader>
                            <SheetFooter>
                                <Button>Share</Button>
                            </SheetFooter>
                        </SheetContent>
                    </Sheet>
                ))}
            </Row>
        </Demo>
    );
}

export function MenuDemo() {
    const dial = useDialKit(
        'Menu item',
        {
            height: [36, 28, 48],
            paddingX: [8, 4, 16],
            radius: [10, 0, 16],
            gap: [8, 4, 16],
            iconSize: [16, 12, 20],
        },
        { id: 'menu', defaultCollapsed: true },
    );
    // The menu renders in a portal, so the tuning is a stylesheet keyed on its own class.
    const scope = '.pg-tuned-menu [data-slot="dropdown-menu-item"]';
    return (
        <Demo
            id="menu"
            title="Dropdown and context menu"
            note="Surface cards with the lg shadow and 36px items; menu order, destructive items red and last."
        >
            <style>{`${scope} { min-height: ${dial.height}px; padding-inline: ${dial.paddingX}px; border-radius: ${dial.radius}px; gap: ${dial.gap}px; }
${scope} svg { width: ${dial.iconSize}px; height: ${dial.iconSize}px; }`}</style>
            <Row>
                <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="outline" />}>
                        <MoreHorizontalIcon />
                        More
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="pg-tuned-menu w-56">
                        <DropdownMenuGroup>
                            <DropdownMenuItem>
                                <Share2Icon />
                                Share
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                                <DownloadIcon />
                                Download
                                <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                                <FolderInputIcon />
                                Move
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                                <CopyIcon />
                                Copy
                            </DropdownMenuItem>
                            <DropdownMenuItem>
                                <PencilIcon />
                                Rename
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <TagIcon />
                                    Tags
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuCheckboxItem checked>
                                        Family
                                    </DropdownMenuCheckboxItem>
                                    <DropdownMenuCheckboxItem>Work</DropdownMenuCheckboxItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                            <DropdownMenuRadioGroup value="name">
                                <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="changed">
                                    Changed
                                </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled>
                            <DownloadIcon />
                            Disabled
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive">
                            <Trash2Icon />
                            Move to Trash
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <ContextMenu>
                    <ContextMenuTrigger className="flex h-24 w-64 items-center justify-center rounded-xl border border-dashed border-input text-sm text-muted-foreground">
                        Right-click here
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem>Share</ContextMenuItem>
                        <ContextMenuItem>Download</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive">Move to Trash</ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
            </Row>
        </Demo>
    );
}

export function PopoverDemo() {
    return (
        <Demo
            id="popover"
            title="Popover and tooltip"
            note="A popover holds a little UI; a tooltip names an icon or says the full sentence."
        >
            <Row>
                <Popover>
                    <PopoverTrigger render={<Button variant="outline" />}>
                        Who can open
                    </PopoverTrigger>
                    <PopoverContent>
                        <p className="p-1 text-sm">You, Sam and anyone with the link.</p>
                    </PopoverContent>
                </Popover>
                <Tooltip>
                    <TooltipTrigger
                        render={<Button variant="ghost" size="icon" aria-label="Download" />}
                    >
                        <DownloadIcon />
                    </TooltipTrigger>
                    <TooltipContent>Download</TooltipContent>
                </Tooltip>
            </Row>
        </Demo>
    );
}

export function CommandDemo() {
    const [open, setOpen] = useState(false);
    const items = (
        <>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandGroup heading="Files and folders">
                <CommandItem>Lisbon 2026</CommandItem>
                <CommandItem>Budget.xlsx</CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Go to">
                <CommandItem>
                    Shared
                    <CommandShortcut>G S</CommandShortcut>
                </CommandItem>
                <CommandItem>
                    Trash
                    <CommandShortcut>G T</CommandShortcut>
                </CommandItem>
            </CommandGroup>
        </>
    );
    return (
        <Demo
            id="command"
            title="Command palette"
            note="Search files and folders or run a command; / or ⌘K in the app."
        >
            <Command className="max-w-md rounded-xl border border-rule">
                <CommandInput placeholder="Search files and commands" />
                <CommandList>{items}</CommandList>
            </Command>
            <Row>
                <Button variant="outline" onClick={() => setOpen(true)}>
                    Open in its dialog
                </Button>
            </Row>
            <CommandDialog open={open} onOpenChange={setOpen}>
                <CommandInput placeholder="Search files and commands" />
                <CommandList>{items}</CommandList>
            </CommandDialog>
        </Demo>
    );
}

export function ToastDemo() {
    return (
        <Demo
            id="toast"
            title="Toast"
            note="A dark notice at the bottom right: one line, an optional description, at most one way back. Goes after 3.5s."
        >
            <Row>
                <Button variant="outline" onClick={() => toast.add({ title: 'Link copied' })}>
                    Plain
                </Button>
                <Button
                    variant="outline"
                    onClick={() =>
                        toast.add({
                            title: 'Moved to Trash',
                            description: '“Budget.xlsx” stays there for 30 days.',
                        })
                    }
                >
                    With a description
                </Button>
                <Button
                    variant="outline"
                    onClick={() =>
                        toast.add({
                            title: '3 items moved to Trash',
                            actionProps: {
                                children: 'Undo',
                                onClick: () => toast.add({ title: 'Put back' }),
                            },
                        })
                    }
                >
                    With Undo
                </Button>
                <Button
                    variant="outline"
                    onClick={() => toast.add({ type: 'warning', title: 'Storage is almost full' })}
                >
                    Warning
                </Button>
                <Button
                    variant="outline"
                    onClick={() => toast.add({ type: 'error', title: 'Couldn’t copy the link' })}
                >
                    Error
                </Button>
                <Button
                    variant="outline"
                    onClick={() => toast.add({ type: 'loading', title: 'Locking', timeout: 0 })}
                >
                    Loading
                </Button>
            </Row>
        </Demo>
    );
}
