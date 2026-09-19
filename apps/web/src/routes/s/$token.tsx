import { Preview } from '@/components/drive/preview';
import { ReportDialog } from '@/components/drive/report-dialog';
import { AuthActions, AuthNote } from '@/components/auth-layout';
import { FileMark } from '@/components/drive/file-mark';
import { PendingLabel, Spinner } from '@/components/motion';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { DownloadIcon, FileIcon, FlagIcon, LockIcon, SaveIcon } from 'lucide-react';
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
    head: () => ({ meta: [{ title: 'Shared with you · HushOS' }] }),
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
            <SiteHeader />
            <main className="flex flex-1 flex-col">
                {secret === undefined || (meta.isPending && secret) ? (
                    <Centered>
                        <Spinner className="size-4 text-muted-foreground" />
                    </Centered>
                ) : secret === null ? (
                    <MissingKey />
                ) : meta.isError ? (
                    <Centered>
                        <Alert variant="destructive" className="text-left">
                            <AlertTitle>This link no longer works</AlertTitle>
                            <AlertDescription>{driveError(meta.error)}</AlertDescription>
                        </Alert>
                    </Centered>
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
 * The link arrived without the part after the #. That part is the key, and
 * some people send it separately on purpose: a box takes it, and putting it
 * in the address opens the link as if it had been whole.
 */
function MissingKey() {
    const id = useId();
    const [value, setValue] = useState('');
    const key = value.trim().replace(/^.*#/, '');
    return (
        <Centered>
            <form
                className="w-full text-left"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (key) window.location.hash = key;
                }}
            >
                <h1 className="text-2xl font-bold tracking-tight">This link needs its key</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    The part after the # is what opens the files, and it is missing. Whoever sent
                    the link may have sent that part separately; paste it here. It stays on this
                    device and is never sent to the server.
                </p>
                <div className="mt-6 flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={id} className="eyebrow text-muted-foreground">
                            Key
                        </label>
                        <Input
                            id={id}
                            className="w-full font-mono text-sm"
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            placeholder="Paste the key or the whole link"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </div>
                    <AuthActions
                        action={
                            <Button type="submit" disabled={!key}>
                                Open
                            </Button>
                        }
                    >
                        Or ask for the whole link.
                    </AuthActions>
                </div>
            </form>
        </Centered>
    );
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-1 items-center justify-center px-4 py-16 sm:px-8">
            <div className="flex sheet w-full max-w-md flex-col items-center px-5 py-7 text-center sm:px-8 sm:py-9">
                {children}
            </div>
        </div>
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
                    ? 'That password did not open the link. Check it and try again.'
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
        return (
            <Centered>
                {error ? (
                    <Alert variant="destructive" className="text-left">
                        <AlertTitle>This link could not be opened</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                ) : (
                    <>
                        <Spinner className="size-4 text-muted-foreground" />
                        <p className="mt-4 text-sm text-muted-foreground">
                            Opening the key on this device.
                        </p>
                    </>
                )}
            </Centered>
        );
    return (
        <Centered>
            <p className="eyebrow mb-1.5 text-muted-foreground">Password needed</p>
            <h1 className="text-2xl font-bold tracking-tight">This link has a password</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Whoever sent it set one. It is checked on this device; the server never sees it.
            </p>
            <form
                className="mt-6 w-full text-left"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void open(password);
                }}
            >
                <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                        <label
                            htmlFor={id}
                            className={`eyebrow ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                        >
                            Password
                        </label>
                        <Input
                            id={id}
                            type="password"
                            autoComplete="off"
                            aria-invalid={Boolean(error) || undefined}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            className="w-full"
                        />
                    </div>
                    {error && <AuthNote tone="destructive">{error}</AuthNote>}
                    <AuthActions
                        action={
                            <Button type="submit" disabled={pending || !password}>
                                <PendingLabel pending={pending} idle="Open" busy="Opening" />
                                <LockIcon aria-hidden="true" />
                            </Button>
                        }
                    >
                        Stretched with argon2id before it touches the key.
                    </AuthActions>
                </div>
            </form>
        </Centered>
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

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-8 sm:px-8 sm:py-12">
            <div>
                <p className="eyebrow text-muted-foreground">Shared with you</p>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    Decrypted on this device with the key in your link. Nothing here is stored by
                    HushOS in a form it can read.{' '}
                    <Link to="/register" className="text-link">
                        Keep your own files this way.
                    </Link>
                </p>
            </div>
            <div className="sheet">
                <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 px-5 py-5 sm:px-7 sm:py-6">
                    <div className="flex min-w-0 items-center gap-4">
                        <FileMark kind={opened.node.kind} name={opened.node.name} />
                        <h1 className="min-w-0 text-2xl font-bold tracking-tight wrap-anywhere">
                            {opened.node.name}
                        </h1>
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
                {opened.node.kind === 'file' && (
                    <div className="border-t border-rule px-5 py-5 sm:px-7">
                        <Button variant="outline" onClick={() => setPreviewing(opened.node)}>
                            <FileIcon />
                            Preview {opened.node.name}
                        </Button>
                    </div>
                )}
                {folderId && (
                    <>
                        <nav
                            aria-label="breadcrumb"
                            className="flex flex-wrap gap-1 border-t border-rule px-4 py-3 text-sm sm:px-6"
                        >
                            {crumbs.map((crumb, index) => (
                                <span key={crumb.id} className="flex items-center gap-1">
                                    {index > 0 && (
                                        <span className="text-muted-foreground/60">/</span>
                                    )}
                                    <button
                                        type="button"
                                        data-crumb-id={crumb.id}
                                        className={`rounded-xs px-1 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${index === crumbs.length - 1 ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
                                        onClick={() =>
                                            void navigate({
                                                search:
                                                    crumb.id === opened.node.id
                                                        ? {}
                                                        : { folder: crumb.id },
                                                // The fragment is the key: every move inside the link keeps it.
                                                hash: opened.secret,
                                            })
                                        }
                                    >
                                        {crumb.name}
                                    </button>
                                </span>
                            ))}
                        </nav>
                        {listing.isPending && (
                            <div className="flex items-center justify-center border-t border-rule py-24 text-muted-foreground">
                                <Spinner />
                            </div>
                        )}
                        {listing.isError && (
                            <div className="border-t border-rule px-5 py-6 sm:px-7">
                                <Alert variant="destructive">
                                    <AlertTitle>This folder could not be opened</AlertTitle>
                                    <AlertDescription>{driveError(listing.error)}</AlertDescription>
                                </Alert>
                            </div>
                        )}
                        {listing.data && rows.length === 0 && (
                            <p className="border-t border-rule px-5 py-16 text-center text-sm text-muted-foreground sm:px-7">
                                Nothing here.
                            </p>
                        )}
                        {rows.length > 0 && (
                            <table className="mb-4 w-full table-fixed border-collapse">
                                <thead>
                                    <tr className="border-y border-rule">
                                        <th className="eyebrow py-2.5 pl-5 text-left text-muted-foreground sm:pl-7">
                                            Name
                                        </th>
                                        <th className="eyebrow hidden w-36 py-2.5 text-left text-muted-foreground sm:table-cell">
                                            Modified
                                        </th>
                                        <th className="eyebrow w-28 py-2.5 pr-5 text-right text-muted-foreground sm:pr-7">
                                            Size
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((node) => (
                                        <tr
                                            key={node.id}
                                            data-node-id={node.id}
                                            className="group h-[46px] border-b border-rule hover:bg-muted"
                                        >
                                            <td className="min-w-0 p-0">
                                                <button
                                                    type="button"
                                                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 py-2 pl-5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:pl-7"
                                                    onClick={() =>
                                                        node.kind === 'folder'
                                                            ? void navigate({
                                                                  search: { folder: node.id },
                                                                  hash: opened.secret,
                                                              })
                                                            : setPreviewing(node)
                                                    }
                                                >
                                                    <FileMark
                                                        kind={node.kind}
                                                        name={node.name}
                                                        className={
                                                            node.kind === 'file'
                                                                ? 'mx-[3px]'
                                                                : undefined
                                                        }
                                                    />
                                                    <span className="truncate group-hover:underline">
                                                        {node.name}
                                                    </span>
                                                </button>
                                            </td>
                                            <td className="hidden py-2.5 text-sm text-muted-foreground tabular-nums sm:table-cell">
                                                {formatWhen(
                                                    node.metadata?.modified ?? node.updatedAt,
                                                )}
                                            </td>
                                            <td className="py-2.5 pr-5 text-right text-sm text-muted-foreground tabular-nums sm:pr-7">
                                                {node.kind === 'folder'
                                                    ? '-'
                                                    : formatBytes(contentSize(node) ?? 0)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
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

/* Anyone holding the link can report what it opens; the operators alone get the key. */
function ReportButton({ opened }: { opened: Opened }) {
    const { hasSession } = useRouteContext({ from: '__root__' });
    const [reporting, setReporting] = useState(false);
    return (
        <>
            <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setReporting(true)}
            >
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
            <Button variant="outline" render={<Link to="/login" />}>
                <SaveIcon />
                Sign in to save a copy
            </Button>
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
                        ? `“${node.name}” is being saved to your Drive`
                        : `${made} items are being saved to your Drive`,
                description: 'Encrypted again under your own keys as they upload.',
            });
        } catch (error) {
            toast.add({ type: 'error', title: 'Could not save', description: driveError(error) });
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
                <SaveIcon />
                <PendingLabel pending={saving} idle="Save a copy to my Drive" busy="Saving" />
            </Button>
            <Dialog open={unlocking} onOpenChange={setUnlocking}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Unlock this device</DialogTitle>
                        <DialogDescription>
                            Saving a copy encrypts it under your own keys, which are locked on this
                            device. Enter your password to continue.
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
