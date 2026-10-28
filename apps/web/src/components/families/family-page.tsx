import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { CheckingLine, ForkAlert, NoticeList } from '@/components/families/family-alerts';
import { FamilyPlan, FamilyStorage, useFamilyPlanGate } from '@/components/families/family-billing';
import { InviteDialog } from '@/components/families/invite-dialog';
import { RenameFamilyDialog } from '@/components/families/rename-dialog';
import { FolderKeys, KeyChangeNotice } from '@/components/families/key-changes';
import {
    ChangedMembers,
    InvitationList,
    MemberList,
    PendingList,
} from '@/components/families/members';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Setting, SettingsGroup } from '@/components/settings';
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
    afterMembershipChange,
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
import { GroupApiError, groupsApi, lapsedPlansIn } from '@/lib/groups/api';
import { familySynced } from '@/lib/families-keys';
import type { GroupNotice } from '@/lib/groups/context';
import { errorCopy, leftDueCopy } from '@/lib/groups/copy';
import { wipeGroup } from '@/lib/groups/sync';
import {
    familyBillingQueryOptions,
    lapsedEndsWords,
    lapsedPlanShown,
    paymentNeedsYou,
    placesOf,
} from '@/lib/family-billing';
import { formatQuota, formatSpace, storageQueryOptions } from '@/lib/queries';
import { leaveBlocker } from '@/lib/family-leave';
import { useFamilyWork } from '@/lib/family-work';
import { cue } from '@/lib/sounds';

/*
 * The app-wide pass's notices with this page's own. Each reports separate events (whichever
 * runs first deletes the unreadable rows it counts, so two "changes lost" are four changes),
 * except a reset of the family's saved check: both may meet the same unreadable record if they
 * run at once, and it is one fact about the family, so it is said once.
 */
export function withPageNotices(notices: readonly GroupNotice[]) {
    const reset = new Set<string>();
    return notices.filter((notice) => {
        if (notice.kind !== 'record-reset') return true;
        if (reset.has(notice.groupId)) return false;
        reset.add(notice.groupId);
        return true;
    });
}

/* The organizer's first name when it is someone else: who the hard warning says to tell. */
function organizerOf(
    detail:
        | { members: { userId: string; name: string; state: string; roles: string[] }[] }
        | undefined,
    userId: string,
) {
    const organizer = detail?.members.find(
        (member) => member.state === 'active' && member.roles.includes('billing'),
    );
    return organizer && organizer.userId !== userId ? firstName(organizer.name) : null;
}

/* While a key change walks one of the family's folders, the family is checked again this often. */
const KEY_CHANGE_POLL_MS = 15_000;

/*
 * One family: its plan (where plans are sold, "Choose a plan" comes before
 * anything else), who waits to join, the members, open invitations, Billing,
 * and leaving.
 * The member list is synced on this device first (after the outbox), and a
 * list shown differently is the hard warning. The family's folders are its
 * space (/app/s/<family>), which Family folders in the sidebar opens. It is
 * /app/family (Account → Family) for the family the account is in: the
 * route picks the family; `appNotices` are the app-wide pass's notices, shown
 * here too, since that pass empties the outbox before this page syncs.
 */
export function FamilyPage({
    groupId,
    checkoutId,
    appNotices = [],
}: {
    groupId: string;
    /* Back from Polar's checkout: a plan is on its way. */
    checkoutId?: string;
    appNotices?: readonly GroupNotice[];
}) {
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
    const [technical, setTechnical] = useState(false);
    const [renaming, setRenaming] = useState(false);
    // Inviting waits for a plan where plans are sold: nobody could be let in without one.
    const plan = useFamilyPlanGate(userId, groupId, summary?.state === 'active');

    if (families.isPending) return <SkeletonRows rows={3} />;
    if (families.isError)
        return (
            <EmptyState title="This family couldn’t be opened" body={errorCopy(families.error)}>
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
                <Link to="/app/family" className="text-sm font-semibold text-primary underline">
                    Family
                </Link>
            </EmptyState>
        );
    // Accepted but not let in yet: the join screen is where that goes on.
    if (summary.state === 'accepted')
        return <Navigate to="/app/families/$groupId/join" params={{ groupId }} replace />;

    const family = summary.name;
    const names = firstNames(detail.data);
    const result = sync.data?.result;
    // Let in, but this device holds nothing of the family yet: the join screen joins it.
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
    // One blue button on the page (6.1): Let them in, or a changed member's Continue, while either
    // waits; Invite someone otherwise.
    const waiting =
        (pending.data ?? []).some((person) => !person.inFamily) ||
        (manager &&
            (detail.data?.members ?? []).some(
                (member) =>
                    member.state === 'active' &&
                    member.userId !== userId &&
                    work.needsCheck.includes(member.userId),
            ));

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={<Link to="/app/account">Account</Link>}
                title={family}
                titleAction={
                    manager && (
                        <Button variant="ghost" onClick={() => setRenaming(true)}>
                            Rename
                        </Button>
                    )
                }
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
                        // Outline while you must fix a failed payment (Billing's button is the blue
                        // one), or while someone waits to be let in or back in.
                        variant={paymentNeedsYou(plan.summary) || waiting ? 'outline' : 'default'}
                        onClick={() => setInviting(true)}
                    >
                        Invite someone
                    </Button>
                )}
            </PageHeader>

            {/* One column, as Account's: every section a heading with its rule, then rows. */}
            <div className="flex max-w-3xl flex-col gap-9 px-5 sm:px-8">
                <div className="flex flex-col gap-2 empty:hidden">
                    {sync.isPlaceholderData && result?.status === 'accepted' && (
                        <CheckingLine family={family} />
                    )}
                    {result?.status === 'fork' && (
                        <ForkAlert
                            family={family}
                            fork={result.fork}
                            organizer={organizerOf(detail.data, userId)}
                        />
                    )}
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
                        <Alert variant="warning" data-own-entry="wrong">
                            <AlertTitle>{family} has your account wrong on this device</AlertTitle>
                            <AlertDescription>
                                Ask someone who manages the family to check it’s you, from the
                                family’s page.
                            </AlertDescription>
                        </Alert>
                    )}
                    {!ownWrong && ownBehind && (
                        <Alert variant="info" data-own-entry="behind">
                            <AlertDescription>
                                {family} still has your account as it was before you updated it. A
                                manager’s device catches up the next time they open the family.
                            </AlertDescription>
                        </Alert>
                    )}
                    {manager && detail.data && (
                        <ChangedMembers
                            userId={userId}
                            groupId={groupId}
                            family={family}
                            members={detail.data.members}
                            view={view}
                            needsCheck={work.needsCheck}
                        />
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
                    {(sync.data || appNotices.length > 0) && (
                        <NoticeList
                            notices={withPageNotices([
                                ...appNotices,
                                ...(sync.data?.notices ?? []),
                                ...(foreign.data ?? []),
                            ])}
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

                <FamilyPlan
                    place="top"
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    roles={summary.roles}
                    checkoutId={checkoutId}
                    onCheckoutSeen={() =>
                        void navigate({ to: '/app/family', search: {}, replace: true })
                    }
                />

                {detail.isPending && (
                    <div className="-mx-5 sm:-mx-8">
                        <SkeletonRows rows={2} />
                    </div>
                )}
                {detail.isError && (
                    <EmptyState
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
                            markLeft.length > 0
                                ? leftDueCopy({ userIds: markLeft }, { names })
                                : null
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
                <FamilyStorage userId={userId} groupId={groupId} family={family} />

                {/* Rarely needed, so folded away as Account's Advanced is. */}
                <SettingsGroup
                    title="Technical details and leaving"
                    action={
                        <button
                            type="button"
                            aria-expanded={technical}
                            aria-controls="family-technical"
                            aria-label={
                                technical
                                    ? 'Hide technical details and leaving'
                                    : 'Show technical details and leaving'
                            }
                            onClick={() => setTechnical((value) => !value)}
                            className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-primary outline-hidden hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11"
                        >
                            {technical ? 'Hide' : 'Show'}
                            <ChevronDownIcon
                                aria-hidden="true"
                                className={`size-4 transition-transform ${technical ? 'rotate-180' : ''}`}
                            />
                        </button>
                    }
                >
                    <div id="family-technical" hidden={!technical} className="flex flex-col">
                        {view ? (
                            <>
                                <Setting label="Member list version">
                                    <span className="tabular-nums">{view.rosterVersion}</span>
                                </Setting>
                                <Setting label="Member list digest">
                                    <span className="font-mono text-sm break-all">
                                        {view.rosterDigest}
                                    </span>
                                </Setting>
                                <Setting label="Family key version">
                                    <span className="tabular-nums">{view.groupKeyVersion}</span>
                                </Setting>
                                <Setting
                                    label="Family folders"
                                    below={
                                        <FolderKeys
                                            userId={userId}
                                            groupId={groupId}
                                            family={family}
                                            areas={areas}
                                            manager={manager}
                                        />
                                    }
                                >
                                    <span className="tabular-nums">
                                        {Object.keys(view.areas).length}
                                    </span>
                                </Setting>
                                {view.deadBranches.length > 0 && (
                                    <Setting label="Dropped changes">
                                        {view.deadBranches
                                            .map(
                                                (branch) =>
                                                    `version ${branch.version} by ${names[branch.signerUserId] ?? 'a former manager'}`,
                                            )
                                            .join(', ')}
                                    </Setting>
                                )}
                            </>
                        ) : (
                            <Setting label="Member list">
                                <span className="text-muted-foreground">
                                    Not checked on this device yet.
                                </span>
                            </Setting>
                        )}
                        <Setting
                            label="Leaving"
                            action={
                                <Button
                                    variant="destructive-ghost"
                                    className="-mr-3.5 pointer-coarse:-mr-4"
                                    disabled={!detail.data || cantLeave !== null}
                                    aria-describedby={cantLeave ? 'leave-blocked' : 'leave-what'}
                                    onClick={() => setLeaving(true)}
                                >
                                    Leave family
                                </Button>
                            }
                        >
                            {/* Read on the way to the button: a disabled button can't take focus. */}
                            <span
                                id={cantLeave ? 'leave-blocked' : 'leave-what'}
                                className="text-muted-foreground"
                            >
                                {cantLeave ??
                                    'You’ll lose the family folders. Your own files stay yours.'}
                            </span>
                        </Setting>
                    </div>
                </SettingsGroup>
            </div>
            <ServerKnowsLine className="mt-auto max-w-3xl" />

            {manager && renaming && (
                <RenameFamilyDialog
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    open
                    onOpenChange={setRenaming}
                />
            )}
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
    // While their files draw from this family's pool, what leaving does to them
    // (docs/families-shared-pool.md 3.4): back on the allowance they have on their own, and
    // over it, readable but closed to uploads. Nothing is deleted.
    const storage = useQuery(storageQueryOptions);
    const own = storage.data?.pool?.groupId === groupId ? storage.data.own : null;
    const over = own !== null && BigInt(own.usedBytes) > BigInt(own.allowanceBytes);
    const billing = useQuery(familyBillingQueryOptions(userId, groupId));
    const planShown = lapsedPlanShown(billing.data, { userId, you: true });
    // The plans the server named when the leave asked (`ends-lapsed`): said, and confirmed by id.
    const [asked, setAsked] = useState<{ line: string; ids: string[] } | null>(null);
    const planLine =
        asked?.line ?? (planShown ? lapsedEndsWords(family, [planShown], { you: true }) : null);
    const ownLine = !own
        ? null
        : over
          ? `Your files take ${formatSpace(own.usedBytes)}. After you leave you have ${formatQuota(own.allowanceBytes)} of your own: you’ll be able to open and download everything, but not upload, until you make room or choose a plan.`
          : `Your files take ${formatSpace(own.usedBytes)}. After you leave they count against the ${formatQuota(own.allowanceBytes)} you have of your own.`;

    async function leave() {
        setBusy(true);
        setError('');
        try {
            await groupsApi.leave(groupId, { endsLapsed: asked?.ids ?? planShown?.ids ?? [] });
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
            if (wiped)
                toast.add({
                    type: 'success',
                    title: `You left ${family}`,
                    description:
                        own && over
                            ? `Your files take more than the ${formatQuota(own.allowanceBytes)} you have of your own, so uploads are off until you make room or choose a plan.`
                            : undefined,
                });
            else
                toast.add({
                    type: 'error',
                    title: `You left ${family}, but this device kept some of it`,
                    description:
                        'HushOS couldn’t clear the family’s keys and saved records on this device. Lock or sign out to clear them.',
                });
            onOpenChange(false);
            await afterMembershipChange(queryClient, userId);
            await navigate({ to: '/app/drive', replace: true });
        } catch (cause) {
            // A plan the page didn't show (or one since): said now, and the next press ends it.
            if (cause instanceof GroupApiError && cause.code === 'ends-lapsed') {
                const plans = lapsedPlansIn(cause.data);
                setAsked({
                    line: lapsedEndsWords(family, plans, { you: true }),
                    ids: plans.map((plan) => plan.id),
                });
                return;
            }
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
                {ownLine && (
                    <p className="text-sm" data-leave-storage={over ? 'over' : 'fits'}>
                        {ownLine}
                    </p>
                )}
                {planLine && (
                    <p className="text-sm" data-leave-plan-ends>
                        {planLine}
                    </p>
                )}
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
