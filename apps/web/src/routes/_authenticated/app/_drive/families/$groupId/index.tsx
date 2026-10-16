import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { ForkAlert, NoticeList } from '@/components/families/family-alerts';
import { InviteDialog } from '@/components/families/invite-dialog';
import { InvitationList, MemberList, PendingList } from '@/components/families/members';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
    afterFamilyChange,
    canManage,
    familiesQueryOptions,
    familyContext,
    familyQueryOptions,
    firstName,
    firstNames,
    invitationsQueryOptions,
    pendingQueryOptions,
    useFamilySync,
} from '@/lib/families';
import { groupsApi } from '@/lib/groups/api';
import { errorCopy, leftDueCopy } from '@/lib/groups/copy';
import { wipeGroup } from '@/lib/groups/sync';
import { cue } from '@/lib/sounds';

/*
 * Leaving is built but not offered until a departure can be finished (1c step
 * 7): until a manager marks the person left, which rotates every family
 * folder, nobody can join and roles can't change.
 */
const LEAVING = false as boolean;

export const Route = createFileRoute('/_authenticated/app/_drive/families/$groupId/')({
    head: () => ({ meta: [{ title: 'Family · HushOS' }] }),
    component: FamilyPage,
});

/*
 * One family: who waits to join, the members, open invitations, and leaving.
 * The member list is synced on this device first (after the outbox), and a
 * list shown differently is the hard warning. The family's folders open from
 * the sidebar once the family spaces arrive (plan step 6).
 */
function FamilyPage() {
    const { groupId } = Route.useParams();
    const { userId } = useDrive();
    const families = useQuery(familiesQueryOptions(userId));
    const summary = families.data?.find((family) => family.id === groupId);
    const detail = useQuery({
        ...familyQueryOptions(userId, groupId),
        enabled: summary?.state === 'active',
    });
    const sync = useFamilySync(userId, groupId, summary);
    const manager = summary?.state === 'active' && canManage(summary.roles);
    const pending = useQuery({
        ...pendingQueryOptions(userId, groupId),
        enabled: manager,
        // Someone who accepts while this page is open turns up without a reload.
        refetchInterval: 10_000,
    });
    const invitations = useQuery({
        ...invitationsQueryOptions(userId, groupId),
        enabled: manager,
        // An invitation someone accepts leaves this list for Waiting to join.
        refetchInterval: 10_000,
    });
    const [inviting, setInviting] = useState(false);
    const [leaving, setLeaving] = useState(false);

    if (families.isPending) return <SkeletonRows rows={3} />;
    if (families.isError)
        return (
            <EmptyState
                icon={TriangleAlertIcon}
                tone="danger"
                title="This family couldn’t be opened"
                body={errorCopy(families.error)}
            >
                <Button variant="outline" onClick={() => void families.refetch()}>
                    <RotateCcwIcon />
                    Try again
                </Button>
            </EmptyState>
        );
    if (!summary)
        return (
            <EmptyState
                title="You’re not in this family"
                body="It may have ended, or someone removed you."
            >
                <Link to="/app/families" className="text-sm font-semibold text-primary underline">
                    Families
                </Link>
            </EmptyState>
        );
    // Accepted but not let in yet: the join screen is where that goes on.
    if (summary.state === 'accepted')
        return <Navigate to="/app/families/$groupId/join" params={{ groupId }} replace />;

    const family = summary.name;
    const names = firstNames(detail.data);
    const result = sync.data?.result;
    // Let in, but nothing on this device or account checked the family yet: the join code is
    // compared on the join screen.
    if (result?.status === 'unchecked')
        return <Navigate to="/app/families/$groupId/join" params={{ groupId }} replace />;
    const view = result?.status === 'accepted' ? result.view : null;
    const markLeft = detail.data?.due?.markLeft ?? [];
    const ownWrong = view ? view.ownEntryWrongAt.length > 0 : false;
    const ownBehind = view ? view.ownEntryBehindAt.length > 0 : false;
    const activeCount = detail.data?.members.filter((member) => member.state === 'active').length;

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={<Link to="/app/families">Families</Link>}
                title={family}
                description={
                    detail.data
                        ? `${detail.data.seats.used} of ${detail.data.seats.limit} places taken.`
                        : undefined
                }
            >
                {manager && <Button onClick={() => setInviting(true)}>Invite someone</Button>}
            </PageHeader>

            <div className="flex flex-col gap-2 px-5 empty:hidden sm:px-8">
                {result?.status === 'fork' && <ForkAlert family={family} fork={result.fork} />}
                {sync.isError && (
                    <Alert variant="warning">
                        <AlertTitle>Couldn’t check {family}</AlertTitle>
                        <AlertDescription>{errorCopy(sync.error, { family })}</AlertDescription>
                    </Alert>
                )}
                {result?.status === 'wiped' && (
                    <Alert variant="warning">
                        <AlertTitle>You’re not in {family} any more</AlertTitle>
                        <AlertDescription>
                            What this device kept of the family has been cleared.
                        </AlertDescription>
                    </Alert>
                )}
                {ownWrong && (
                    <Alert variant="destructive">
                        <AlertTitle>
                            Your entry in {family}’s member list isn’t your keys
                        </AlertTitle>
                        <AlertDescription>
                            Ask someone who manages the family to check your words again.
                        </AlertDescription>
                    </Alert>
                )}
                {!ownWrong && ownBehind && (
                    <Alert variant="info">
                        <AlertDescription>
                            {family}’s member list still has your previous keys. A manager’s device
                            updates it the next time they open the family.
                        </AlertDescription>
                    </Alert>
                )}
                {markLeft.length > 0 && (
                    <Alert variant="warning" data-left-due>
                        <AlertTitle>{leftDueCopy({ userIds: markLeft }, { names })}</AlertTitle>
                        <AlertDescription>
                            This version of HushOS can’t finish it yet.
                        </AlertDescription>
                    </Alert>
                )}
                {sync.data && (
                    <NoticeList
                        notices={sync.data.notices}
                        nameOf={() => family}
                        personOf={(id) => {
                            const waiting = pending.data?.find((at) => at.userId === id);
                            return waiting ? firstName(waiting.name) : names[id];
                        }}
                    />
                )}
            </div>

            {detail.isPending && <SkeletonRows rows={2} />}
            {detail.isError && (
                <EmptyState
                    icon={TriangleAlertIcon}
                    tone="danger"
                    title="This family couldn’t be opened"
                    body={errorCopy(detail.error, { family })}
                >
                    <Button variant="outline" onClick={() => void detail.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {manager && pending.data && (
                <PendingList
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    pending={pending.data}
                    names={names}
                    blocked={
                        markLeft.length > 0 ? leftDueCopy({ userIds: markLeft }, { names }) : null
                    }
                />
            )}
            {detail.data && (
                <MemberList
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    members={detail.data.members}
                    view={view}
                    manager={manager}
                    names={names}
                />
            )}
            {manager && invitations.data && (
                <InvitationList
                    userId={userId}
                    groupId={groupId}
                    invitations={invitations.data}
                    members={detail.data?.members ?? []}
                />
            )}

            <section className="flex flex-col gap-3 px-5 pt-8 sm:px-8">
                <details className="rounded-xl border border-rule px-4 py-3 text-[13px]">
                    <summary className="cursor-pointer font-semibold">Technical details</summary>
                    {view ? (
                        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                            <dt className="text-muted-foreground">Member list version</dt>
                            <dd className="tabular-nums">{view.rosterVersion}</dd>
                            <dt className="text-muted-foreground">Member list digest</dt>
                            <dd className="font-mono break-all">{view.rosterDigest}</dd>
                            <dt className="text-muted-foreground">Family key version</dt>
                            <dd className="tabular-nums">{view.groupKeyVersion}</dd>
                            <dt className="text-muted-foreground">Family folders</dt>
                            <dd className="tabular-nums">{Object.keys(view.areas).length}</dd>
                            {view.deadBranches.length > 0 && (
                                <>
                                    <dt className="text-muted-foreground">Dropped changes</dt>
                                    <dd>
                                        {view.deadBranches
                                            .map(
                                                (branch) =>
                                                    `version ${branch.version} by ${names[branch.signerUserId] ?? 'a former manager'}`,
                                            )
                                            .join(', ')}
                                    </dd>
                                </>
                            )}
                        </dl>
                    ) : (
                        <p className="mt-2 text-muted-foreground">
                            Not checked on this device yet.
                        </p>
                    )}
                </details>
                {LEAVING && (
                    <div>
                        <Button variant="destructive-outline" onClick={() => setLeaving(true)}>
                            Leave family
                        </Button>
                    </div>
                )}
            </section>
            <ServerKnowsLine className="mt-auto" />

            {manager && (
                <InviteDialog
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    open={inviting}
                    onOpenChange={setInviting}
                />
            )}
            <LeaveDialog
                userId={userId}
                groupId={groupId}
                family={family}
                alone={activeCount === 1}
                open={leaving}
                onOpenChange={setLeaving}
            />
        </div>
    );
}

/* Leaving (route 20): asked once. This device then forgets the family; the settings pin stays a mark. */
function LeaveDialog({
    userId,
    groupId,
    family,
    alone,
    open,
    onOpenChange,
}: {
    userId: string;
    groupId: string;
    family: string;
    alone: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function leave() {
        setBusy(true);
        setError('');
        try {
            await groupsApi.leave(groupId);
            const ctx = familyContext(userId);
            await ctx.lock(groupId, () => wipeGroup(ctx, groupId)).catch(() => {});
            cue('droplet');
            toast.add({ type: 'success', title: `You left ${family}` });
            onOpenChange(false);
            await afterFamilyChange(queryClient, userId);
            await navigate({ to: '/app/families', replace: true });
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family }));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Leave {family}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {alone
                            ? `You’re the only one in ${family}, so leaving ends it. You’ll lose the family folders. Your own files stay yours.`
                            : 'You’ll lose the family folders. Your own files stay yours.'}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button variant="destructive" disabled={busy} onClick={() => void leave()}>
                        {busy ? 'Leaving…' : 'Leave family'}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
