import type { GroupRole, GroupView } from '@hushos/crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, EllipsisIcon, MailIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ContactFlowDialog, type FlowStart } from '@/components/drive/contact-flow';
import { RowMenuButton } from '@/components/drive/file-list';
import { PendingLabel } from '@/components/motion';
import { PersonAvatar } from '@/components/person-avatar';
import { SettingsGroup } from '@/components/settings';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { guardRevision, settingsQueryOptions } from '@/lib/contacts';
import { formatDay } from '@/lib/drive';
import {
    afterFamilyChange,
    afterMembershipChange,
    familiesQueryOptions,
    familyContext,
    familyKeys,
    firstName,
    pendingQueryOptions,
    rolesLine,
    withRole,
    type FamilyMember,
    type Invitation,
    type PendingPerson,
} from '@/lib/families';
import { removeBlocker } from '@/lib/family-leave';
import { clearPendingRoles, pendingRolesDone, pendingRolesOf } from '@/lib/family-pending';
import {
    continueMembers,
    letInWithoutWords,
    memberStandings,
    needsCheckFor,
    type MemberStanding,
} from '@/lib/family-trust';
import { GroupApiError, groupsApi } from '@/lib/groups/api';
import { errorCopy, leftDueCopy, namesInWords, outcomeCopy } from '@/lib/groups/copy';
import {
    dropKeptAdmission,
    stageChange,
    type OutboxEntry,
    type StageOutcome,
} from '@/lib/groups/outbox';
import { syncGroup } from '@/lib/groups/sync';
import { cue } from '@/lib/sounds';
import { SeatHelp, SeatNote } from './family-billing';
import { FamilyCheckDialog, type FamilyMemberRef } from './family-check';
import { RemoveDialog } from './remove-dialog';

/*
 * The family page's three lists (docs/optional-verification.md 6.8, 6.9): who
 * waits to join (for managers, each with Let them in, one click, no words),
 * the members (route 3's names with their address beside them, roles in
 * words, and at the right whether this person checked them), and open
 * invitations. Rows are at least 56px with 36px marks. Anyone's row menu
 * offers Check it's Sam; a manager's also changes roles and, last, removes
 * them. Managing the family and being its organizer are given only to someone
 * this person checked (3.6): unchecked, the change asks for the check first.
 */

/* A list on the family page, in the page's one section pattern (SettingsGroup). */
function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <SettingsGroup title={title}>
            <ul className="flex flex-col">{children}</ul>
        </SettingsGroup>
    );
}

/*
 * At least 56px, growing with what wraps: a long address truncates on its own
 * line, so it never hides the roles, which sit as small badges beside the
 * name (wrapping under it on a phone), or a note on a line of its own. What
 * sits at the right wraps under the name when the row runs out of room.
 */
function Row({
    name,
    you = false,
    seed,
    line,
    badges,
    note,
    data,
    mark,
    below,
    wrap = false,
    children,
}: {
    /* The person's name alone: it is what their initials are drawn from. */
    name: string;
    /* The row is the viewer's own: "(you)" beside the name, never part of it. */
    you?: boolean;
    seed: string;
    line: string;
    badges?: ReactNode;
    /* Said whole on a line of its own, below the address, so truncating that never hides it. */
    note?: ReactNode;
    data?: Record<string, string>;
    /* In place of the person's initials: an invitation is an address, not yet anyone. */
    mark?: ReactNode;
    /* A block under the row: a refusal and what can be done about it. */
    below?: ReactNode;
    /* What sits at the right goes under the name when the row runs out of room (its buttons). */
    wrap?: boolean;
    children?: ReactNode;
}) {
    return (
        <li {...data} className="flex flex-col gap-2 border-b border-rule py-2 last:border-0">
            <div
                className={`flex min-h-10 items-center gap-x-3 gap-y-2 ${wrap ? 'flex-wrap' : ''}`}
            >
                <span
                    className={`flex min-w-0 items-center gap-3 ${wrap ? 'flex-[1_1_14rem]' : 'flex-1'}`}
                >
                    {mark ?? <PersonAvatar name={name} seed={seed} />}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="min-w-0 truncate text-[15px] font-medium">
                                {name}
                                {you && (
                                    <span className="font-normal text-muted-foreground">
                                        {' '}
                                        (you)
                                    </span>
                                )}
                            </span>
                            {badges}
                        </span>
                        <span className="truncate text-[13px] text-muted-foreground">{line}</span>
                        {note && (
                            <span className="text-[13px] text-pretty text-muted-foreground">
                                {note}
                            </span>
                        )}
                    </span>
                </span>
                {children && (
                    <span className="ml-auto flex shrink-0 items-center gap-2">{children}</span>
                )}
            </div>
            {below}
        </li>
    );
}

/* A member's roles in words, as small badges: "Organizer", "Manages the family", or nothing. */
function RoleBadges({ roles }: { roles: readonly string[] }) {
    if (!roles.includes('billing') && !roles.includes('members')) return null;
    return (
        <span className="flex flex-wrap gap-1" data-roles>
            {rolesLine(roles)
                .split(' · ')
                .map((role) => (
                    <Badge key={role} variant="secondary">
                        {role}
                    </Badge>
                ))}
        </span>
    );
}

/* "Verified" with its check, or "Not verified": muted 13px text, never a badge (6.1). */
function CheckedLabel({ standing }: { standing: MemberStanding | undefined }) {
    if (!standing) return null;
    const verified = standing === 'verified';
    return (
        <span
            className="inline-flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground"
            data-checked={verified ? 'verified' : 'not-verified'}
        >
            {verified && <CheckIcon className="size-3.5" aria-hidden="true" />}
            {verified ? 'Verified' : 'Not verified'}
        </span>
    );
}

/*
 * Who this person has checked in the family, as this device judges it (3.8),
 * read again whenever the member list, the settings or the guard move.
 */
export function useMemberStandings(userId: string, groupId: string, view: GroupView | null) {
    const settings = useQuery(settingsQueryOptions(userId));
    return useQuery({
        queryKey: [
            ...familyKeys.family(userId, groupId),
            'standings',
            view?.rosterDigest ?? '',
            settings.dataUpdatedAt,
            guardRevision(),
        ],
        queryFn: () => memberStandings(userId, view!),
        enabled: view !== null,
        staleTime: Infinity,
        retry: false,
    });
}

/* A `seats` refusal's reason and, when the bank wants a confirmation, where. */
function seatOf(data: unknown) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    return {
        reason: typeof body.reason === 'string' ? body.reason : 'full',
        url: typeof body.url === 'string' ? body.url : null,
    };
}

/* "Waiting to join": accepted, not let in. */
export function PendingList({
    userId,
    groupId,
    family,
    pending,
    names,
    blocked = null,
    waitingForPlan = false,
}: {
    userId: string;
    groupId: string;
    family: string;
    pending: PendingPerson[];
    names: Record<string, string>;
    /* Why nobody can be let in right now (a departure to finish first). */
    blocked?: string | null;
    /* No live plan where plans are sold: admission would be refused, so it isn't offered. */
    waitingForPlan?: boolean;
}) {
    if (pending.length === 0) return null;
    return (
        <Section title="Waiting to join">
            {pending.map((person) => (
                <PendingRow
                    key={person.userId}
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    person={person}
                    names={names}
                    blocked={blocked}
                    waitingForPlan={waitingForPlan}
                />
            ))}
        </Section>
    );
}

/*
 * One person waiting (6.8): Let them in, one click, the screen's blue button;
 * Not now; and in the row's menu, Check it's Sam first (their twelve words,
 * 6.6, which the entry is then built from). Letting someone in pins them as
 * first seen when this account has no pin of them, and a manager asked for at
 * invitation joins as a member until they are checked (3.2, 3.6). A change of
 * their account met on the way is the changed-account notice, and the
 * admission runs once that is settled.
 */
function PendingRow({
    userId,
    groupId,
    family,
    person,
    names,
    blocked,
    waitingForPlan,
}: {
    userId: string;
    groupId: string;
    family: string;
    person: PendingPerson;
    names: Record<string, string>;
    blocked: string | null;
    waitingForPlan: boolean;
}) {
    const queryClient = useQueryClient();
    const ctx = familyContext(userId);
    const first = firstName(person.name);
    const [busy, setBusy] = useState<'send' | 'decline' | null>(null);
    const [error, setError] = useState('');
    const [seat, setSeat] = useState<{ reason: string; url: string | null } | null>(null);
    // A kept admission made before their account changed: dropped only on this person's say.
    const [keptOther, setKeptOther] = useState<OutboxEntry | null>(null);
    const [flow, setFlow] = useState<{ start: FlowStart; after?: 'let-in' } | null>(null);
    const [confirmingDecline, setConfirmingDecline] = useState(false);
    const roles =
        useQuery(familiesQueryOptions(userId)).data?.find((at) => at.id === groupId)?.roles ?? [];

    async function letThemIn() {
        setBusy('send');
        setError('');
        setSeat(null);
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                const fresh = (
                    await queryClient.fetchQuery({
                        ...pendingQueryOptions(userId, groupId),
                        staleTime: 0,
                    })
                ).find((at) => at.userId === person.userId);
                if (!fresh?.identity) {
                    // Let in meanwhile (another manager, or a send this device never heard back from).
                    if (attempt > 0) return landed([]);
                    throw new Error(`${first} isn’t waiting to join any more.`);
                }
                const result = await letInWithoutWords(queryClient, userId, ctx, groupId, {
                    userId: person.userId,
                    email: person.email,
                    roles: fresh.roles as GroupRole[],
                    identity: fresh.identity,
                });
                if (result.outcome === 'changed') {
                    // 6.7 takes the row's place; the admission runs once it is settled.
                    setFlow({ start: { kind: 'changed', change: result.change }, after: 'let-in' });
                    return;
                }
                const { staged } = result;
                if (staged.status === 'kept-other-keys') {
                    setKeptOther(staged.entry);
                    return;
                }
                if (staged.status === 'not-synced' && staged.sync.status === 'fork')
                    throw new Error(
                        `${family} looks different on this device. Nobody can be let in until that’s sorted.`,
                    );
                if (staged.status !== 'sent')
                    throw new Error(`Couldn’t check ${family}. Try again.`);
                const outcome = staged.outcome;
                void afterMembershipChange(queryClient, userId);
                switch (outcome.status) {
                    case 'landed':
                        return landed(result.heldBack);
                    case 'stale':
                        // Dropped and synced by the outbox: signed again over the new head.
                        continue;
                    case 'pending':
                        toast.add({
                            type: 'info',
                            title: 'Saved on this device',
                            description: `HushOS couldn’t reach the server. ${first} is let in once it can.`,
                        });
                        return;
                    case 'membership-moved':
                        cue('error');
                        setError(
                            outcome.code === 'left-due'
                                ? leftDueCopy(outcome.data, { names })
                                : (outcomeCopy(outcome, { family, person: first, names }) ?? ''),
                        );
                        return;
                    default:
                        cue('error');
                        if (outcome.status === 'refused' && outcome.code === 'seats')
                            setSeat(seatOf(outcome.data));
                        setError(outcomeCopy(outcome, { family, person: first, names }) ?? '');
                        return;
                }
            }
            throw new Error(`${family} keeps changing. Try again in a moment.`);
        } catch (cause) {
            cue('error');
            if (cause instanceof GroupApiError && cause.code === 'seats')
                setSeat(seatOf(cause.data));
            setError(errorCopy(cause, { family, person: first, names }));
        } finally {
            setBusy(null);
        }
    }

    function landed(heldBack: readonly string[]) {
        cue('success');
        toast.add({
            type: 'success',
            title: `${first} is in ${family}`,
            description: heldBack.includes('members')
                ? `${first} can manage the family once you’ve checked it’s ${first}.`
                : undefined,
        });
    }

    /* The kept admission with the old keys goes; they are still waiting, so it never landed. */
    async function dropAndLetIn() {
        if (!keptOther) return;
        setBusy('send');
        setError('');
        try {
            const fresh = (
                await queryClient.fetchQuery({
                    ...pendingQueryOptions(userId, groupId),
                    staleTime: 0,
                })
            ).find((at) => at.userId === person.userId);
            if (!fresh) throw new Error(`${first} isn’t waiting to join any more.`);
            await dropKeptAdmission(ctx, keptOther);
            setKeptOther(null);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first, names }));
            setBusy(null);
            return;
        }
        setBusy(null);
        await letThemIn();
    }

    async function notNow() {
        setBusy('decline');
        setError('');
        try {
            await groupsApi.decline(groupId, person.userId);
            cue('droplet');
            toast.add({
                type: 'success',
                title: `${first} won’t join ${family}`,
                description: 'You can invite them again.',
            });
            void queryClient.invalidateQueries({ queryKey: familyKeys.pending(userId, groupId) });
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first }));
        } finally {
            setBusy(null);
        }
    }

    const offered = !person.inFamily && !waitingForPlan;
    return (
        <>
            <Row
                name={person.name}
                seed={person.userId}
                data={{ 'data-pending': person.email }}
                line={person.email}
                wrap
                below={
                    (error || seat || keptOther || (offered && !blocked)) && (
                        <div className="flex flex-col gap-2 pl-12 empty:hidden">
                            {offered && !blocked && !error && !seat && (
                                <SeatNote userId={userId} groupId={groupId} first={first} />
                            )}
                            {keptOther && (
                                <div
                                    role="alert"
                                    className="flex flex-col items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-foreground"
                                >
                                    <p>
                                        An earlier Let them in for {first} hasn’t reached the
                                        server, and it was made before {first}’s account changed.
                                        Drop it and let {first} in again.
                                    </p>
                                    <Button
                                        variant="outline"
                                        disabled={busy !== null}
                                        onClick={() => void dropAndLetIn()}
                                    >
                                        Drop it and let them in
                                    </Button>
                                </div>
                            )}
                            {error && (
                                <p role="alert" className="text-[13px] text-destructive">
                                    {error}
                                </p>
                            )}
                            {seat && (
                                <SeatHelp
                                    userId={userId}
                                    groupId={groupId}
                                    roles={roles}
                                    reason={seat.reason}
                                    url={seat.url}
                                    onChoosePlan={() =>
                                        requestAnimationFrame(() =>
                                            document.getElementById('choose-plan')?.scrollIntoView({
                                                behavior: 'smooth',
                                                block: 'start',
                                            }),
                                        )
                                    }
                                />
                            )}
                        </div>
                    )
                }
            >
                {person.inFamily ? (
                    // One family per account: they joined or made another since accepting. That
                    // family is never named here.
                    <span className="text-[13px] text-muted-foreground" data-in-family>
                        Already in a family
                    </span>
                ) : waitingForPlan ? (
                    <span className="text-[13px] text-muted-foreground" data-waits-for-plan>
                        Can join once there’s a plan
                    </span>
                ) : (
                    <>
                        <Button
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => setConfirmingDecline(true)}
                        >
                            <PendingLabel
                                pending={busy === 'decline'}
                                idle="Not now"
                                busy="Turning down"
                            />
                        </Button>
                        <Button
                            // A departure to finish first: the server would refuse the admission.
                            disabled={busy !== null || Boolean(blocked) || Boolean(keptOther)}
                            title={blocked ?? undefined}
                            onClick={() => void letThemIn()}
                        >
                            <PendingLabel
                                pending={busy === 'send'}
                                idle="Let them in"
                                busy="Letting them in"
                            />
                        </Button>
                        <span className="-mr-2 sm:-mr-3">
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    render={
                                        <RowMenuButton
                                            aria-label={`More for ${person.name}`}
                                            disabled={busy !== null}
                                        />
                                    }
                                >
                                    <EllipsisIcon className="size-5" aria-hidden="true" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-60">
                                    <DropdownMenuItem
                                        onClick={() =>
                                            setFlow({
                                                start: {
                                                    kind: 'check',
                                                    person: {
                                                        email: person.email,
                                                        name: person.name,
                                                    },
                                                },
                                            })
                                        }
                                    >
                                        Check it’s {first} first
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </span>
                    </>
                )}
            </Row>
            <ContactFlowDialog
                userId={userId}
                start={flow?.start ?? null}
                onOpenChange={(open) => !open && setFlow(null)}
                onResolved={() => {
                    // A change settled (Continue, or a check): the admission that met it runs now.
                    if (flow?.after === 'let-in') void letThemIn();
                }}
            />
            <AlertDialog open={confirmingDecline} onOpenChange={setConfirmingDecline}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Turn {first} down?</AlertDialogTitle>
                        <AlertDialogDescription>
                            They’ll need a new invitation to join {family}. To decide later, close
                            this instead: nothing is lost.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                setConfirmingDecline(false);
                                void notNow();
                            }}
                        >
                            Turn down
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

type RoleChange = {
    member: FamilyMember;
    kind: 'manage' | 'stop' | 'organizer';
};

/* Who a member is, for the checks: their name and address as route 3 gives them. */
const refOf = (member: FamilyMember): FamilyMemberRef => ({
    userId: member.userId,
    name: member.name,
    email: member.email ?? '',
});

/* The members, each with whether this person checked them, and role changes for managers. */
export function MemberList({
    userId,
    groupId,
    family,
    members,
    view,
    manager,
    names,
    needsCheck = [],
    checking = false,
}: {
    userId: string;
    groupId: string;
    family: string;
    members: FamilyMember[];
    view: GroupView | null;
    manager: boolean;
    names: Record<string, string>;
    /* Members whose account changed with no signed chain (route 3's fold-ins this device could not do). */
    needsCheck?: readonly string[];
    /*
     * A newer member list is being checked and `view` is the last one: a role change builds the
     * member's next roles from it, so it waits until the check lands.
     */
    checking?: boolean;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState<RoleChange | null>(null);
    // A role that needs a check first, asked about (6.9): the check, then the change.
    const [checkFirst, setCheckFirst] = useState<RoleChange | null>(null);
    const [removing, setRemoving] = useState<FamilyMember | null>(null);
    const [busy, setBusy] = useState(false);
    const [checkingWith, setCheckingWith] = useState<{
        member: FamilyMember;
        after?: RoleChange;
    } | null>(null);
    // Their own twelve words (6.10), with the role change waiting on the check, if one is.
    const [words, setWords] = useState<{ member: FamilyMember; after?: RoleChange } | null>(null);
    const standings = useMemberStandings(userId, groupId, view);
    const settings = useQuery(settingsQueryOptions(userId));
    // The manager role this account asked for at invitation, waiting for a check (6.8): read only
    // from its own settings, never from the server's invitation roles.
    const invitedToManage = (member: FamilyMember) =>
        pendingRolesOf(settings.data?.settings, groupId, member.userId).includes('members');
    // Answered here (Let them manage it, Not now) while the save that clears it is on its way.
    const [answered, setAnswered] = useState<readonly string[]>([]);
    // Roles as the member list this device checked says, where it has one; else the server's.
    const rolesOf = (member: FamilyMember, at: GroupView | null = view): GroupRole[] =>
        (at?.members.find((entry) => entry.userId === member.userId)?.roles ??
            member.roles) as GroupRole[];
    // The organizer first, then everyone else in the order the server gives.
    const organizer = (member: FamilyMember) => (rolesOf(member).includes('billing') ? 0 : 1);
    const active = members
        .filter((member) => member.state === 'active')
        .sort((a, b) => organizer(a) - organizer(b));
    const me = active.find((member) => member.userId === userId);
    const myName = me ? firstName(me.name) : 'you';
    const iAmOrganizer = me ? rolesOf(me).includes('billing') : false;
    const theOrganizer = active.find(
        (member) => member.userId !== userId && rolesOf(member).includes('billing'),
    );
    // The family's only `billing` holder can't be removed (the server refuses it): someone else
    // must manage the plan first, so the menu says that instead of offering the removal.
    const withRoles = active.map((member) => ({ ...member, roles: rolesOf(member) }));
    const removeBlocked = (member: FamilyMember) =>
        removeBlocker(member.userId, firstName(member.name), withRoles);
    const standingOf = (member: FamilyMember) => standings.data?.get(member.userId);
    const changed = (member: FamilyMember) =>
        needsCheck.includes(member.userId) || standingOf(member) === 'changed';
    // After a family check that matched over keys that changed since they joined, their own
    // twelve words are the way to check them (6.10).
    const checkedFamilyWith = (member: FamilyMember) => {
        const record = settings.data?.settings.familyChecks?.[groupId];
        return Boolean(record && 'with' in record && record.with === member.userId);
    };
    function check(member: FamilyMember, after?: RoleChange) {
        if (changed(member) || (checkedFamilyWith(member) && standingOf(member) !== 'verified'))
            setWords({ member, after });
        else setCheckingWith({ member, after });
    }

    /*
     * A role change that waited on a check of their own words (DESIGN.md, Members: "Check
     * it's Sam first"), once they match. Someone whose account changed goes back into the
     * family folders first, as on Continue, so the role is given over the keys just checked;
     * while someone else's account change waits too, the change waits for Continue.
     */
    async function resume(change: RoleChange) {
        const { member } = change;
        if (!needsCheck.includes(member.userId)) return apply(change);
        const who = firstName(member.name);
        const others = active
            .filter(
                (other) =>
                    other.userId !== member.userId &&
                    other.userId !== userId &&
                    needsCheck.includes(other.userId),
            )
            .map((other) => firstName(other.name));
        if (others.length > 0) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t change that',
                description: `${
                    others.length === 1
                        ? `${others[0]}’s account`
                        : `${namesInWords(others.map((other) => `${other}’s`))} accounts`
                } changed too. Continue first, then try again.`,
            });
            return;
        }
        setBusy(true);
        try {
            const staged = await continueMembers(
                queryClient,
                userId,
                familyContext(userId),
                groupId,
                [refOf(member)],
                names,
            );
            const failed = stageFailure(staged, { family, person: who, names });
            if (failed) throw new Error(failed);
            const kept =
                staged.status === 'sent' && staged.outcome.status === 'landed'
                    ? staged.outcome.sync
                    : null;
            await apply(change, kept?.status === 'accepted' ? kept.view : view);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t change that',
                description: errorCopy(cause, { family, person: who, names }),
            });
            setBusy(false);
            void afterFamilyChange(queryClient, userId);
        }
    }

    /*
     * `at`: the member list to build on, when it is newer than the page's (after a Continue).
     * `invited`: the manager role asked for at invitation (6.8), whose waiting record goes once
     * given; given meanwhile from another tab or device, it ends quietly.
     */
    async function apply(
        change: RoleChange,
        at: GroupView | null = view,
        { invited = false }: { invited?: boolean } = {},
    ) {
        const ctx = familyContext(userId);
        const { member, kind } = change;
        const who = firstName(member.name);
        const ctxCopy = { family, person: who, names };
        setBusy(true);
        try {
            const roles = rolesOf(member, at);
            const next =
                kind === 'manage'
                    ? withRole(roles, 'members', true)
                    : kind === 'stop'
                      ? withRole(roles, 'members', false)
                      : withRole(roles, 'billing', true);
            // The manager rule, read again now (3.6): nothing is signed for someone not checked.
            if (needsCheckFor(roles, next) && at) {
                const now = await memberStandings(userId, at);
                if (now.get(member.userId) !== 'verified') {
                    setCheckFirst(change);
                    return;
                }
            }
            const first = await stageChange(ctx, groupId, {
                kind: 'roles',
                userId: member.userId,
                roles: next,
            });
            const failed = stageFailure(first, ctxCopy);
            if (failed) throw new Error(failed);
            // Handing over: the new organizer holds billing first, then this account lets go of it.
            if (kind === 'organizer' && me) {
                const second = await stageChange(ctx, groupId, {
                    kind: 'roles',
                    userId,
                    roles: withRole(rolesOf(me, at), 'billing', false),
                });
                const stillMine = stageFailure(second, ctxCopy);
                if (stillMine)
                    throw new Error(
                        `${who} is an organizer now, and so are you still: ${stillMine}`,
                    );
            }
            cue('success');
            toast.add({
                type: 'success',
                title:
                    kind === 'manage'
                        ? `${who} can manage the family`
                        : kind === 'stop'
                          ? `${who} no longer manages the family`
                          : `${who} is the organizer`,
            });
            if (kind === 'manage')
                await clearPendingRoles(queryClient, userId, groupId, [member.userId]).catch(
                    () => false,
                );
        } catch (cause) {
            if (invited && (await managesNow(member))) {
                await clearPendingRoles(queryClient, userId, groupId, [member.userId]).catch(
                    () => false,
                );
                return;
            }
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t change that',
                description: errorCopy(cause, ctxCopy),
            });
        } finally {
            setBusy(false);
            void afterFamilyChange(queryClient, userId);
        }
    }

    /* Whether `member` manages the family on the member list as it is now (another device gave it). */
    async function managesNow(member: FamilyMember) {
        const synced = await syncGroup(familyContext(userId), groupId).catch(() => null);
        return Boolean(
            synced?.status === 'accepted' &&
            synced.view.members
                .find((entry) => entry.userId === member.userId)
                ?.roles.includes('members'),
        );
    }

    /*
     * The member this account invited to manage the family, now Verified here, from whatever
     * check (on this device or another of this account's): asked whether to give the role, once,
     * while this account manages the family, they don't have it yet, and nothing else is open.
     */
    const askInvited =
        manager &&
        !busy &&
        !checking &&
        !confirming &&
        !checkFirst &&
        !removing &&
        !checkingWith &&
        !words
            ? (active.find(
                  (member) =>
                      member.userId !== userId &&
                      invitedToManage(member) &&
                      !answered.includes(member.userId) &&
                      standingOf(member) === 'verified' &&
                      !changed(member) &&
                      !rolesOf(member).includes('members'),
              ) ?? null)
            : null;
    function answerInvited(member: FamilyMember, give: boolean) {
        setAnswered((list) => [...list, member.userId]);
        if (give) void apply({ member, kind: 'manage' }, view, { invited: true });
        else
            void clearPendingRoles(queryClient, userId, groupId, [member.userId]).catch(
                () => false,
            );
    }

    // What no longer waits (they left, were removed, or manage the family now) goes from this
    // account's settings, on whichever of its devices sees it first; doing it twice is harmless.
    const done = pendingRolesDone(
        settings.data?.settings,
        groupId,
        members,
        (id) => view?.members.find((entry) => entry.userId === id)?.roles,
    ).join();
    useEffect(() => {
        if (done)
            void clearPendingRoles(queryClient, userId, groupId, done.split(',')).catch(
                () => false,
            );
    }, [done, groupId, queryClient, userId]);

    /* A role change that needs a check: asked first, unless this person checked them already. */
    function ask(change: RoleChange) {
        const next =
            change.kind === 'manage'
                ? withRole(rolesOf(change.member), 'members', true)
                : withRole(rolesOf(change.member), 'billing', true);
        if (needsCheckFor(rolesOf(change.member), next) && standingOf(change.member) !== 'verified')
            setCheckFirst(change);
        else setConfirming(change);
    }

    return (
        <Section title="Members">
            {active.map((member) => {
                const roles = rolesOf(member);
                const self = member.userId === userId;
                const who = firstName(member.name);
                const verified = standingOf(member) === 'verified';
                return (
                    <Row
                        key={member.userId}
                        name={member.name}
                        you={self}
                        seed={member.userId}
                        data={{ 'data-member': member.email ?? member.userId }}
                        line={member.email ?? ''}
                        badges={<RoleBadges roles={roles} />}
                        note={
                            self
                                ? undefined
                                : changed(member)
                                  ? 'Account changed'
                                  : invitedToManage(member) && !roles.includes('members')
                                    ? 'Will manage the family once checked'
                                    : undefined
                        }
                    >
                        {!self && <CheckedLabel standing={standingOf(member)} />}
                        {!self && (
                            // A bare ⋯ sits where Drive's, People's and Shared's do: the row's
                            // gutter is for bordered buttons, which a ghost button would sit inside.
                            <span className="-mr-2 sm:-mr-3">
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <RowMenuButton
                                                aria-label={`More for ${member.name}`}
                                                disabled={busy}
                                            />
                                        }
                                    >
                                        <EllipsisIcon className="size-5" aria-hidden="true" />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-64">
                                        <DropdownMenuGroup>
                                            <DropdownMenuItem onClick={() => check(member)}>
                                                {verified ? 'Check again' : `Check it’s ${who}`}
                                            </DropdownMenuItem>
                                            {manager &&
                                                (roles.includes('members') ? (
                                                    <DropdownMenuItem
                                                        disabled={checking}
                                                        onClick={() =>
                                                            setConfirming({ member, kind: 'stop' })
                                                        }
                                                    >
                                                        Stop them managing the family
                                                    </DropdownMenuItem>
                                                ) : (
                                                    <DropdownMenuItem
                                                        disabled={checking}
                                                        onClick={() =>
                                                            ask({ member, kind: 'manage' })
                                                        }
                                                    >
                                                        Let them manage the family
                                                    </DropdownMenuItem>
                                                ))}
                                            {manager &&
                                                iAmOrganizer &&
                                                !roles.includes('billing') && (
                                                    <DropdownMenuItem
                                                        disabled={checking}
                                                        onClick={() =>
                                                            ask({ member, kind: 'organizer' })
                                                        }
                                                    >
                                                        Make them the organizer
                                                    </DropdownMenuItem>
                                                )}
                                        </DropdownMenuGroup>
                                        {manager && (
                                            <>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuGroup>
                                                    {removeBlocked(member) ? (
                                                        <DropdownMenuItem
                                                            disabled
                                                            data-remove-blocked="last-billing"
                                                            className="flex-col items-start gap-0.5"
                                                        >
                                                            <span>Remove from family</span>
                                                            <span className="text-xs text-muted-foreground">
                                                                {removeBlocked(member)}
                                                            </span>
                                                        </DropdownMenuItem>
                                                    ) : (
                                                        <DropdownMenuItem
                                                            variant="destructive"
                                                            onClick={() => setRemoving(member)}
                                                        >
                                                            Remove from family
                                                        </DropdownMenuItem>
                                                    )}
                                                </DropdownMenuGroup>
                                            </>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </span>
                        )}
                    </Row>
                );
            })}
            <AlertDialog
                open={confirming !== null}
                onOpenChange={(open) => !open && setConfirming(null)}
            >
                <AlertDialogContent>
                    {confirming && (
                        <RoleConfirm
                            change={confirming}
                            family={family}
                            checking={checking}
                            onConfirm={() => {
                                const change = confirming;
                                setConfirming(null);
                                void apply(change);
                            }}
                        />
                    )}
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
                open={askInvited !== null}
                onOpenChange={(open) => !open && askInvited && answerInvited(askInvited, false)}
            >
                <AlertDialogContent data-invited-to-manage>
                    {askInvited && (
                        <>
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    {firstName(askInvited.name)} was invited to manage the family
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                    Let them manage it now?
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Not now</AlertDialogCancel>
                                <Button onClick={() => answerInvited(askInvited, true)}>
                                    Let them manage it
                                </Button>
                            </AlertDialogFooter>
                        </>
                    )}
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
                open={checkFirst !== null}
                onOpenChange={(open) => !open && setCheckFirst(null)}
            >
                <AlertDialogContent data-check-first>
                    {checkFirst && (
                        <>
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    Check it’s {firstName(checkFirst.member.name)} first
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                    Managers can let people in and change the family, so check it’s{' '}
                                    {firstName(checkFirst.member.name)} before they manage it. It
                                    takes a minute on a call or in person.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <Button
                                    onClick={() => {
                                        const change = checkFirst;
                                        setCheckFirst(null);
                                        check(change.member, change);
                                    }}
                                >
                                    Check it’s {firstName(checkFirst.member.name)}
                                </Button>
                            </AlertDialogFooter>
                        </>
                    )}
                </AlertDialogContent>
            </AlertDialog>
            {checkingWith && (
                <FamilyCheckDialog
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    member={refOf(checkingWith.member)}
                    me={myName}
                    organizer={theOrganizer ? firstName(theOrganizer.name) : null}
                    onClose={() => setCheckingWith(null)}
                    onCheckWords={() => {
                        // Their own words instead, the role change still waiting on them.
                        const { member, after } = checkingWith;
                        setCheckingWith(null);
                        setWords({ member, after });
                    }}
                    onChecked={({ verified }) => {
                        // Once checked, the role change goes ahead (6.9).
                        const after = checkingWith.after;
                        if (after && verified) void apply(after);
                    }}
                />
            )}
            <ContactFlowDialog
                userId={userId}
                start={
                    words
                        ? {
                              kind: 'check',
                              person: { email: words.member.email ?? '', name: words.member.name },
                          }
                        : null
                }
                onOpenChange={(open) => !open && setWords(null)}
                onResolved={() => {
                    // They match: the role change waiting on the check goes ahead (6.9).
                    const after = words?.after;
                    if (after) void resume(after);
                    else void afterFamilyChange(queryClient, userId);
                }}
            />
            {removing && (
                <RemoveDialog
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    member={removing}
                    names={names}
                    onClose={() => setRemoving(null)}
                />
            )}
        </Section>
    );
}

/*
 * "Sam's account changed" on the family page (6.9), for someone who manages
 * the family: one notice naming every member whose account changed with no
 * signed chain from the keys their entry names ("Sam’s and Ana’s accounts
 * changed"). Continue puts them all back in the family folders in one change,
 * every folder getting new keys in it (3.3): every folder's new keys go to
 * every member, so no one of them can be let back in while another waits.
 * Check it's Sam compares one person's own twelve words; when Sam is the only
 * one, Sam goes back in as on Continue, and otherwise the rest wait for
 * Continue. A manager among them manages the family again only once checked
 * (3.6).
 */
export function ChangedMembers({
    userId,
    groupId,
    family,
    members,
    view,
    needsCheck,
    names,
}: {
    userId: string;
    groupId: string;
    family: string;
    members: FamilyMember[];
    view: GroupView | null;
    needsCheck: readonly string[];
    /* First names by user id: another member whose account changed too is named. */
    names: Record<string, string>;
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [checkingWith, setCheckingWith] = useState<FamilyMember | null>(null);
    const changed = members.filter(
        (member) =>
            member.state === 'active' &&
            member.userId !== userId &&
            needsCheck.includes(member.userId),
    );
    if (changed.length === 0) return null;
    const whos = changed.map((member) => firstName(member.name));

    async function carryOn(list: readonly FamilyMember[]) {
        const who = namesInWords(list.map((member) => firstName(member.name)));
        const managed = list.filter((member) =>
            view?.members
                .find((entry) => entry.userId === member.userId)
                ?.roles.includes('members'),
        );
        setBusy(true);
        try {
            const staged = await continueMembers(
                queryClient,
                userId,
                familyContext(userId),
                groupId,
                list.map(refOf),
                names,
            );
            const failed = stageFailure(staged, { family, person: who });
            if (failed) throw new Error(failed);
            const kept =
                staged.status === 'sent' && staged.outcome.status === 'landed'
                    ? staged.outcome.sync
                    : null;
            const waiting = managed
                .filter(
                    (member) =>
                        !(
                            kept?.status === 'accepted' &&
                            kept.view.members
                                .find((entry) => entry.userId === member.userId)
                                ?.roles.includes('members')
                        ),
                )
                .map((member) => firstName(member.name));
            cue('success');
            toast.add({
                type: 'success',
                title: `${who} ${list.length === 1 ? 'has' : 'have'} the family folders again`,
                description:
                    waiting.length === 1
                        ? `${waiting[0]} can manage the family again once you’ve checked it’s ${waiting[0]}.`
                        : waiting.length > 1
                          ? `${namesInWords(waiting)} can manage the family again once you’ve checked it’s them.`
                          : undefined,
            });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t do that',
                description: errorCopy(cause, { family, person: who }),
            });
        } finally {
            setBusy(false);
            void afterMembershipChange(queryClient, userId);
        }
    }

    return (
        <>
            <Alert
                variant="info"
                data-account-changed={changed
                    .map((member) => member.email ?? member.userId)
                    .join(' ')}
            >
                <AlertTitle>
                    {changed.length === 1
                        ? `${whos[0]}’s account changed`
                        : `${namesInWords(whos.map((who) => `${who}’s`))} accounts changed`}
                </AlertTitle>
                <AlertDescription>
                    <p>
                        This happens when someone starts their HushOS account over. Continue to give{' '}
                        {namesInWords(whos)} the family folders again.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button disabled={busy} onClick={() => void carryOn(changed)}>
                            <PendingLabel pending={busy} idle="Continue" busy="Continuing" />
                        </Button>
                        {changed.map((member) => (
                            <Button
                                key={member.userId}
                                variant="outline"
                                disabled={busy}
                                onClick={() => setCheckingWith(member)}
                            >
                                Check it’s {firstName(member.name)}
                            </Button>
                        ))}
                    </div>
                </AlertDescription>
            </Alert>
            <ContactFlowDialog
                userId={userId}
                start={
                    checkingWith
                        ? {
                              kind: 'check',
                              person: { email: checkingWith.email ?? '', name: checkingWith.name },
                          }
                        : null
                }
                onOpenChange={(open) => !open && setCheckingWith(null)}
                onResolved={() => {
                    // Checked over the keys they have now: alone, they go back in, as on Continue;
                    // with others whose accounts changed too, everyone waits for Continue.
                    const member = checkingWith;
                    if (member && changed.length === 1) void carryOn([member]);
                    else void afterMembershipChange(queryClient, userId);
                }}
            />
        </>
    );
}

/* What a stageChange gave, as a sentence when it did not land. */
function stageFailure(staged: StageOutcome, ctx: Parameters<typeof outcomeCopy>[1]) {
    if (staged.status === 'sent') return outcomeCopy(staged.outcome, ctx);
    if (staged.status === 'not-synced')
        return staged.sync.status === 'fork'
            ? `${ctx?.family ?? 'The family'} looks different on this device.`
            : `Couldn’t check ${ctx?.family ?? 'the family'}. Try again.`;
    if (staged.status === 'nothing') return null;
    return 'An earlier change to this person is still waiting to be sent. Try again from Let them in.';
}

function RoleConfirm({
    change,
    family,
    checking,
    onConfirm,
}: {
    change: RoleChange;
    family: string;
    /* Opened before a newer member list turned up: confirming waits until it is checked. */
    checking: boolean;
    onConfirm: () => void;
}) {
    const who = firstName(change.member.name);
    const copy = {
        manage: {
            title: `Let ${who} manage the family?`,
            body: `${who} can invite people, let them in and change who manages ${family}.`,
            action: 'Let them manage',
        },
        stop: {
            title: `Stop ${who} managing the family?`,
            body: `${who} stays in ${family} and keeps the family folders, but can’t change who’s in it any more.`,
            action: 'Stop managing',
        },
        organizer: {
            title: `Make ${who} the organizer?`,
            body: `${who} takes over the family’s billing. You keep managing the family.`,
            action: 'Make organizer',
        },
    }[change.kind];
    return (
        <>
            <AlertDialogHeader>
                <AlertDialogTitle>{copy.title}</AlertDialogTitle>
                <AlertDialogDescription>{copy.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button disabled={checking} onClick={onConfirm}>
                    {copy.action}
                </Button>
            </AlertDialogFooter>
        </>
    );
}

/* Open invitations, each with "Cancel invitation". */
export function InvitationList({
    userId,
    groupId,
    invitations,
    members,
}: {
    userId: string;
    groupId: string;
    invitations: Invitation[];
    /* The family's members, to name an inviter with their address beside the name. */
    members: FamilyMember[];
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    // Asked once, as Not now and Remove from family are: an email can't be unsent, so no undo.
    const [confirming, setConfirming] = useState<Invitation | null>(null);
    const inviter = (id: string | null) => {
        const member = id ? members.find((at) => at.userId === id) : undefined;
        return member ? `${member.name}${member.email ? ` (${member.email})` : ''}` : 'a manager';
    };
    if (invitations.length === 0) return null;

    async function cancel(invitation: Invitation) {
        setBusy(invitation.id);
        try {
            await groupsApi.revokeInvitation(groupId, invitation.id);
            cue('droplet');
            toast.add({
                type: 'success',
                title: invitation.email
                    ? `Invitation to ${invitation.email} cancelled`
                    : 'Invitation cancelled',
            });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t cancel it',
                description: errorCopy(cause),
            });
        } finally {
            setBusy(null);
            void queryClient.invalidateQueries({
                queryKey: familyKeys.invitations(userId, groupId),
            });
        }
    }

    return (
        <Section title="Invitations">
            {invitations.map((invitation) => (
                <Row
                    key={invitation.id}
                    name={invitation.email ?? 'Someone invited'}
                    seed={invitation.email ?? invitation.id}
                    data={{ 'data-invitation': invitation.email ?? invitation.id }}
                    mark={
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <MailIcon className="size-4" aria-hidden="true" />
                        </span>
                    }
                    line={`Open until ${formatDay(invitation.expiresAt)}`}
                    note={`Invited by ${inviter(invitation.invitedBy)}`}
                >
                    <Button
                        variant="destructive-ghost"
                        // Its words line up with the column's edge, as an outline button's do.
                        className="-mr-3.5 pointer-coarse:-mr-4"
                        disabled={busy !== null}
                        onClick={() => setConfirming(invitation)}
                    >
                        {busy === invitation.id ? 'Cancelling…' : 'Cancel invitation'}
                    </Button>
                </Row>
            ))}
            <AlertDialog
                open={confirming !== null}
                onOpenChange={(open) => !open && setConfirming(null)}
            >
                <AlertDialogContent>
                    {confirming && (
                        <>
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    {confirming.email
                                        ? `Cancel the invitation to ${confirming.email}?`
                                        : 'Cancel this invitation?'}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                    The link in their email stops working. You can invite them
                                    again.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Keep invitation</AlertDialogCancel>
                                <Button
                                    variant="destructive"
                                    onClick={() => {
                                        const invitation = confirming;
                                        setConfirming(null);
                                        void cancel(invitation);
                                    }}
                                >
                                    Cancel invitation
                                </Button>
                            </AlertDialogFooter>
                        </>
                    )}
                </AlertDialogContent>
            </AlertDialog>
        </Section>
    );
}
