import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { CheckingLine, ForkAlert, NoticeList } from '@/components/families/family-alerts';
import { FamilyPlan, useFamilyPlanGate } from '@/components/families/family-billing';
import { InviteDialog } from '@/components/families/invite-dialog';
import { FolderKeys, KeyChangeNotice } from '@/components/families/key-changes';
import { InvitationList, MemberList, PendingList } from '@/components/families/members';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { PendingLabel } from '@/components/motion';
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
import { Button, buttonVariants } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
    afterFamilyChange,
    canManage,
    familiesQueryOptions,
    familiesSyncQueryOptions,
    familyContext,
    familyQueryOptions,
    firstName,
    firstNames,
    foreignListingsQueryOptions,
    invitationsQueryOptions,
    pendingQueryOptions,
    useFamilySync,
} from '@/lib/families';
import { groupsApi } from '@/lib/groups/api';
import { familySynced } from '@/lib/families-keys';
import { errorCopy, leftDueCopy } from '@/lib/groups/copy';
import { wipeGroup } from '@/lib/groups/sync';
import { paymentNeedsYou, placesOf } from '@/lib/family-billing';
import { leaveBlocker } from '@/lib/family-leave';
import { useFamilyWork } from '@/lib/family-work';
import { cue } from '@/lib/sounds';

/* While a key change walks one of the family's folders, the family is checked again this often. */
const KEY_CHANGE_POLL_MS = 15_000;

export const Route = createFileRoute('/_authenticated/app/_drive/families/$groupId/')({
    head: () => ({ meta: [{ title: 'Family · HushOS' }] }),
    // Back from Polar's checkout: `checkout_id` says a plan is on its way.
    validateSearch: (search: Record<string, unknown>): { checkout_id?: string } =>
        typeof search.checkout_id === 'string' ? { checkout_id: search.checkout_id } : {},
    component: FamilyPage,
});

/*
 * One family: its plan (where plans are sold, "Choose a plan" comes before
 * anything else), who waits to join, the members, open invitations, Billing,
 * and leaving.
 * The member list is synced on this device first (after the outbox), and a
 * list shown differently is the hard warning. The family's folders are its
 * space (/app/s/<family>), which its sidebar row opens.
 */
function FamilyPage() {
    const { groupId } = Route.useParams();
    const { checkout_id: checkoutId } = Route.useSearch();
    const navigate = useNavigate();
    const { userId } = useDrive();
    const families = useQuery(familiesQueryOptions(userId));
    const summary = families.data?.find((family) => family.id === groupId);
    const detail = useQuery({
        ...familyQueryOptions(userId, groupId),
        enabled: summary?.state === 'active',
    });
    const sync = useFamilySync(userId, groupId, summary, { pollWhileWalking: KEY_CHANGE_POLL_MS });
    // The app-wide pass the Drive runtime runs (read here, never started): folders this family's
    // member list names that aren't its own are asked after it, so their owner has been opened.
    const pass = useQuery({ ...familiesSyncQueryOptions(userId), enabled: false });
    const foreign = useQuery({
        ...foreignListingsQueryOptions(userId, groupId, pass.dataUpdatedAt),
        enabled: sync.data?.result.status === 'accepted' && pass.data !== undefined,
    });
    const work = useFamilyWork(groupId);
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
    // Inviting waits for a plan where plans are sold: nobody could be let in without one.
    const plan = useFamilyPlanGate(userId, groupId, summary?.state === 'active');

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
    const areas = result?.status === 'accepted' ? result.areas : [];
    const markLeft = detail.data?.due?.markLeft ?? [];
    const ownWrong = view ? view.ownEntryWrongAt.length > 0 : false;
    const ownBehind = view ? view.ownEntryBehindAt.length > 0 : false;
    const activeCount = detail.data?.members.filter((member) => member.state === 'active').length;
    const seats = placesOf(detail.data?.seats, plan.summary);
    // Known up front from the member list: Leave family is disabled with the reason, rather than
    // offered and refused. The server still decides (an unsealed manager or the payer), and its
    // refusal shows in the dialog.
    const cantLeave = detail.data ? leaveBlocker(userId, detail.data.members) : null;

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={<Link to="/app/families">Families</Link>}
                title={family}
                description={
                    // One source with Billing (placesOf); without a plan, "Choose a plan" says it.
                    seats && !plan.waiting
                        ? `${seats.used} of ${seats.limit} places taken.`
                        : undefined
                }
            >
                <Link
                    to="/app/s/$groupId"
                    params={{ groupId }}
                    className={buttonVariants({ variant: 'outline' })}
                >
                    Family folders
                </Link>
                {manager && !plan.waiting && (
                    <Button
                        // Outline while you must fix a failed payment: Billing's button is the blue one.
                        variant={paymentNeedsYou(plan.summary) ? 'outline' : 'default'}
                        onClick={() => setInviting(true)}
                    >
                        Invite someone
                    </Button>
                )}
            </PageHeader>

            <div className="flex flex-col gap-2 px-5 empty:hidden sm:px-8">
                {sync.isPlaceholderData && result?.status === 'accepted' && (
                    <CheckingLine family={family} />
                )}
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
                            {manager
                                ? work.running
                                    ? 'HushOS is finishing it on this device now.'
                                    : 'HushOS finishes it on this device the next time it checks the family.'
                                : 'A manager’s device finishes it the next time they open the family.'}
                        </AlertDescription>
                    </Alert>
                )}
                {result?.status === 'accepted' && (
                    <KeyChangeNotice groupId={groupId} family={family} areas={areas} />
                )}
                {sync.data && (
                    <NoticeList
                        notices={[...sync.data.notices, ...(foreign.data ?? [])]}
                        nameOf={(id) =>
                            id === groupId
                                ? family
                                : families.data?.find((at) => at.id === id)?.name
                        }
                        personOf={(id) => {
                            const waiting = pending.data?.find((at) => at.userId === id);
                            return waiting ? firstName(waiting.name) : names[id];
                        }}
                    />
                )}
            </div>

            <div className="flex flex-col pt-2 empty:hidden">
                <FamilyPlan
                    place="top"
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    roles={summary.roles}
                    checkoutId={checkoutId}
                    onCheckoutSeen={() =>
                        void navigate({
                            to: '/app/families/$groupId',
                            params: { groupId },
                            search: {},
                            replace: true,
                        })
                    }
                />
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
                    waitingForPlan={plan.waiting}
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
                    needsCheck={work.needsCheck}
                    checking={sync.isPlaceholderData}
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

            <FamilyPlan
                place="bottom"
                userId={userId}
                groupId={groupId}
                family={family}
                roles={summary.roles}
                onCheckoutSeen={() => undefined}
            />

            <section className="flex flex-col gap-3 px-5 pt-8 sm:px-8">
                <details className="rounded-xl border border-rule px-4 py-3 text-[13px]">
                    <summary className="cursor-pointer font-semibold">
                        Technical details and leaving
                    </summary>
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
                            <dd className="col-span-2">
                                <FolderKeys
                                    userId={userId}
                                    groupId={groupId}
                                    family={family}
                                    areas={areas}
                                    manager={manager}
                                />
                            </dd>
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
                    <div className="mt-4 flex flex-col items-start gap-2 border-t border-rule pt-4">
                        {/* Before the button, so it is read on the way to it: a disabled button can't take focus. */}
                        {cantLeave && (
                            <p id="leave-blocked" className="text-muted-foreground">
                                {cantLeave}
                            </p>
                        )}
                        <Button
                            variant="destructive-outline"
                            disabled={!detail.data || cantLeave !== null}
                            aria-describedby={cantLeave ? 'leave-blocked' : undefined}
                            onClick={() => setLeaving(true)}
                        >
                            Leave family
                        </Button>
                    </div>
                </details>
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
            // This device forgets the family (chain, keys, records, outbox, folder mirrors); the
            // settings pin stays as a mark (D7). Its folders' clients go with it.
            const ctx = familyContext(userId);
            const wiped = await ctx
                .lock(groupId, () => wipeGroup(ctx, groupId))
                .then(() => true)
                .catch(() => false);
            familySynced(groupId, { status: 'wiped' });
            cue('droplet');
            // The leave landed either way; a wipe that failed is said, not hidden behind it.
            if (wiped) toast.add({ type: 'success', title: `You left ${family}` });
            else
                toast.add({
                    type: 'error',
                    title: `You left ${family}, but this device kept some of it`,
                    description:
                        'HushOS couldn’t clear the family’s keys and saved records on this device. Lock or sign out to clear them.',
                });
            onOpenChange(false);
            await afterFamilyChange(queryClient, userId);
            await navigate({ to: '/app/drive', replace: true });
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
                        <PendingLabel pending={busy} idle="Leave family" busy="Leaving" />
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
