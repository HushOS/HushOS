import { contentSize, type DriveNode } from '@hushos/drive/client';
import { createFileRoute, Link, useRouteContext } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { DownloadIcon, FileIcon, FlagIcon, FolderIcon, LockIcon, SaveIcon } from 'lucide-react';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { Preview } from '@/components/drive/preview';
import { ReportDialog } from '@/components/drive/report-dialog';
import { FormActions, FormNote, FormRow, FormTable } from '@/components/form-rows';
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
import { saveCopy } from '@/lib/save-copy';
import { sessionQueryOptions } from '@/lib/session';
import {
    driveClient,
    driveError,
    folderQueryOptions,
    formatBytes,
    formatWhen,
    sortNodes,
} from '@/lib/drive';
import { linkApi, setActiveLink } from '@/lib/drive-api';

/*
 * A link opened by anyone: the path token names the share, the fragment
 * secret (never sent to the server) opens the key on this device, and an
 * optional password is stretched here first. No account, no session; the
 * crypto worker holds the folder key for as long as the tab is open.
 */
export const Route = createFileRoute('/s/$token')({
    validateSearch: (search: Record<string, unknown>): { folder?: string } =>
        typeof search.folder === 'string' && /^[0-9a-f-]{36}$/.test(search.folder)
            ? { folder: search.folder }
            : {},
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
                <h1 className="text-2xl font-medium tracking-tight">This link needs its key</h1>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    The part after the # is what opens the files, and it is missing. Whoever sent
                    the link may have sent that part separately; paste it here. It stays on this
                    device and is never sent to the server.
                </p>
                <FormTable className="mt-6">
                    <FormRow label="Key" htmlFor={id}>
                        <Input
                            id={id}
                            className="h-12 w-full border-0 bg-transparent px-4 font-mono text-sm focus-visible:ring-0"
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            placeholder="The part after the #, or the whole link"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </FormRow>
                    <FormActions
                        action={
                            <Button type="submit" disabled={!key}>
                                Open
                            </Button>
                        }
                    >
                        Or ask for the whole link.
                    </FormActions>
                </FormTable>
            </form>
        </Centered>
    );
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
            <div className="flex w-full max-w-md flex-col items-center text-center">{children}</div>
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
                        <p className="mt-4 font-mono text-xs text-muted-foreground">
                            Opening the key on this device.
                        </p>
                    </>
                )}
            </Centered>
        );
    return (
        <Centered>
            <p className="eyebrow mb-3 text-muted-foreground">Password needed</p>
            <h1 className="text-2xl font-medium tracking-tight">This link has a password</h1>
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
                <FormTable>
                    <FormRow label="Password" htmlFor={id} invalid={Boolean(error)}>
                        <Input
                            id={id}
                            type="password"
                            autoComplete="off"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            className="h-12 border-0 bg-transparent px-4 shadow-none focus-visible:ring-0"
                        />
                    </FormRow>
                    {error && <FormNote tone="destructive">{error}</FormNote>}
                    <FormActions
                        action={
                            <Button type="submit" disabled={pending || !password}>
                                <PendingLabel pending={pending} idle="Open" busy="Opening" />
                                <LockIcon aria-hidden="true" />
                            </Button>
                        }
                    >
                        Stretched with argon2id before it touches the key.
                    </FormActions>
                </FormTable>
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
    const [previewing, setPreviewing] = useState<DriveNode | null>(null);
    const rows = listing.data ? sortNodes(listing.data.children) : [];
    const files = rows.filter((row) => row.kind === 'file');
    const crumbs = listing.data ? [...listing.data.ancestors, listing.data.folder] : [];

    return (
        <div className="flex flex-1 flex-col">
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b px-5 py-6 sm:px-8 sm:py-8">
                <div className="min-w-0">
                    <p className="eyebrow mb-3 text-muted-foreground">Shared with you</p>
                    <h1 className="text-2xl font-medium tracking-tight wrap-anywhere sm:text-3xl">
                        {opened.node.name}
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                        Decrypted on this device with the key in your link. Nothing here is stored
                        by HushOS in a form it can read.{' '}
                        <Link to="/register" className="text-link">
                            Keep your own files this way.
                        </Link>
                    </p>
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
                <div className="px-5 py-6 sm:px-8">
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
                        className="flex flex-wrap gap-1 border-b px-5 py-3 font-mono text-xs sm:px-8"
                    >
                        {crumbs.map((crumb, index) => (
                            <span key={crumb.id} className="flex items-center gap-1">
                                {index > 0 && <span className="text-muted-foreground/60">/</span>}
                                <button
                                    type="button"
                                    data-crumb-id={crumb.id}
                                    className={`px-1 hover:underline ${index === crumbs.length - 1 ? 'text-foreground' : 'text-muted-foreground'}`}
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
                        <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
                            <Spinner />
                        </div>
                    )}
                    {listing.isError && (
                        <div className="px-5 py-6 sm:px-8">
                            <Alert variant="destructive">
                                <AlertTitle>This folder could not be opened</AlertTitle>
                                <AlertDescription>{driveError(listing.error)}</AlertDescription>
                            </Alert>
                        </div>
                    )}
                    {listing.data && rows.length === 0 && (
                        <p className="px-5 py-16 text-center font-mono text-xs text-muted-foreground sm:px-8">
                            Nothing here.
                        </p>
                    )}
                    {rows.length > 0 && (
                        <table className="w-full table-fixed border-collapse">
                            <thead>
                                <tr className="border-b">
                                    <th className="eyebrow py-2.5 pl-5 text-left font-medium text-muted-foreground sm:pl-8">
                                        Name
                                    </th>
                                    <th className="eyebrow hidden w-36 py-2.5 text-left font-medium text-muted-foreground sm:table-cell">
                                        Modified
                                    </th>
                                    <th className="eyebrow w-28 py-2.5 pr-5 text-right font-medium text-muted-foreground sm:pr-8">
                                        Size
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((node) => (
                                    <tr
                                        key={node.id}
                                        data-node-id={node.id}
                                        className="border-b hover:bg-muted/60"
                                    >
                                        <td className="min-w-0 p-0">
                                            <button
                                                type="button"
                                                className="flex w-full min-w-0 items-center gap-3 py-2 pl-5 text-left text-sm outline-none sm:pl-8"
                                                onClick={() =>
                                                    node.kind === 'folder'
                                                        ? void navigate({
                                                              search: { folder: node.id },
                                                              hash: opened.secret,
                                                          })
                                                        : setPreviewing(node)
                                                }
                                            >
                                                {node.kind === 'folder' ? (
                                                    <FolderIcon className="size-4 shrink-0 text-primary" />
                                                ) : (
                                                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                                )}
                                                <span className="truncate">{node.name}</span>
                                            </button>
                                        </td>
                                        <td className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                                            {formatWhen(node.metadata?.modified ?? node.updatedAt)}
                                        </td>
                                        <td className="py-2.5 pr-5 text-right font-mono text-xs text-muted-foreground tabular-nums sm:pr-8">
                                            {node.kind === 'folder'
                                                ? '—'
                                                : formatBytes(contentSize(node) ?? 0)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </>
            )}
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
                        className="border bg-card"
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
