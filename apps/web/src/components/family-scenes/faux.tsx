import { cn } from 'cn';
import {
    CheckIcon,
    ContactIcon,
    FolderIcon,
    FoldersIcon,
    HouseIcon,
    MailIcon,
    Share2Icon,
    TagIcon,
    Trash2Icon,
    UsersIcon,
    type LucideIcon,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Wordmark } from '@/components/brand';
import { PersonAvatar } from '@/components/person-avatar';
import { buttonVariants } from '@/components/ui/button';

/*
 * The app's own furniture, drawn as a picture for the family plans post: the sidebar, the page
 * panel, a section with its rule, member rows, buttons, a dialog and a toast, from the same
 * tokens, classes and components as the app (buttonVariants, PersonAvatar, the dialog's and the
 * toast's classes). Nothing here is a control: no buttons, links, headings or focus, since each
 * scene is one image (role="img") with its story said in its label. `data-target` names what a
 * scene's cursor aims at (Stageshow's Act).
 */

/* The people in every scene: one family, as DESIGN.md names it. */
export const MAYA = { name: 'Maya Lindqvist', email: 'maya@example.com', seed: 'maya' };
export const SAM = { name: 'Sam Ortega', email: 'sam@example.com', seed: 'sam-ortega' };
export const FAMILY = 'Lindqvist family';

/* The app's window: the ground, the sidebar on it, and the page panel inset beside it. */
export function AppWindow({
    sidebar,
    children,
    overlay,
    className,
    style,
}: {
    sidebar?: ReactNode;
    children: ReactNode;
    /* What covers the whole window: a dialog over its scrim, a toast. */
    overlay?: ReactNode;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <div
            className={cn(
                'absolute flex overflow-hidden rounded-[10px] bg-background ring-1 ring-rule ring-inset',
                className,
            )}
            style={style}
        >
            {sidebar}
            <div className="relative m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-panel ring-1 ring-rule">
                {children}
            </div>
            {overlay}
        </div>
    );
}

type Place = 'family' | 'home' | 'files' | 'family-folders' | 'shared' | 'trash';

const PLACES: { place: Place; label: string; icon: LucideIcon }[] = [
    { place: 'home', label: 'Home', icon: HouseIcon },
    { place: 'files', label: 'My files', icon: FolderIcon },
    { place: 'family-folders', label: 'Family folders', icon: FoldersIcon },
    { place: 'shared', label: 'Shared', icon: Share2Icon },
    { place: 'trash', label: 'Trash', icon: Trash2Icon },
];

function SidebarItem({
    active,
    icon: Icon,
    children,
    target,
}: {
    active?: boolean;
    icon?: LucideIcon;
    children: ReactNode;
    target?: string;
}) {
    return (
        <span
            data-target={target}
            className={cn(
                'flex h-9 items-center gap-2.5 rounded-md px-3 text-sm',
                active ? 'bg-tint font-semibold text-on-tint' : 'text-foreground',
            )}
        >
            {Icon && (
                <Icon
                    className="size-[18px] shrink-0"
                    strokeWidth={active ? 2.25 : 1.75}
                    aria-hidden="true"
                />
            )}
            <span className="truncate">{children}</span>
        </span>
    );
}

/*
 * The sidebar as someone in a family sees it: the family's name first, then the places with
 * Family folders under My files, then Tags and Contacts, and a storage meter at the foot.
 */
export function Sidebar({
    active,
    family = FAMILY,
    meter,
}: {
    active: Place;
    family?: string | null;
    meter?: ReactNode;
}) {
    return (
        <div className="flex w-[184px] shrink-0 flex-col gap-4 px-2 py-4">
            <Wordmark className="px-3" />
            <div className="flex flex-col gap-0.5">
                {family && (
                    <span
                        className={cn(
                            'mb-1 flex h-9 items-center gap-2.5 rounded-md px-3 text-sm font-semibold',
                            active === 'family' && 'bg-tint text-on-tint',
                        )}
                    >
                        <PersonAvatar name={family} seed="lindqvist" size={20} className="-mx-px" />
                        <span className="truncate">{family}</span>
                    </span>
                )}
                {PLACES.filter((item) => family || item.place !== 'family-folders').map((item) => (
                    <SidebarItem key={item.place} icon={item.icon} active={active === item.place}>
                        {item.label}
                    </SidebarItem>
                ))}
            </div>
            <div className="flex flex-col gap-0.5">
                <SidebarItem icon={TagIcon}>Tags</SidebarItem>
                <SidebarItem icon={ContactIcon}>Contacts</SidebarItem>
                {/* Someone in no family finds Family here, after Contacts. */}
                {!family && (
                    <SidebarItem icon={UsersIcon} active={active === 'family'}>
                        Family
                    </SidebarItem>
                )}
            </div>
            {meter && <div className="mt-auto px-3">{meter}</div>}
        </div>
    );
}

/* The page's title row, at the app's page-title scale, with its actions on the right. */
export function Title({
    children,
    actions,
    description,
}: {
    children: ReactNode;
    actions?: ReactNode;
    description?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1 px-6 pt-5 pb-4">
            <div className="flex items-center justify-between gap-4">
                <span className="text-[22px] leading-tight font-extrabold tracking-[-0.03em]">
                    {children}
                </span>
                {actions && <span className="flex items-center gap-2">{actions}</span>}
            </div>
            {description && (
                <span className="text-sm leading-relaxed text-muted-foreground">{description}</span>
            )}
        </div>
    );
}

/* A section of the family page: its heading with the rule under it, then rows. */
export function Section({
    title,
    description,
    children,
    className,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn('flex flex-col px-6', className)}>
            <span className="flex flex-col gap-0.5 border-b border-rule pb-2">
                <span className="text-base font-bold tracking-[-0.01em]">{title}</span>
                {description && (
                    <span className="text-[13px] leading-snug text-muted-foreground">
                        {description}
                    </span>
                )}
            </span>
            {children}
        </div>
    );
}

/* A person's row, as Members and Waiting to join draw it: avatar, name, address, what's right. */
export function PersonRow({
    person,
    you = false,
    badge,
    mark,
    line,
    children,
    className,
    style,
}: {
    person: { name: string; email: string; seed: string };
    you?: boolean;
    badge?: string;
    /* In place of the avatar: an invitation is an address, not yet anyone. */
    mark?: ReactNode;
    /* In place of the address under the name. */
    line?: string;
    children?: ReactNode;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <span
            className={cn('flex min-h-14 items-center gap-3 border-b border-rule py-2', className)}
            style={style}
        >
            {mark ?? <PersonAvatar name={person.name} seed={person.seed} size={32} />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[15px] font-medium">
                        {person.name}
                        {you && <span className="font-normal text-muted-foreground"> (you)</span>}
                    </span>
                    {badge && (
                        <span className="inline-flex h-5 shrink-0 items-center rounded-xs bg-muted px-1.5 text-[11px] font-semibold">
                            {badge}
                        </span>
                    )}
                </span>
                <span className="truncate text-[13px] text-muted-foreground">
                    {line ?? person.email}
                </span>
            </span>
            {children && <span className="flex shrink-0 items-center gap-2">{children}</span>}
        </span>
    );
}

/* "Verified" with its check, or "Not verified": muted 13px words, as the members list says it. */
export function Checked({ verified }: { verified: boolean }) {
    return (
        <span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground">
            {verified && <CheckIcon className="size-3.5" aria-hidden="true" />}
            {verified ? 'Verified' : 'Not verified'}
        </span>
    );
}

/* A button as the app draws it, from buttonVariants, as a picture: no role, no focus. */
export function FauxButton({
    children,
    variant = 'default',
    size = 'default',
    target,
    className,
}: {
    children: ReactNode;
    variant?: 'default' | 'outline' | 'tint' | 'ghost' | 'destructive-ghost';
    size?: 'default' | 'sm';
    target?: string;
    className?: string;
}) {
    return (
        <span
            data-target={target}
            data-cursor={target ? 'pointer' : undefined}
            className={cn(
                buttonVariants({ variant, size }),
                // The scene's press: the cursor marks what it presses, as :active would.
                'cursor-default pointer-coarse:h-9 data-pressed:scale-96',
                className,
            )}
        >
            {children}
        </span>
    );
}

/* A labelled field, as the dialogs draw it: the label above a 44px input. */
export function Field({
    label,
    value,
    focus = false,
    target,
    placeholder,
}: {
    label: string;
    value: string;
    focus?: boolean;
    target?: string;
    placeholder?: string;
}) {
    return (
        <span className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">{label}</span>
            <span
                data-target={target}
                data-cursor={target ? 'ibeam' : undefined}
                className={cn(
                    'flex h-11 items-center rounded-md border border-field bg-card px-3.5 text-[15px] transition-[box-shadow] duration-150',
                    focus && 'border-primary ring-2 ring-primary ring-inset',
                )}
            >
                {value ? (
                    <span className="truncate">{value}</span>
                ) : (
                    <span className="text-muted-foreground">{placeholder}</span>
                )}
                {focus && <span className="ml-px h-[18px] w-px animate-pulse bg-foreground" />}
            </span>
        </span>
    );
}

/*
 * A dialog over a scrim, the app's own (sheet radius, the overlay's shadow): its title, a
 * sentence, what it asks, and its buttons at the foot. It rises in and fades out as the app's does.
 */
export function Dialog({
    open,
    title,
    description,
    children,
    footer,
    className,
    style,
}: {
    open: boolean;
    title: string;
    description?: ReactNode;
    children?: ReactNode;
    footer: ReactNode;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <>
            <span
                className={cn(
                    'absolute inset-0 bg-scrim transition-opacity duration-200',
                    open ? 'opacity-100' : 'opacity-0',
                )}
            />
            <span
                className={cn(
                    'absolute flex flex-col gap-4 rounded-2xl border border-edge bg-popover p-6 text-popover-foreground shadow-xl transition-[opacity,scale] duration-200 ease-out-soft',
                    open ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0',
                    className,
                )}
                style={style}
            >
                <span className="flex flex-col gap-1.5">
                    <span className="text-[19px] leading-tight font-bold tracking-[-0.015em]">
                        {title}
                    </span>
                    {description && (
                        <span className="text-sm leading-snug text-muted-foreground">
                            {description}
                        </span>
                    )}
                </span>
                {children}
                <span className="flex items-center justify-end gap-2 pt-1">{footer}</span>
            </span>
        </>
    );
}

/* The dark notice at the bottom right: a line and an optional description, arriving from just below. */
export function Toast({
    show,
    title,
    description,
    compact = false,
}: {
    show: boolean;
    title: string;
    description?: string;
    /* The phone column's: the width of the window, its line a size down so it stays one line. */
    compact?: boolean;
}) {
    return (
        <span
            className={cn(
                'absolute flex flex-col gap-0.5 rounded-xl bg-snackbar py-3 text-on-snackbar shadow-overlay transition-[opacity,translate] duration-300 ease-out-expo',
                compact
                    ? 'inset-x-2.5 bottom-2.5 px-3.5'
                    : 'right-4 bottom-4 max-w-[calc(100%-2rem)] px-4',
                show ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
            )}
        >
            <span
                className={cn(
                    'font-semibold',
                    compact ? 'text-[13px] whitespace-nowrap' : 'text-sm text-pretty',
                )}
            >
                {title}
            </span>
            {description && <span className="text-[13px] opacity-80">{description}</span>}
        </span>
    );
}

/* Placeholder lines where words would be filler (Stageshow's Bar): the rest of a page, quietly. */
export function Bar({ width, className }: { width: number; className?: string }) {
    return (
        <span
            className={cn('block h-2 rounded-full bg-foreground/8', className)}
            style={{ width }}
        />
    );
}

/*
 * Something that opens its own room as it arrives and closes it as it goes, carrying what's
 * below with it: its height eases while its content fades, never a hard edge across words.
 */
export function Reveal({
    open,
    children,
    className,
}: {
    open: boolean;
    children: ReactNode;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'grid transition-[grid-template-rows,opacity] duration-500 ease-out-soft',
                open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
                className,
            )}
        >
            <span className="min-h-0 overflow-hidden">{children}</span>
        </span>
    );
}

/* An invitation's mark, as the list draws it: an address, not yet anyone. */
export function InviteMark() {
    return (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MailIcon className="size-4" aria-hidden="true" />
        </span>
    );
}

/* A section further down the page, as filler: its real heading, its rows as quiet lines. */
export function QuietSection({ title, rows = [140, 96] }: { title: string; rows?: number[] }) {
    return (
        <Section title={title} className="pt-6">
            {rows.map((width, index) => (
                <span key={index} className="flex min-h-11 items-center gap-6 py-2">
                    <Bar width={64} className="bg-foreground/12" />
                    <Bar width={width} />
                </span>
            ))}
        </Section>
    );
}
