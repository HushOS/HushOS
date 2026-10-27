import { useDialKit } from 'dialkit';
import { FolderIcon, HomeIcon, MoreHorizontalIcon, Share2Icon, Trash2Icon } from 'lucide-react';

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    Breadcrumb,
    BreadcrumbEllipsis,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSkeleton,
    SidebarProvider,
} from '@/components/ui/sidebar';
import { Demo, Row, Sample } from '@/dev/demo';

const ALERTS = [
    {
        variant: 'default',
        title: 'Nothing is shared yet',
        body: 'Share a folder and it shows here.',
    },
    {
        variant: 'info',
        title: 'Sam changed their account',
        body: 'Check it’s them before you share anything new.',
    },
    {
        variant: 'success',
        title: 'Payment received',
        body: 'Family Plus is live. Everyone has the new storage.',
    },
    {
        variant: 'warning',
        title: 'Family Plus is paused',
        body: 'The family’s storage is empty until it resumes. Nothing is deleted.',
    },
    {
        variant: 'destructive',
        title: 'The payment didn’t go through',
        body: 'Nobody new can join until it’s paid or replaced.',
    },
] as const;

export function AlertDemo() {
    const dial = useDialKit(
        'Alert',
        {
            paddingX: [16, 8, 32],
            paddingY: [12, 4, 24],
            radius: [16, 0, 24],
            columnGap: [12, 4, 24],
            icon: { size: [16, 12, 24], offsetY: [2, -2, 6, 0.5] },
        },
        { id: 'alert', defaultCollapsed: true },
    );
    const scope = '[data-tune="alert"] [data-slot="alert"]';
    return (
        <Demo
            id="alert"
            title="Alert"
            note="Anything the person must act on: the status colour on its soft fill, a title, a sentence, at most one action."
            className="max-w-xl"
        >
            <style>{`${scope} { padding: ${dial.paddingY}px ${dial.paddingX}px; border-radius: ${dial.radius}px; column-gap: ${dial.columnGap}px; }
${scope} > svg { width: ${dial.icon.size}px; height: ${dial.icon.size}px; translate: 0 ${dial.icon.offsetY}px; transform: none; }`}</style>
            <div data-tune="alert" className="flex flex-col gap-3">
                {ALERTS.map((alert) => (
                    <Alert key={alert.variant} variant={alert.variant}>
                        <AlertTitle>{alert.title}</AlertTitle>
                        <AlertDescription>{alert.body}</AlertDescription>
                        {alert.variant === 'destructive' && (
                            <AlertAction>
                                <Button variant="outline">Manage payment</Button>
                            </AlertAction>
                        )}
                    </Alert>
                ))}
            </div>
        </Demo>
    );
}

export function CardDemo() {
    return (
        <Demo id="card" title="Card" note="An inline card: surface and a rule hairline, no shadow.">
            <Row>
                {(['default', 'sm'] as const).map((size) => (
                    <Sample key={size} caption={size} className="w-72">
                        <Card size={size}>
                            <CardHeader>
                                <CardTitle>This browser</CardTitle>
                                <CardDescription>Signed in since 3 October</CardDescription>
                                <CardAction>
                                    <Button variant="ghost" size="icon-sm" aria-label="More">
                                        <MoreHorizontalIcon />
                                    </Button>
                                </CardAction>
                            </CardHeader>
                            <CardContent>Unlocks with your password on this device.</CardContent>
                            <CardFooter>
                                <Button variant="outline">Lock now</Button>
                            </CardFooter>
                        </Card>
                    </Sample>
                ))}
            </Row>
        </Demo>
    );
}

export function AccordionDemo() {
    return (
        <Demo
            id="accordion"
            title="Accordion"
            note="The two folds under Info: Keep your own copy, Technical details."
            className="max-w-xl"
        >
            <Accordion>
                <AccordionItem value="copy">
                    <AccordionTrigger>Keep your own copy</AccordionTrigger>
                    <AccordionContent>
                        Download the file, or save it to your files.
                    </AccordionContent>
                </AccordionItem>
                <AccordionItem value="technical">
                    <AccordionTrigger>Technical details</AccordionTrigger>
                    <AccordionContent>Version 3, sealed with content suite 2.</AccordionContent>
                </AccordionItem>
            </Accordion>
        </Demo>
    );
}

export function BreadcrumbDemo() {
    return (
        <Demo
            id="breadcrumb"
            title="Breadcrumb"
            note="A folder's path; the last place is the page."
        >
            <Breadcrumb>
                <BreadcrumbList>
                    <BreadcrumbItem>
                        <BreadcrumbLink href="#breadcrumb">My files</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                        <BreadcrumbEllipsis />
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                        <BreadcrumbLink href="#breadcrumb">Trips</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                        <BreadcrumbPage>Lisbon 2026</BreadcrumbPage>
                    </BreadcrumbItem>
                </BreadcrumbList>
            </Breadcrumb>
        </Demo>
    );
}

export function ScrollAreaDemo() {
    return (
        <Demo id="scroll-area" title="Scroll area" note="A thin bar with a quiet thumb.">
            <ScrollArea className="h-40 w-64 rounded-xl border border-rule">
                <ul className="flex flex-col p-3 text-sm">
                    {Array.from({ length: 16 }, (_, index) => (
                        <li key={index} className="py-1.5">
                            IMG_{4200 + index}.heic
                        </li>
                    ))}
                </ul>
            </ScrollArea>
        </Demo>
    );
}

export function SidebarDemo() {
    const places = [
        { label: 'Home', icon: HomeIcon, active: false },
        { label: 'My files', icon: FolderIcon, active: true },
        { label: 'Shared', icon: Share2Icon, active: false, badge: '3' },
        { label: 'Trash', icon: Trash2Icon, active: false },
    ];
    return (
        <Demo
            id="sidebar"
            title="Sidebar"
            note="The app's places on the ground. The active place is tint, a bold label and a heavier icon."
        >
            <SidebarProvider className="min-h-0 w-fit">
                <Sidebar collapsible="none" className="h-auto rounded-xl border border-rule">
                    <SidebarContent>
                        <SidebarGroup>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {places.map((place) => (
                                        <SidebarMenuItem key={place.label}>
                                            <SidebarMenuButton isActive={place.active}>
                                                <place.icon strokeWidth={place.active ? 2.4 : 2} />
                                                <span>{place.label}</span>
                                            </SidebarMenuButton>
                                            {place.badge && (
                                                <SidebarMenuBadge>{place.badge}</SidebarMenuBadge>
                                            )}
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                        <SidebarGroup>
                            <SidebarGroupLabel>Loading</SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    <SidebarMenuItem>
                                        <SidebarMenuSkeleton showIcon />
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                </Sidebar>
            </SidebarProvider>
        </Demo>
    );
}
