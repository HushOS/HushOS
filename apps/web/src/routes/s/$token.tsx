import { Preview } from '@/components/drive/preview';
import { rememberReturn } from '@/lib/return-to';
import { ReportDialog } from '@/components/drive/report-dialog';
import { FileMark } from '@/components/drive/file-mark';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { Spinner } from '@/components/motion';
import { Brand } from '@/components/brand';
import { PersonAvatar } from '@/components/person-avatar';
import { SiteFooter } from '@/components/site-header';
import { Button, buttonVariants } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { downloadNodes } from '@/lib/downloads';
import {
    driveClient,
    driveError,
    folderQueryOptions,
    formatBytes,
    formatWhen,
    sortNodes,
} from '@/lib/drive';
import { linkApi, setActiveLink } from '@/lib/drive-api';
import { saveCopy } from '@/lib/save-copy';
import { guardUnloadWhileUploading } from '@/lib/transfers';
import { sessionQueryOptions } from '@/lib/session';
import { contentSize, type DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouteContext, useRouter } from '@tanstack/react-router';
import {
    ChevronRightIcon,
    CopyPlusIcon,
    DownloadIcon,
    EyeIcon,
    FlagIcon,
    Link2Icon,
    Link2OffIcon,
    LockIcon,
    RotateCcwIcon,
    TriangleAlertIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';

/*
 * A link opened by anyone: the path token names the share, the fragment
 * secret (never sent to the server) opens the key on this device, and an
 * optional password is stretched here first. No account, no session; the
 * crypto worker holds the folder key for as long as the tab is open.
 */
export const Route = createFileRoute('/s/$token')({
    validateSearch: (search: Record<string, unknown>): { folder?: string; preview?: string } => {
        const id = (value: unknown) =>
            typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;
        const folder = id(search.folder);
        const preview = id(search.preview);
        return { ...(folder ? { folder } : {}), ...(preview ? { preview } : {}) };
    },
    head: () => ({ meta: [{ title: 'Shared with a link · HushOS' }] }),
    component: LinkPage,
});

type Opened = Awaited<ReturnType<typeof driveClient.openLink>> & {
    /* What opened it, kept so the key can be opened again after this device unlocks an account. */
    token: string;
    secret: string;
    password: string | null;
};

function LinkPage() {
    const { token } = Route.useParams();
    // The fragment is read on the client only: the server never sees it and renders a spinner.
    const secret = useSyncExternalStore(
        (onChange) => {
            window.addEventListener('hashchange', onChange);
            return () => window.removeEventListener('hashchange', onChange);
        },
        () => window.location.hash.slice(1) || null,
        () => undefined,
    );
    const meta = useQuery({
        queryKey: ['link', token],
        queryFn: () => linkApi.open(token),
        retry: false,
        enabled: secret !== undefined,
    });
    const [opened, setOpened] = useState<Opened | null>(null);
    useEffect(() => () => setActiveLink(null), []);

    return (
        <div className="flex min-h-dvh flex-col">
            <LinkHeader />
            <main className="flex flex-1 flex-col">
                {secret === undefined || (meta.isPending && secret) ? (
                    <Opening />
                ) : secret === null ? (
                    <MissingKey />
                ) : meta.isError ? (
                    <Card
                        icon={<Link2OffIcon className="size-6" aria-hidden="true" />}
                        tone="quiet"
                    >
                        <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">
                            This link no longer works
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            Whoever shared it turned it off, or it reached its end date. Ask them
                            for a new link.
                        </p>
                    </Card>
                ) : opened ? (
                    <LinkContents opened={opened} />
                ) : (
                    <Unlock
                        token={token}
                        secret={secret}
                        hasPassword={meta.data!.link.hasPassword}
                        onOpened={(result) => {
                            setActiveLink({ token, workspaceId: result.link.workspaceId });
                            setOpened(result);
                        }}
                    />
                )}
            </main>
            <SiteFooter />
        </div>
    );
}

/*
 * A link page's own header: the logo, and either who is signed in or the two ways
 * in. Signing in from here comes back to this link, key and all.
 */
function LinkHeader() {
    const { hasSession } = useRouteContext({ from: '__root__' });
    const session = useQuery({ ...sessionQueryOptions, enabled: Boolean(hasSession) });
    const user = session.data ?? null;
    return (
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-rule bg-card px-4 sm:px-8">
            <Brand to={user ? '/app/drive' : '/'} className="h-9 px-1" />
            {user ? (
                <Link
                    to="/app/drive"
                    className="flex items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-[13px] font-semibold hover:bg-muted"
                >
                    <PersonAvatar name={user.name} seed={user.id} size={32} />
                    <span className="max-sm:hidden">{user.name}</span>
                </Link>
            ) : (
                <span className="flex items-center gap-2">
                    <Link to="/" className={buttonVariants({ variant: 'ghost' })}>
                        Get HushOS
                    </Link>
                    <Link
                        to="/login"
                        className={buttonVariants({ variant: 'outline' })}
                        onClick={() =>
                            rememberReturn(
                                window.location.pathname +
                                    window.location.search +
                                    window.location.hash,
                            )
                        }
                    >
                        Sign in
                    </Link>
                </span>
            )}
        </header>
    );
}

/*
 * The link arrived without the part after the #. That part is the key, and
 * some people send it separately on purpose: a box takes it, or the whole link,
 * and putting it in the address opens the link as if it had been whole.
 */
function MissingKey() {
    const id = useId();
    const [value, setValue] = useState('');
    const key = value.trim().replace(/^.*#/, '');
    return (
        <Card icon={<TriangleAlertIcon className="size-6" aria-hidden="true" />} tone="danger">
            <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">
                This link is incomplete
            </h1>
            <p className="text-sm text-muted-foreground">
                The end of the link is missing, usually because it was cut off while copying. Paste
                the whole link, or the part after the # if it was sent separately.
            </p>
            <form
                className="flex w-full gap-2 pt-2 text-left"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (key) window.location.hash = key;
                }}
            >
                <label htmlFor={id} className="sr-only">
                    The whole link
                </label>
                <Input
                    id={id}
                    className="flex-1 text-[15px]"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Paste the whole link"
                    autoComplete="off"
                    spellCheck={false}
                />
                <Button type="submit" size="lg" disabled={!key}>
                    Open
                </Button>
            </form>
        </Card>
    );
}

/* A link's state on its own: a quiet mark, what happened, what to do. */
function Card({
    icon,
    tone = 'tint',
    children,
}: {
    icon?: React.ReactNode;
    tone?: 'tint' | 'quiet' | 'danger';
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-1 items-center justify-center px-4 py-16 sm:px-8">
            <div className="flex w-full max-w-[440px] flex-col items-center gap-3 rounded-2xl border border-rule bg-card p-8 text-center shadow-sm">
                {icon && (
                    <span
                        className={cn(
                            'mb-1 flex size-14 items-center justify-center rounded-full',
                            tone === 'tint' && 'bg-accent text-accent-foreground',
                            tone === 'quiet' && 'bg-muted text-muted-foreground',
                            tone === 'danger' && 'bg-destructive-soft text-destructive',
                        )}
                    >
                        {icon}
                    </span>
                )}
                {children}
            </div>
        </div>
    );
}

function Opening() {
    return (
        <Card>
            <Spinner className="size-6 text-primary" />
            <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">Opening the link</h1>
            <p className="text-sm text-muted-foreground">
                This takes a moment on a slow connection.
            </p>
        </Card>
    );
}

/* Opens the key on this device; with a password, only after it is typed. */
function Unlock({
    token,
    secret,
    hasPassword,
    onOpened,
}: {
    token: string;
    secret: string;
    hasPassword: boolean;
    onOpened: (opened: Opened) => void;
}) {
    const id = useId();
    const [password, setPassword] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function open(value: string | null) {
        setPending(true);
        setError('');
        try {
            onOpened({
                ...(await driveClient.openLink(token, secret, value)),
                token,
                secret,
                password: value,
            });
        } catch (cause) {
            setError(
                hasPassword
                    ? 'That password didn’t work. Check it and try again.'
                    : driveError(cause),
            );
        } finally {
            setPending(false);
        }
    }
    useEffect(() => {
        if (!hasPassword) void open(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hasPassword]);
    if (!hasPassword)
        return error ? (
            <Card icon={<TriangleAlertIcon className="size-6" aria-hidden="true" />} tone="danger">
                <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">
                    This link couldn’t be opened
                </h1>
                <p className="text-sm text-muted-foreground">
                    Check your connection and try again. If it keeps happening, ask for a new link.
                </p>
                <p className="text-[13px] text-muted-foreground">{error}</p>
                <Button
                    variant="outline"
                    size="lg"
                    disabled={pending}
                    onClick={() => void open(null)}
                >
                    <RotateCcwIcon />
                    Try again
                </Button>
            </Card>
        ) : (
            <Opening />
        );
    return (
        <Card icon={<LockIcon className="size-6" aria-hidden="true" />}>
            <h1 className="text-[22px] font-extrabold tracking-[-0.02em]">
                This link has a password
            </h1>
            <p className="text-sm text-muted-foreground">
                Whoever shared it set one. Ask them if you don’t have it.
            </p>
            <form
                className="flex w-full flex-col gap-3 pt-2 text-left"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void open(password);
                }}
            >
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={id} className="text-[13px] font-semibold">
                        Password
                    </label>
                    <Input
                        id={id}
                        type="password"
                        autoComplete="off"
                        aria-invalid={Boolean(error) || undefined}
                        aria-describedby={error ? `${id}-error` : undefined}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className="w-full text-[15px]"
                    />
                    {error && (
                        <p id={`${id}-error`} role="alert" className="text-[13px] text-destructive">
                            {error}
                        </p>
                    )}
                </div>
                <Button type="submit" size="lg" disabled={pending || !password}>
                    {pending ? 'Opening…' : 'Open'}
                </Button>
            </form>
        </Card>
    );
}

/* The linked file, or the linked folder with the folders beneath it. */
function LinkContents({ opened }: { opened: Opened }) {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const folderId = opened.node.kind === 'folder' ? (search.folder ?? opened.node.id) : null;
    const listing = useQuery({ ...folderQueryOptions(folderId ?? ''), enabled: folderId !== null });
    const router = useRouter();
    const rows = listing.data ? sortNodes(listing.data.children) : [];
    const files = rows.filter((row) => row.kind === 'file');
    /*
     * The open preview lives in the URL, as it does in the Drive, so the browser's
     * back button closes it. The fragment rides along: it is the key.
     */
    const previewing = search.preview
        ? ((opened.node.kind === 'file' ? [opened.node] : files).find(
              (file) => file.id === search.preview,
          ) ?? null)
        : null;
    const pushedPreview = useRef(false);
    function setPreviewing(node: DriveNode | null) {
        if (node) {
            const replace = previewing !== null;
            if (!replace) pushedPreview.current = true;
            void navigate({
                search: (current) => ({ ...current, preview: node.id }),
                hash: opened.secret,
                replace,
            });
        } else if (pushedPreview.current) {
            pushedPreview.current = false;
            router.history.back();
        } else
            void navigate({
                search: (current) => (current.folder ? { folder: current.folder } : {}),
                hash: opened.secret,
                replace: true,
            });
    }
    const crumbs = listing.data ? [...listing.data.ancestors, listing.data.folder] : [];

    const at = crumbs.at(-1);
    const count =
        listing.data && at
            ? `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`
            : opened.node.kind === 'file'
              ? formatBytes(contentSize(opened.node) ?? 0)
              : '';
    const go = (id: string) =>
        void navigate({
            search: id === opened.node.id ? {} : { folder: id },
            // The fragment is the key: every move inside the link keeps it.
            hash: opened.secret,
        });

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-8 pb-12 sm:px-8 sm:pt-10">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                <Link2Icon className="size-3.5 text-primary" strokeWidth={2.4} aria-hidden="true" />
                Shared with a link
            </span>
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-2 pb-5">
                <div className="flex min-w-0 flex-col gap-1">
                    <h1 className="text-[30px] leading-[1.1] font-extrabold tracking-[-0.03em] wrap-anywhere">
                        {opened.node.name}
                    </h1>
                    {count && <span className="text-sm text-muted-foreground">{count}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ReportButton opened={opened} />
                    <SaveToDrive opened={opened} />
                    <Button onClick={() => void downloadNodes([opened.node])}>
                        <DownloadIcon />
                        {opened.node.kind === 'folder' ? 'Download all' : 'Download'}
                    </Button>
                </div>
            </div>
            <div className="flex flex-col overflow-hidden rounded-2xl border border-rule bg-card">
                {opened.node.kind === 'file' && (
                    <div className="flex flex-col items-center gap-4 px-6 py-12">
                        <FileMark node={opened.node} size="large" />
                        <Button variant="outline" onClick={() => setPreviewing(opened.node)}>
                            <EyeIcon />
                            Preview
                        </Button>
                    </div>
                )}
                {folderId && (
                    <>
                        {crumbs.length > 1 && (
                            <nav
                                aria-label="Folder path"
                                className="flex flex-wrap items-center gap-1 px-5 pt-3 text-sm sm:px-6"
                            >
                                {crumbs.map((crumb, index) => (
                                    <span key={crumb.id} className="flex items-center gap-1">
                                        {index > 0 && (
                                            <ChevronRightIcon
                                                className="size-3.5 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                        )}
                                        {index === crumbs.length - 1 ? (
                                            <span
                                                aria-current="page"
                                                data-crumb-id={crumb.id}
                                                className="font-semibold"
                                            >
                                                {crumb.name}
                                            </span>
                                        ) : (
                                            <button
                                                type="button"
                                                data-crumb-id={crumb.id}
                                                className="cursor-pointer font-semibold text-primary underline underline-offset-2 outline-none hover:text-primary-hover focus-visible:outline-2 focus-visible:outline-ring"
                                                onClick={() => go(crumb.id)}
                                            >
                                                {crumb.name}
                                            </button>
                                        )}
                                    </span>
                                ))}
                            </nav>
                        )}
                        {listing.isPending && <SkeletonRows />}
                        {listing.isError && (
                            <EmptyState
                                icon={TriangleAlertIcon}
                                tone="danger"
                                title="This folder couldn’t be opened"
                                body="Check your connection and try again."
                            >
                                <Button variant="outline" onClick={() => void listing.refetch()}>
                                    <RotateCcwIcon />
                                    Try again
                                </Button>
                            </EmptyState>
                        )}
                        {listing.data && rows.length === 0 && (
                            <p className="px-5 py-16 text-center text-[15px] text-muted-foreground">
                                Nothing in this folder.
                            </p>
                        )}
                        {rows.length > 0 && (
                            <>
                                <div
                                    aria-hidden="true"
                                    className={cn(
                                        LINK_ROW,
                                        'h-10 border-b border-rule text-xs font-semibold text-muted-foreground',
                                    )}
                                >
                                    <span className="pl-14">Name</span>
                                    <span className="max-sm:hidden">Changed</span>
                                    <span className="text-right">Size</span>
                                </div>
                                <ul
                                    aria-label={`Inside ${at?.name ?? opened.node.name}`}
                                    className="flex flex-col"
                                >
                                    {rows.map((node) => (
                                        <li
                                            key={node.id}
                                            data-node-id={node.id}
                                            className={cn(
                                                LINK_ROW,
                                                'group h-14 border-b border-rule last:border-0 hover:bg-muted',
                                            )}
                                        >
                                            <button
                                                type="button"
                                                className="flex min-w-0 cursor-pointer items-center gap-4 py-2 text-left text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                onClick={() =>
                                                    node.kind === 'folder'
                                                        ? go(node.id)
                                                        : setPreviewing(node)
                                                }
                                            >
                                                <span className="flex size-10 shrink-0 items-center justify-center">
                                                    <FileMark node={node} size="list" />
                                                </span>
                                                <span className="truncate group-hover:underline">
                                                    {node.name}
                                                </span>
                                            </button>
                                            <span className="text-[13px] text-muted-foreground tabular-nums max-sm:hidden">
                                                {formatWhen(
                                                    node.metadata?.modified ?? node.updatedAt,
                                                )}
                                            </span>
                                            <span className="text-right text-[13px] text-muted-foreground tabular-nums">
                                                {node.kind === 'folder'
                                                    ? '–'
                                                    : formatBytes(contentSize(node) ?? 0)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </>
                )}
            </div>
            <Preview
                files={opened.node.kind === 'file' ? [opened.node] : files}
                current={previewing}
                onChange={setPreviewing}
                onDownload={(node) => void downloadNodes([node])}
            />
        </div>
    );
}

/* Name, when it changed, size; the date gives way on a phone. */
const LINK_ROW =
    'grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-x-4 px-5 sm:grid-cols-[minmax(0,1fr)_9rem_7rem] sm:px-6';

/* Anyone holding the link can report what it opens; the operators alone get the key. */
function ReportButton({ opened }: { opened: Opened }) {
    const { hasSession } = useRouteContext({ from: '__root__' });
    const [reporting, setReporting] = useState(false);
    return (
        <>
            <Button variant="ghost" onClick={() => setReporting(true)}>
                <FlagIcon />
                Report
            </Button>
            <ReportDialog
                node={reporting ? opened.node : null}
                via={{ link: opened.token }}
                signedIn={Boolean(hasSession)}
                open={reporting}
                onOpenChange={setReporting}
            />
        </>
    );
}

/*
 * A signed-in visitor keeps a copy: read here through the link's key, queued
 * as an ordinary upload under their own keys. A locked device unlocks in place.
 */
function SaveToDrive({ opened }: { opened: Opened }) {
    const node = opened.node;
    const { hasSession } = useRouteContext({ from: '__root__' });
    const queryClient = useQueryClient();
    const session = useQuery({ ...sessionQueryOptions, enabled: Boolean(hasSession) });
    const unlockedUserId = useStore(authClient.store, (state) => state.unlockedUserId);
    const [unlocking, setUnlocking] = useState(false);
    const [saving, setSaving] = useState(false);
    const user = session.data ?? null;
    if (!hasSession)
        return (
            <Link
                to="/login"
                className={buttonVariants({ variant: 'outline' })}
                // The link's key is after the '#': it is kept in this browser, never put in the URL.
                onClick={() =>
                    rememberReturn(
                        window.location.pathname + window.location.search + window.location.hash,
                    )
                }
            >
                <CopyPlusIcon />
                Sign in to save a copy
            </Link>
        );
    if (!user) return null;

    async function save() {
        setSaving(true);
        try {
            // Unlocking an account in the worker drops every key it held, the
            // link's among them: open the link again before reading through it.
            await driveClient.openLink(opened.token, opened.secret, opened.password);
            const { root } = await driveClient.open(user!.id);
            const folder = (await queryClient.fetchQuery(folderQueryOptions(root.id))).folder;
            // The copy uploads from this page; leaving it early is what the guard asks about.
            guardUnloadWhileUploading();
            const made = await saveCopy(queryClient, [node], folder);
            toast.add({
                type: 'success',
                title:
                    made === 1
                        ? `Saving “${node.name}” to your files`
                        : `Saving ${made} items to your files`,
                description: 'It shows up in My files as it copies.',
            });
        } catch (error) {
            toast.add({
                type: 'error',
                title: 'Couldn’t save a copy',
                description: driveError(error),
            });
        } finally {
            setSaving(false);
        }
    }
    async function start() {
        if (unlockedUserId === user!.id) return save();
        try {
            await authClient.restore(user!, { validated: true });
        } catch {
            /* No remembered device: the dialog below asks for the password. */
        }
        if (authClient.store.getState().unlockedUserId === user!.id) return save();
        setUnlocking(true);
    }
    return (
        <>
            <Button variant="outline" disabled={saving} onClick={() => void start()}>
                <CopyPlusIcon />
                {saving ? 'Saving…' : 'Save a copy to my files'}
            </Button>
            <Dialog open={unlocking} onOpenChange={setUnlocking}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Unlock HushOS on this browser</DialogTitle>
                        <DialogDescription>
                            Your copy is saved under your own keys, so HushOS needs your password
                            first.
                        </DialogDescription>
                    </DialogHeader>
                    <UnlockDevice
                        user={user}
                        onUnlocked={async () => {
                            setUnlocking(false);
                            await save();
                        }}
                    />
                </DialogContent>
            </Dialog>
        </>
    );
}
