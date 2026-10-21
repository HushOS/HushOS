import type { GroupRole, GroupView } from '@hushos/crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EllipsisIcon, MailIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { RowMenuButton } from '@/components/drive/file-list';
import { Spinner } from '@/components/motion';
import { PersonAvatar } from '@/components/person-avatar';
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
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { formatDay, formatWhen } from '@/lib/drive';
import {
    afterFamilyChange,
    familyContext,
    familyKeys,
    firstName,
    rolesLine,
    withRole,
    type FamilyMember,
    type Invitation,
    type PendingPerson,
} from '@/lib/families';
import { groupsApi } from '@/lib/groups/api';
import { errorCopy, outcomeCopy } from '@/lib/groups/copy';
import { memberJoinCode } from '@/lib/groups/join';
import { stageChange, type StageOutcome } from '@/lib/groups/outbox';
import { cue } from '@/lib/sounds';
import { LetInDialog } from './let-in-dialog';
import { RemoveDialog } from './remove-dialog';
import { WordList } from './word-list';
import { removeBlocker } from '@/lib/family-leave';

/*
 * The family page's three lists: who waits to join (for managers, each with
 * "Let them in"), the members (route 3's names with their address beside
 * them, roles in words), and open invitations. Rows are 56px with 36px marks.
 * A member's menu changes roles and, last, removes them from the family.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col" aria-label={title}>
            <h2 className="eyebrow px-5 pt-6 pb-2 text-muted-foreground sm:px-8">{title}</h2>
            <ul className="flex flex-col border-t border-rule">{children}</ul>
        </section>
    );
}

/*
 * At least 56px, growing with what wraps: a long address truncates on its own
 * line, so it never hides the roles, which sit as small badges beside the
 * name (wrapping under it on a phone), or a note on a line of its own.
 */
function Row({
    name,
    seed,
    line,
    badges,
    note,
    data,
    mark,
    children,
}: {
    name: string;
    seed: string;
    line: string;
    badges?: ReactNode;
    /* Said whole on a line of its own, below the address, so truncating that never hides it. */
    note?: ReactNode;
    data?: Record<string, string>;
    /* In place of the person's initials: an invitation is an address, not yet anyone. */
    mark?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <li
            {...data}
            className="flex min-h-14 items-center gap-3 border-b border-rule py-2 pr-5 pl-5 sm:pr-8 sm:pl-8"
        >
            {mark ?? <PersonAvatar name={name} seed={seed} />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-[15px] font-medium">{name}</span>
                    {badges}
                </span>
                <span className="truncate text-[13px] text-muted-foreground">{line}</span>
                {note && (
                    <span className="text-[13px] text-pretty text-muted-foreground">{note}</span>
                )}
            </span>
            {children}
        </li>
    );
}

/* A member's roles in words, as small badges: "Organizer", "Manages the family", or "Member". */
function RoleBadges({ roles }: { roles: readonly string[] }) {
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
    blocked?: string | null;
    /* No live plan where plans are sold: admission would be refused, so it isn't offered. */
    waitingForPlan?: boolean;
}) {
    const [letting, setLetting] = useState<PendingPerson | null>(null);
    return (
        <>
            {pending.length > 0 && (
                <Section title="Waiting to join">
                    {pending.map((person) => (
                        <Row
                            key={person.userId}
                            name={person.name}
                            seed={person.userId}
                            data={{ 'data-pending': person.email }}
                            line={person.email}
                            note={`Accepted ${formatWhen(person.acceptedAt, { lower: true })}`}
                        >
                            {person.inFamily ? (
                                // One family per account: they joined or made another since
                                // accepting. That family is never named here.
                                <span
                                    className="shrink-0 text-[13px] text-muted-foreground"
                                    data-in-family
                                >
                                    Already in a family
                                </span>
                            ) : waitingForPlan ? (
                                <span
                                    className="shrink-0 text-[13px] text-muted-foreground"
                                    data-waits-for-plan
                                >
                                    Can join once there’s a plan
                                </span>
                            ) : (
                                <Button variant="outline" onClick={() => setLetting(person)}>
                                    Let them in
                                </Button>
                            )}
                        </Row>
                    ))}
                </Section>
            )}
            {/* Kept open once they're in and off this list: the join code is compared then. */}
            {letting && (
                <LetInDialog
                    userId={userId}
                    groupId={groupId}
                    family={family}
                    person={letting}
                    names={names}
                    blocked={blocked}
                    open
                    onOpenChange={(open) => !open && setLetting(null)}
                />
            )}
        </>
    );
}

type RoleChange = {
    member: FamilyMember;
    kind: 'manage' | 'stop' | 'organizer';
};

/* The members, with role changes for those who manage the family. */
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
    /* Members whose new keys no signed link reaches: their words need comparing again. */
    needsCheck?: readonly string[];
    /*
     * A newer member list is being checked and `view` is the last one: a role change builds the
     * member's next roles from it, so it waits until the check lands.
     */
    checking?: boolean;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState<RoleChange | null>(null);
    const [removing, setRemoving] = useState<FamilyMember | null>(null);
    const [busy, setBusy] = useState(false);
    const [showingCode, setShowingCode] = useState<FamilyMember | null>(null);
    // Roles as the member list this device checked says, where it has one; else the server's.
    const rolesOf = (member: FamilyMember): GroupRole[] =>
        (view?.members.find((entry) => entry.userId === member.userId)?.roles ??
            member.roles) as GroupRole[];
    // The organizer first, then everyone else in the order the server gives.
    const organizer = (member: FamilyMember) => (rolesOf(member).includes('billing') ? 0 : 1);
    const active = members
        .filter((member) => member.state === 'active')
        .sort((a, b) => organizer(a) - organizer(b));
    const me = active.find((member) => member.userId === userId);
    const iAmOrganizer = me ? rolesOf(me).includes('billing') : false;
    // The family's only `billing` holder can't be removed (the server refuses it): someone else
    // must manage the plan first, so the menu says that instead of offering the removal.
    const withRoles = active.map((member) => ({ ...member, roles: rolesOf(member) }));
    const removeBlocked = (member: FamilyMember) =>
        removeBlocker(member.userId, firstName(member.name), withRoles);

    async function apply(change: RoleChange) {
        const ctx = familyContext(userId);
        const { member, kind } = change;
        const who = firstName(member.name);
        const ctxCopy = { family, person: who, names };
        setBusy(true);
        try {
            const roles = rolesOf(member);
            const next =
                kind === 'manage'
                    ? withRole(roles, 'members', true)
                    : kind === 'stop'
                      ? withRole(roles, 'members', false)
                      : withRole(roles, 'billing', true);
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
                    roles: withRole(rolesOf(me), 'billing', false),
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
        } catch (cause) {
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

    return (
        <Section title="Members">
            {active.map((member) => {
                const roles = rolesOf(member);
                const self = member.userId === userId;
                const who = firstName(member.name);
                return (
                    <Row
                        key={member.userId}
                        name={self ? `${member.name} (you)` : member.name}
                        seed={member.userId}
                        data={{ 'data-member': member.email ?? member.userId }}
                        line={member.email ?? ''}
                        badges={<RoleBadges roles={roles} />}
                        note={
                            needsCheck.includes(member.userId)
                                ? `Check ${who}’s words again`
                                : undefined
                        }
                    >
                        {manager &&
                            !self && (
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
                                                {roles.includes('members') ? (
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
                                                            setConfirming({
                                                                member,
                                                                kind: 'manage',
                                                            })
                                                        }
                                                    >
                                                        Let them manage the family
                                                    </DropdownMenuItem>
                                                )}
                                                {iAmOrganizer && !roles.includes('billing') && (
                                                    <DropdownMenuItem
                                                        disabled={checking}
                                                        onClick={() =>
                                                            setConfirming({
                                                                member,
                                                                kind: 'organizer',
                                                            })
                                                        }
                                                    >
                                                        Make them the organizer
                                                    </DropdownMenuItem>
                                                )}
                                                <DropdownMenuItem
                                                    onClick={() => setShowingCode(member)}
                                                >
                                                    Show {who}’s join code
                                                </DropdownMenuItem>
                                            </DropdownMenuGroup>
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
            {showingCode && (
                <JoinCodeDialog
                    userId={userId}
                    groupId={groupId}
                    member={showingCode}
                    onClose={() => setShowingCode(null)}
                />
            )}
        </Section>
    );
}

/* What a stageChange gave, as a sentence when it did not land. */
function stageFailure(staged: StageOutcome, ctx: Parameters<typeof outcomeCopy>[1]) {
    if (staged.status === 'sent') return outcomeCopy(staged.outcome, ctx);
    if (staged.status === 'not-synced')
        return staged.sync.status === 'fork'
            ? `${ctx?.family ?? 'The family'}’s member list was shown differently to you.`
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
            body: `${who} takes over ${family}’s billing. You keep managing the family.`,
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

/*
 * A member's join code again, for a newcomer comparing it after the "Let
 * them in" dialog closed: worked out from this device's committed chain for
 * the member list that let them in, as the newcomer's screen does.
 */
function JoinCodeDialog({
    userId,
    groupId,
    member,
    onClose,
}: {
    userId: string;
    groupId: string;
    member: FamilyMember;
    onClose: () => void;
}) {
    const who = firstName(member.name);
    const code = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'join-code', member.userId],
        queryFn: async () =>
            (await memberJoinCode(familyContext(userId), groupId, member.userId)).code,
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>{who}’s join code</DialogTitle>
                    <DialogDescription>
                        {`Read all twelve words to ${who}. Two are hidden on ${who}’s screen; ${who} types those.`}
                    </DialogDescription>
                </DialogHeader>
                {code.isPending ? (
                    <Spinner className="size-4 text-muted-foreground" />
                ) : code.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                        {errorCopy(code.error)}
                    </p>
                ) : (
                    <WordList words={code.data} label="Join code" kind="join-code" />
                )}
            </DialogContent>
        </Dialog>
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
                        variant="destructive-outline"
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
