import type { ReportEventView, ReportView } from '@hushos/drive/api';
import { contentSize, type DriveNode } from '@hushos/drive/client';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ArchiveIcon,
    DatabaseIcon,
    DownloadIcon,
    FileIcon,
    FlagIcon,
    FolderIcon,
    KeyRoundIcon,
    LockOpenIcon,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { DriveShell, useDrive } from '@/components/drive/drive-shell';
import { Preview } from '@/components/drive/preview';
import { PendingLabel, Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { openIdentity } from '@/lib/contacts';
import { downloadNodes } from '@/lib/downloads';
import {
    driveClient,
    driveError,
    folderQueryOptions,
    formatBytes,
    formatWhen,
    sortNodes,
} from '@/lib/drive';
import { reportApi, setActiveReport, setEvidenceUrls } from '@/lib/drive-api';
import { buildEvidencePacket, saveEvidencePacket } from '@/lib/evidence-packet';
import { GUIDANCE } from '@/lib/authorities';
import {
    categoryLabel,
    describeDue,
    dueAt,
    reportKeys,
    reportQueryOptions,
    STATUS_LABELS,
} from '@/lib/reports';
import { cue } from '@/lib/sounds';

/*
 * One report: what was said, who said it and about whose files, the record of
 * every look and decision, the content itself once this operator opens their
 * sealed key, and the actions: dismiss, remove, file with an authority, hold,
 * suspend the uploader, note.
 */
export const Route = createFileRoute('/_authenticated/app/admin/reports/$reportId')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app' });
    },
    head: () => ({ meta: [{ title: 'Report · HushOS' }] }),
    component: ReportPage,
});

function ReportPage() {
    const { user } = Route.useRouteContext();
    return (
        <DriveShell user={user}>
            <ReportDetail />
        </DriveShell>
    );
}

const row = 'grid border-b last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)]';
const label = 'eyebrow flex min-h-11 items-center px-4 text-muted-foreground sm:border-r';
const value = 'flex min-h-11 min-w-0 items-center px-4 py-2.5 font-mono text-xs wrap-anywhere';

function ReportDetail() {
    const { reportId } = Route.useParams();
    const detail = useQuery(reportQueryOptions(reportId));
    if (detail.isPending)
        return (
            <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
                <Spinner />
            </div>
        );
    if (detail.isError)
        return (
            <div className="px-5 py-6 sm:px-8">
                <Alert variant="destructive">
                    <AlertTitle>Could not load</AlertTitle>
                    <AlertDescription>{driveError(detail.error)}</AlertDescription>
                </Alert>
            </div>
        );
    const { report, events } = detail.data;
    const due = describeDue(report);
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow={
                    <Link to="/app/admin/reports" className="hover:underline">
                        Reports
                    </Link>
                }
                title={categoryLabel(report.category)}
                description={
                    <>
                        {STATUS_LABELS[report.status]}
                        {report.heldAt ? ', on hold' : ''}. Reported {formatWhen(report.createdAt)}
                        {due ? (
                            <>
                                , due {formatWhen(dueAt(report).toISOString())}{' '}
                                <span className={due.overdue ? 'text-destructive' : ''}>
                                    ({due.label})
                                </span>
                            </>
                        ) : null}
                        .
                    </>
                }
            />
            <div className="flex flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
                <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
                    <div className="flex min-w-0 flex-col gap-8">
                        <Facts report={report} />
                        <Contents report={report} events={events} />
                    </div>
                    <div className="flex flex-col gap-8">
                        <Actions report={report} />
                        <Timeline events={events} />
                    </div>
                </section>
            </div>
        </div>
    );
}

function Facts({ report }: { report: ReportView }) {
    return (
        <div className="border bg-card">
            <div className={row}>
                <span className={label}>Reason</span>
                <p className={`${value} whitespace-pre-wrap`}>{report.reason}</p>
            </div>
            <div className={row}>
                <span className={label}>Item</span>
                <span className={value}>
                    {report.nodeKind === 'folder'
                        ? `A folder holding ${report.itemCount - 1} items${report.itemsTruncated ? ', more than the snapshot kept' : ''}`
                        : 'One file'}
                    , seen via a {report.via}
                </span>
            </div>
            <div className={row}>
                <span className={label}>Reporter</span>
                <span className={value}>
                    {report.reporter.userId
                        ? `Account ${report.reporter.userId}`
                        : report.reporter.email
                          ? `Anonymous, ${report.reporter.email}`
                          : 'Anonymous, no email left'}
                </span>
            </div>
            <div className={row}>
                <span className={label}>Uploader</span>
                <span className={value}>
                    {report.uploader.email ?? 'Unknown'}
                    {report.uploader.suspended ? ' · suspended' : ''}
                </span>
            </div>
            <div className={row}>
                <span className={label}>Content hash</span>
                <span className={value}>
                    {report.contentHash ? `sha256 ${report.contentHash}` : 'Not computed'}
                </span>
            </div>
            <div className={row}>
                <span className={label}>Evidence</span>
                <span className={value}>
                    {
                        {
                            pending: 'Waiting for the worker to copy the bytes',
                            copied: 'Copied to the evidence store',
                            skipped:
                                'No evidence store configured; the hold keeps the bytes in the primary bucket',
                            failed: 'The copy failed; the worker will try the rest again',
                            purged: 'Copy deleted after dismissal',
                        }[report.evidenceStatus]
                    }
                </span>
            </div>
            {report.filedWith && (
                <div className={row}>
                    <span className={label}>Filed with</span>
                    <span className={value}>
                        {report.filedWith}
                        {report.filedReference ? ` · ${report.filedReference}` : ''}
                    </span>
                </div>
            )}
            <div className={row}>
                <span className={label}>Ids</span>
                <span className={`${value} text-muted-foreground`}>
                    report {report.id} · node {report.nodeId} · workspace {report.workspaceId}
                </span>
            </div>
        </div>
    );
}

/* The reported content, opened on this device under the operator's identity, every open on the record. */
function Contents({ report, events }: { report: ReportView; events: ReportEventView[] }) {
    const { userId } = useDrive();
    const [opened, setOpened] = useState<{ node: DriveNode } | null>(null);
    const [folderId, setFolderId] = useState<string | null>(null);
    const [previewing, setPreviewing] = useState<DriveNode | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const queryClient = useQueryClient();
    useEffect(() => () => setActiveReport(null), []);

    async function open() {
        setPending(true);
        setError('');
        try {
            await openIdentity(userId);
            setActiveReport({ reportId: report.id, workspaceId: report.workspaceId });
            const result = await driveClient.openReport(report.id);
            setOpened({ node: result.node });
            setFolderId(result.node.kind === 'folder' ? result.node.id : null);
            await queryClient.invalidateQueries({ queryKey: reportKeys.one(report.id) });
        } catch (cause) {
            setActiveReport(null);
            setError(driveError(cause));
        } finally {
            setPending(false);
        }
    }

    const listing = useQuery({
        ...folderQueryOptions(folderId ?? ''),
        enabled: opened !== null && folderId !== null,
    });
    const rows = listing.data ? sortNodes(listing.data.children) : [];
    const files = rows.filter((node) => node.kind === 'file');
    const crumbs = listing.data ? [...listing.data.ancestors, listing.data.folder] : [];

    return (
        <section className="flex flex-col gap-3">
            <h2 className="eyebrow text-muted-foreground">Content</h2>
            {!opened ? (
                <div className="flex flex-col gap-3 border bg-card px-4 py-4">
                    <p className="font-mono text-xs leading-relaxed text-muted-foreground">
                        The reporter sealed the key to this item to you. Opening it decrypts on this
                        device and adds a “viewed” entry to the record.
                    </p>
                    {error && (
                        <p role="alert" className="font-mono text-[11px] text-destructive">
                            {error}
                        </p>
                    )}
                    <div>
                        <Button onClick={() => void open()} disabled={pending}>
                            <LockOpenIcon />
                            <PendingLabel
                                pending={pending}
                                idle="Open the content"
                                busy="Opening"
                            />
                        </Button>
                    </div>
                </div>
            ) : opened.node.kind === 'file' ? (
                <div className="flex flex-wrap items-center gap-3 border bg-card px-4 py-3">
                    <FileIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="font-mono text-sm wrap-anywhere">{opened.node.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                        {formatBytes(contentSize(opened.node) ?? 0)}
                    </span>
                    <span className="flex-1" />
                    <Button variant="outline" size="sm" onClick={() => setPreviewing(opened.node)}>
                        Preview
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void downloadNodes([opened.node])}
                    >
                        <DownloadIcon />
                        Download
                    </Button>
                </div>
            ) : (
                <div className="border bg-card">
                    <nav
                        aria-label="breadcrumb"
                        className="flex flex-wrap items-center gap-1 border-b px-4 py-2.5 font-mono text-xs"
                    >
                        {crumbs.map((crumb, index) => (
                            <span key={crumb.id} className="flex items-center gap-1">
                                {index > 0 && <span className="text-muted-foreground/60">/</span>}
                                <button
                                    type="button"
                                    data-crumb-id={crumb.id}
                                    className={`hover:underline ${index === crumbs.length - 1 ? 'text-foreground' : 'text-muted-foreground'}`}
                                    onClick={() => setFolderId(crumb.id)}
                                >
                                    {crumb.name}
                                </button>
                            </span>
                        ))}
                        <span className="flex-1" />
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void downloadNodes([opened.node])}
                        >
                            <DownloadIcon />
                            Download all
                        </Button>
                    </nav>
                    {listing.isPending ? (
                        <div className="flex h-12 items-center px-4">
                            <Spinner className="size-4 text-muted-foreground" />
                        </div>
                    ) : listing.isError ? (
                        <p className="px-4 py-3 font-mono text-xs text-destructive">
                            {driveError(listing.error)}
                        </p>
                    ) : rows.length === 0 ? (
                        <p className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            Nothing here.
                        </p>
                    ) : (
                        <ul className="divide-y">
                            {rows.map((node) => (
                                <li key={node.id} data-node-id={node.id}>
                                    <button
                                        type="button"
                                        className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left text-sm hover:bg-muted/60"
                                        onClick={() =>
                                            node.kind === 'folder'
                                                ? setFolderId(node.id)
                                                : setPreviewing(node)
                                        }
                                    >
                                        {node.kind === 'folder' ? (
                                            <FolderIcon className="size-4 shrink-0 text-primary" />
                                        ) : (
                                            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                        )}
                                        <span className="truncate">{node.name}</span>
                                        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
                                            {node.kind === 'folder'
                                                ? '—'
                                                : formatBytes(contentSize(node) ?? 0)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
            {opened && <EvidenceTools report={report} events={events} node={opened.node} />}
            {opened && (
                <Preview
                    files={opened.node.kind === 'file' ? [opened.node] : files}
                    current={previewing}
                    onChange={setPreviewing}
                    onDownload={(node) => void downloadNodes([node])}
                />
            )}
        </section>
    );
}

/*
 * Two things an operator does with opened content beyond looking: read the
 * evidence copy when the primary bytes are gone, through a request the worker
 * answers, and build the packet to hand an authority, on this device.
 */
function EvidenceTools({
    report,
    events,
    node,
}: {
    report: ReportView;
    events: ReportEventView[];
    node: DriveNode;
}) {
    const queryClient = useQueryClient();
    const [fetching, setFetching] = useState<'pending' | 'ready' | null>(null);
    const [packet, setPacket] = useState<{ done: number; total: number } | null>(null);
    const [resealing, setResealing] = useState(false);
    const guidance = GUIDANCE[report.category];
    const holders = useQuery({
        queryKey: [...reportKeys.one(report.id), 'keys'],
        queryFn: () => reportApi.keyHolders(report.id),
        staleTime: 10_000,
    });
    const unsealed = holders.data?.operators.filter((o) => !o.sealed).length ?? 0;

    async function reseal() {
        setResealing(true);
        try {
            const { added } = await driveClient.resealReport(report.id, node);
            await Promise.all([
                holders.refetch(),
                queryClient.invalidateQueries({ queryKey: reportKeys.one(report.id) }),
            ]);
            cue('success');
            toast.add({
                type: 'success',
                title:
                    added === 1
                        ? 'One more operator can open this report'
                        : `${added} more operators can open this report`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not grant access',
                description: driveError(error),
            });
        } finally {
            setResealing(false);
        }
    }

    async function fetchEvidence() {
        setFetching('pending');
        try {
            const { request } = await reportApi.requestEvidence(report.id);
            const deadline = Date.now() + 120_000;
            for (;;) {
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                const { request: current } = await reportApi.evidenceRequest(report.id, request.id);
                if (current.status === 'ready') {
                    setEvidenceUrls(current.urls ?? {}, current.urlExpiresAt!);
                    setFetching('ready');
                    toast.add({
                        type: 'success',
                        title: 'Reading from the evidence store',
                        description: `${Object.keys(current.urls ?? {}).length} files for the next fifteen minutes.`,
                    });
                    break;
                }
                if (current.status === 'failed')
                    throw new Error(current.error ?? 'The worker refused.');
                if (Date.now() > deadline)
                    throw new Error('The worker did not answer. Is it running?');
            }
            await queryClient.invalidateQueries({ queryKey: reportKeys.one(report.id) });
        } catch (error) {
            setFetching(null);
            cue('error');
            toast.add({ type: 'error', title: 'Could not fetch', description: driveError(error) });
        }
    }
    async function download() {
        setPacket({ done: 0, total: 1 });
        try {
            const built = await buildEvidencePacket(report, events, node, (done, total) =>
                setPacket({ done, total }),
            );
            const name = await saveEvidencePacket(report, built.entries);
            await reportApi.recordPacket(report.id);
            await queryClient.invalidateQueries({ queryKey: reportKeys.one(report.id) });
            cue('success');
            toast.add({
                type: 'success',
                title: `${name} saved`,
                description: built.includeFiles
                    ? `${built.files.length} files with hashes, the report, the record and the guidance.`
                    : `Hashes and metadata for ${built.files.length} files, the report, the record and the guidance. The files themselves are withheld for this category.`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not build the packet',
                description: driveError(error),
            });
        } finally {
            setPacket(null);
        }
    }
    return (
        <div className="flex flex-col gap-3 border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={packet !== null}
                    onClick={() => void download()}
                >
                    <ArchiveIcon />
                    <PendingLabel
                        pending={packet !== null}
                        idle="Download evidence packet"
                        busy={
                            packet && packet.total > 1
                                ? `Hashing ${packet.done} of ${packet.total}`
                                : 'Building'
                        }
                    />
                </Button>
                {unsealed > 0 && (
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={resealing}
                        onClick={() => void reseal()}
                    >
                        <KeyRoundIcon />
                        <PendingLabel
                            pending={resealing}
                            idle={`Grant access to ${unsealed} operator${unsealed === 1 ? '' : 's'}`}
                            busy="Sealing"
                        />
                    </Button>
                )}
                {report.evidenceStatus === 'copied' && (
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={fetching !== null}
                        onClick={() => void fetchEvidence()}
                    >
                        <DatabaseIcon />
                        <PendingLabel
                            pending={fetching === 'pending'}
                            idle={
                                fetching === 'ready'
                                    ? 'Reading from the evidence store'
                                    : 'Fetch from the evidence store'
                            }
                            busy="Asking the worker"
                        />
                    </Button>
                )}
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                {guidance.includeFiles
                    ? 'The packet holds the files, their MD5, SHA-1 and SHA-256, the report, the record and where to file. Built on this device; every download is on the record.'
                    : 'For this category the packet holds hashes and metadata only, never the files: hand those to the authority through its own channel. Built on this device; every download is on the record.'}
                {report.evidenceStatus === 'copied'
                    ? ' Fetching from the evidence store reads the worker’s copy instead of the primary bucket, for when a released hold has drained it.'
                    : ''}
                {unsealed > 0
                    ? ` ${unsealed === 1 ? 'One operator was' : `${unsealed} operators were`} promoted after this was filed and cannot open it until you grant access, which seals the key to them on this device.`
                    : ''}
            </p>
        </div>
    );
}

type Action = 'dismiss' | 'remove' | 'file' | 'note';

function Actions({ report }: { report: ReportView }) {
    const queryClient = useQueryClient();
    const id = useId();
    const [action, setAction] = useState<Action | null>(null);
    const [hold, setHold] = useState(false);
    const [authority, setAuthority] = useState('');
    const [reference, setReference] = useState('');
    const [note, setNote] = useState('');
    const [pending, setPending] = useState<string | null>(null);
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: reportKeys.one(report.id) }),
            queryClient.invalidateQueries({ queryKey: reportKeys.all }),
        ]);
    async function run(name: string, work: () => Promise<unknown>, done: string) {
        setPending(name);
        try {
            await work();
            await refresh();
            cue('success');
            toast.add({ type: 'success', title: done });
            setAction(null);
            setNote('');
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not do that',
                description: driveError(cause),
            });
        } finally {
            setPending(null);
        }
    }
    const open = report.status === 'open';
    return (
        <section className="flex flex-col gap-3">
            <h2 className="eyebrow text-muted-foreground">Actions</h2>
            <div className="flex flex-col divide-y border bg-card">
                {open ? (
                    <>
                        <ActionRow
                            active={action === 'dismiss'}
                            onClick={() => setAction(action === 'dismiss' ? null : 'dismiss')}
                        >
                            Dismiss
                        </ActionRow>
                        <ActionRow
                            active={action === 'remove'}
                            tone="destructive"
                            onClick={() => setAction(action === 'remove' ? null : 'remove')}
                        >
                            Remove the content
                        </ActionRow>
                        <ActionRow
                            active={action === 'file'}
                            onClick={() => setAction(action === 'file' ? null : 'file')}
                        >
                            Mark as filed with an authority
                        </ActionRow>
                    </>
                ) : (
                    <ActionRow
                        onClick={() =>
                            void run('reopen', () => reportApi.reopen(report.id), 'Report reopened')
                        }
                    >
                        Reopen
                    </ActionRow>
                )}
                <ActionRow
                    onClick={() =>
                        void run(
                            'hold',
                            () => reportApi.hold(report.id, !report.heldAt),
                            report.heldAt ? 'Hold released' : 'Kept on hold',
                        )
                    }
                >
                    {report.heldAt ? 'Release the hold' : 'Keep on hold'}
                </ActionRow>
                {report.uploader.userId && (
                    <ActionRow
                        tone={report.uploader.suspended ? undefined : 'destructive'}
                        onClick={() =>
                            void run(
                                'suspend',
                                () =>
                                    reportApi.suspendUploader(
                                        report.id,
                                        !report.uploader.suspended,
                                    ),
                                report.uploader.suspended
                                    ? 'Uploader reinstated'
                                    : 'Uploader suspended',
                            )
                        }
                    >
                        {report.uploader.suspended
                            ? 'Reinstate the uploader'
                            : 'Suspend the uploader'}
                    </ActionRow>
                )}
                <ActionRow
                    active={action === 'note'}
                    onClick={() => setAction(action === 'note' ? null : 'note')}
                >
                    Add a note
                </ActionRow>
            </div>
            {action && (
                <form
                    noValidate
                    className="flex flex-col gap-3 border bg-card px-4 py-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (action === 'dismiss')
                            void run(
                                'resolve',
                                () => reportApi.resolve(report.id, { status: 'dismissed', hold }),
                                'Report dismissed',
                            );
                        if (action === 'remove')
                            void run(
                                'resolve',
                                () => reportApi.resolve(report.id, { status: 'removed', hold }),
                                'Content removed',
                            );
                        if (action === 'file')
                            void run(
                                'resolve',
                                () =>
                                    reportApi.resolve(report.id, {
                                        status: 'filed',
                                        filedWith: authority.trim(),
                                        filedReference: reference.trim() || null,
                                    }),
                                'Marked as filed',
                            );
                        if (action === 'note')
                            void run('note', () => reportApi.note(report.id, note), 'Note added');
                    }}
                >
                    {action === 'dismiss' && (
                        <p className="font-mono text-xs leading-relaxed text-muted-foreground">
                            Closes the report as unfounded. Without a hold the bytes are released to
                            the owner’s ordinary deletion and the evidence copy is removed.
                        </p>
                    )}
                    {action === 'remove' && (
                        <p className="font-mono text-xs leading-relaxed text-muted-foreground">
                            Moves the item to the owner’s trash where they cannot restore it, and
                            revokes every share and link on it. The owner can still delete it
                            forever; a hold keeps the bytes regardless.
                        </p>
                    )}
                    {(action === 'dismiss' || action === 'remove') && (
                        <label
                            htmlFor={`${id}-hold`}
                            className="flex items-center gap-2 font-mono text-xs"
                        >
                            <Checkbox
                                id={`${id}-hold`}
                                checked={hold}
                                onCheckedChange={(checked) => setHold(checked === true)}
                            />
                            Keep the bytes on hold after closing
                        </label>
                    )}
                    {action === 'file' && (
                        <>
                            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
                                Records who you filed this with and their reference. A filed report
                                is always held: someone else now relies on the bytes.
                            </p>
                            <label
                                htmlFor={`${id}-authority`}
                                className="eyebrow text-muted-foreground"
                            >
                                Authority
                            </label>
                            <Input
                                id={`${id}-authority`}
                                value={authority}
                                maxLength={200}
                                onChange={(event) => setAuthority(event.target.value)}
                                placeholder="NCMEC CyberTipline, a police force, a hotline"
                            />
                            <label
                                htmlFor={`${id}-reference`}
                                className="eyebrow text-muted-foreground"
                            >
                                Their reference
                            </label>
                            <Input
                                id={`${id}-reference`}
                                value={reference}
                                maxLength={200}
                                onChange={(event) => setReference(event.target.value)}
                                placeholder="Optional"
                            />
                        </>
                    )}
                    {action === 'note' && (
                        <Textarea
                            aria-label="Note"
                            value={note}
                            maxLength={2000}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder="For the record."
                        />
                    )}
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setAction(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            variant={action === 'remove' ? 'destructive' : 'default'}
                            disabled={
                                pending !== null ||
                                (action === 'file' && !authority.trim()) ||
                                (action === 'note' && !note.trim())
                            }
                        >
                            <FlagIcon />
                            <PendingLabel
                                pending={pending !== null}
                                idle={
                                    action === 'dismiss'
                                        ? 'Dismiss'
                                        : action === 'remove'
                                          ? 'Remove'
                                          : action === 'file'
                                            ? 'Mark as filed'
                                            : 'Add note'
                                }
                                busy="Saving"
                            />
                        </Button>
                    </div>
                </form>
            )}
        </section>
    );
}

function ActionRow({
    children,
    onClick,
    active,
    tone,
}: {
    children: React.ReactNode;
    onClick: () => void;
    active?: boolean;
    tone?: 'destructive';
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={`flex h-11 items-center px-4 text-left font-mono text-xs transition-colors hover:bg-muted ${active ? 'bg-muted' : ''} ${tone === 'destructive' ? 'text-destructive' : ''}`}
        >
            {children}
        </button>
    );
}

const ACTION_LABELS: Record<string, string> = {
    reported: 'Reported',
    viewed: 'Opened by an operator',
    dismissed: 'Dismissed',
    removed: 'Closed: content removed',
    'content-removed': 'Content removed',
    filed: 'Filed with an authority',
    held: 'Put on hold',
    released: 'Hold released',
    reopened: 'Reopened',
    'uploader-suspended': 'Uploader suspended',
    'uploader-reinstated': 'Uploader reinstated',
    'evidence-requested': 'Evidence copy requested',
    resealed: 'Sealed to more operators',
    packet: 'Evidence packet downloaded',
    note: 'Note',
};

function Timeline({
    events,
}: {
    events: {
        id: string;
        action: string;
        note: string | null;
        createdAt: string;
        actorUserId: string | null;
    }[];
}) {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="eyebrow text-muted-foreground">Record</h2>
            <ol className="divide-y border bg-card">
                {events.map((event) => (
                    <li key={event.id} className="flex flex-col gap-0.5 px-4 py-2.5">
                        <span className="font-mono text-xs">
                            {ACTION_LABELS[event.action] ?? event.action}
                        </span>
                        {event.note && (
                            <span className="font-mono text-[11px] whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                                {event.note}
                            </span>
                        )}
                        <span className="font-mono text-[11px] text-muted-foreground">
                            {formatWhen(event.createdAt)}
                            {event.actorUserId ? ` · ${event.actorUserId.slice(0, 8)}` : ''}
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
}
