import { fileTypeHue } from '@hushos/drive/client';
import { ChevronRightIcon, FolderPlusIcon } from 'lucide-react';
import { useEffect, useId, useReducer, useRef, type ReactNode } from 'react';
import { FolderMark } from '@/components/folder-mark';
import { SheetMark } from '@/components/sheet-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    AppWindow,
    Checked,
    FAMILY,
    JONAS,
    MAYA,
    PersonRow,
    SAM,
    Section,
    ServerKnows,
    Sidebar,
} from './faux';
import { DEMO_START, foldersDemo, NAME_MAX, type DemoFolder } from './folders-demo-state';

/*
 * The family's folders beside your own, as a small demo to click through: the family's folders,
 * each opening to a few of the demo account's files; Members, the family's members as its page
 * shows them; and New family folder, which adds one. All of it is local state (folders-demo-state),
 * nothing saved or sent, and it says so. The sidebar is a picture of where these live (My files,
 * Family folders under it, the family's storage at its foot), inert, so it never pretends to be a
 * page. Nothing in it animates, so reduced motion changes nothing.
 */

/* The family's storage at the sidebar's foot: the storage view's opening figures (3 × 300 GB + 300 GB). */
function PoolMeter() {
    return (
        <span className="flex flex-col gap-1.5">
            <span className="truncate text-xs font-semibold text-muted-foreground">{FAMILY}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <span className="block h-full w-[59%] rounded-full bg-primary" />
            </span>
            <span className="text-[13px] tabular-nums">1.17 TB of 2 TB used</span>
            <span className="text-[13px] text-muted-foreground tabular-nums">848 GB free</span>
        </span>
    );
}

function extension(name: string) {
    const dot = name.lastIndexOf('.');
    return dot > 0
        ? name
              .slice(dot + 1)
              .toUpperCase()
              .slice(0, 4)
        : '';
}

/* A row in the demo's lists, at the app's 56px with its 36px mark. */
const row =
    'flex min-h-14 w-full items-center gap-3 border-b border-rule px-5 py-2 text-left sm:px-6';

function Header({
    title,
    description,
    actions,
    titleRef,
}: {
    title: ReactNode;
    description?: string;
    actions?: ReactNode;
    titleRef: React.Ref<HTMLParagraphElement>;
}) {
    return (
        <div className="flex flex-col gap-1 px-5 pt-5 pb-4 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                {/* Where focus lands when the view changes, so a screen reader hears where it is. */}
                <p
                    ref={titleRef}
                    tabIndex={-1}
                    className="text-[22px] leading-tight font-extrabold tracking-[-0.03em] outline-none"
                >
                    {title}
                </p>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
    );
}

export function FamilyFoldersDemo() {
    const [state, dispatch] = useReducer(foldersDemo, DEMO_START);
    const titleRef = useRef<HTMLParagraphElement>(null);
    const newRef = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const dialogTitle = useId();
    const { view, naming } = state;
    const viewKey = view.kind === 'folder' ? `folder:${view.id}` : view.kind;
    const first = useRef(true);
    useEffect(() => {
        // Not on the page's first render: only when the reader changed the view.
        if (first.current) {
            first.current = false;
            return;
        }
        titleRef.current?.focus();
    }, [viewKey]);
    const open = naming !== null;
    const wasOpen = useRef(false);
    useEffect(() => {
        if (open) inputRef.current?.focus();
        else if (wasOpen.current) newRef.current?.focus();
        wasOpen.current = open;
    }, [open]);

    // Escape cancels New family folder from any of its controls, as the app's dialogs do.
    const escape = (event: React.KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        dispatch({ type: 'cancel' });
    };

    const folder: DemoFolder | undefined =
        view.kind === 'folder' ? state.folders.find((at) => at.id === view.id) : undefined;

    let body: ReactNode;
    if (view.kind === 'members')
        body = (
            <>
                <Header
                    titleRef={titleRef}
                    title={FAMILY}
                    description="3 of 4 places taken."
                    actions={
                        <Button variant="outline" onClick={() => dispatch({ type: 'back' })}>
                            Family folders
                        </Button>
                    }
                />
                <Section title="Members" className="max-sm:px-5">
                    <PersonRow person={MAYA} you badge="Organizer" />
                    <PersonRow person={JONAS}>
                        <Checked verified />
                    </PersonRow>
                    <PersonRow person={SAM} className="border-b-0">
                        <Checked verified />
                    </PersonRow>
                </Section>
            </>
        );
    else if (folder)
        body = (
            <>
                <nav aria-label="Path" className="px-5 pt-4 text-sm sm:px-6">
                    <ol className="flex items-center gap-1">
                        <li>
                            <button
                                type="button"
                                onClick={() => dispatch({ type: 'back' })}
                                className="-mx-1.5 cursor-pointer rounded-sm px-1.5 py-1 font-semibold text-primary outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
                            >
                                {FAMILY}
                            </button>
                        </li>
                        <li aria-hidden="true">
                            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                        </li>
                        <li aria-current="page" className="text-muted-foreground">
                            {folder.name}
                        </li>
                    </ol>
                </nav>
                <Header titleRef={titleRef} title={folder.name} />
                {folder.files.length ? (
                    <ul className="border-t border-rule">
                        {folder.files.map((name) => (
                            <li key={name} className={row}>
                                <SheetMark
                                    box={36}
                                    label={extension(name)}
                                    hue={fileTypeHue(name)}
                                />
                                <span className="flex min-w-0 flex-col gap-0.5">
                                    <span className="truncate text-[15px] font-medium">{name}</span>
                                    <span className="text-[13px] text-muted-foreground">
                                        Same as folder
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="border-t border-rule px-5 py-6 text-[15px] font-semibold sm:px-6">
                        Nothing here yet
                    </p>
                )}
            </>
        );
    else
        body = (
            <>
                <Header
                    titleRef={titleRef}
                    title={FAMILY}
                    description="Family folders. Everyone in the family can open what’s in them."
                    actions={
                        <>
                            <Button variant="outline" onClick={() => dispatch({ type: 'members' })}>
                                Members
                            </Button>
                            <Button ref={newRef} onClick={() => dispatch({ type: 'new' })}>
                                <FolderPlusIcon aria-hidden="true" />
                                New family folder
                            </Button>
                        </>
                    }
                />
                <ul className="border-t border-rule">
                    {state.folders.map((at) => (
                        <li key={at.id}>
                            <button
                                type="button"
                                onClick={() => dispatch({ type: 'open', id: at.id })}
                                className={`${row} cursor-pointer outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring`}
                            >
                                <FolderMark box={36} />
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="truncate text-[15px] font-medium">
                                        {at.name}
                                    </span>
                                    <span className="text-[13px] text-muted-foreground">
                                        Everyone in the family can open it
                                    </span>
                                </span>
                                <ChevronRightIcon
                                    className="size-4 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                />
                            </button>
                        </li>
                    ))}
                </ul>
            </>
        );

    return (
        <section aria-label="Demo of a family’s folders. Nothing here is saved." className="mt-6">
            <AppWindow
                className="relative"
                sidebar={
                    // A picture of where the family's folders live, not a way anywhere.
                    <div inert aria-hidden="true" className="flex max-sm:hidden">
                        <Sidebar
                            active={view.kind === 'members' ? 'family' : 'family-folders'}
                            meter={<PoolMeter />}
                            extras={false}
                        />
                    </div>
                }
                overlay={
                    open && (
                        <>
                            <span className="absolute inset-0 bg-scrim" />
                            {/* A dialog inside the demo, not over the page: open, not modal; the page behind is inert. */}
                            <dialog
                                open
                                aria-labelledby={dialogTitle}
                                className="absolute inset-x-3 top-6 m-0 w-auto rounded-2xl border border-edge bg-popover p-6 text-popover-foreground shadow-xl sm:inset-x-auto sm:left-1/2 sm:w-[400px] sm:-translate-x-1/2"
                            >
                                <form
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        dispatch({ type: 'create' });
                                    }}
                                    className="flex flex-col gap-4"
                                >
                                    <div className="flex flex-col gap-1.5">
                                        <p
                                            id={dialogTitle}
                                            className="text-[19px] leading-tight font-bold tracking-[-0.015em]"
                                        >
                                            New family folder
                                        </p>
                                        <p className="text-sm leading-snug text-muted-foreground">
                                            Everyone in {FAMILY} can open it, and anyone who joins
                                            later.
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <label
                                            htmlFor={`${dialogTitle}-name`}
                                            className="text-[13px] font-semibold"
                                        >
                                            Name
                                        </label>
                                        <Input
                                            ref={inputRef}
                                            id={`${dialogTitle}-name`}
                                            autoComplete="off"
                                            maxLength={NAME_MAX}
                                            value={naming}
                                            onChange={(event) =>
                                                dispatch({
                                                    type: 'name',
                                                    value: event.target.value,
                                                })
                                            }
                                            placeholder="Photos"
                                            onKeyDown={escape}
                                        />
                                    </div>
                                    <div className="flex justify-end gap-2">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() => dispatch({ type: 'cancel' })}
                                            onKeyDown={escape}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            type="submit"
                                            disabled={!naming.trim()}
                                            onKeyDown={escape}
                                        >
                                            Create folder
                                        </Button>
                                    </div>
                                </form>
                            </dialog>
                        </>
                    )
                }
            >
                {/* While the dialog is open, the page behind it is out of reach, as in the app. */}
                <div inert={open} className="flex flex-1 flex-col">
                    {body}
                    <ServerKnows className="max-sm:px-5" />
                </div>
            </AppWindow>
            <p className="mt-2 text-[13px] text-muted-foreground">
                Try it: open a folder, Members or New family folder. Nothing here is saved.
            </p>
        </section>
    );
}
