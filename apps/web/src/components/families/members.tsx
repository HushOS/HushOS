import type { GroupRole, GroupView } from '@hushos/crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EllipsisIcon, MailIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { RowMenuButton } from '@/components/drive/file-list';
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
import { stageChange, type StageOutcome } from '@/lib/groups/outbox';
import { cue } from '@/lib/sounds';
import { LetInDialog } from './let-in-dialog';
import { WordList } from './word-list';

/*
 * The family page's three lists: who waits to join (for managers, each with
 * "Let them in"), the members (route 3's names with their address beside
 * them, roles in words), and open invitations. Rows are 56px with 36px marks.
 * A member's menu changes roles; removal arrives with step 7, so it is not
 * offered here.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col" aria-label={title}>
            <h2 className="eyebrow px-5 pt-6 pb-2 text-muted-foreground sm:px-8">{title}</h2>
            <ul className="flex flex-col border-t border-rule">{children}</ul>
        </section>
    );
}

function Row({
    name,
    seed,
    line,
    data,
    mark,
    children,
}: {
    name: string;
    seed: string;
    line: string;
    data?: Record<string, string>;
    /* In place of the person's initials: an invitation is an address, not yet anyone. */
    mark?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <li
            {...data}
            className="flex h-14 items-center gap-3 border-b border-rule pr-3 pl-5 sm:pr-5 sm:pl-8"
        >
            {mark ?? <PersonAvatar name={name} seed={seed} />}
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium">{name}</span>
                <span className="truncate text-[13px] text-muted-foreground">{line}</span>
            </span>
            {children}
        </li>
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
}: {
    userId: string;
    groupId: string;
    family: string;
    pending: PendingPerson[];
    names: Record<string, string>;
    blocked?: string | null;
}) {
    const [letting, setLetting] = useState<PendingPerson | null>(null);
    if (pending.length === 0) return null;
    return (
        <Section title="Waiting to join">
            {pending.map((person) => (
                <Row
                    key={person.userId}
                    name={person.name}
                    seed={person.userId}
                    data={{ 'data-pending': person.email }}
                    line={`${person.email} · accepted ${formatWhen(person.acceptedAt, { lower: true })}`}
                >
                    <Button variant="outline" onClick={() => setLetting(person)}>
                        Let them in
                    </Button>
                </Row>
            ))}
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
        </Section>
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
}: {
    userId: string;
    groupId: string;
    family: string;
    members: FamilyMember[];
    view: GroupView | null;
    manager: boolean;
    names: Record<string, string>;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState<RoleChange | null>(null);
    const [busy, setBusy] = useState(false);
    const [showingCode, setShowingCode] = useState<FamilyMember | null>(null);
    const active = members.filter((member) => member.state === 'active');
    // Roles as the member list this device checked says, where it has one; else the server's.
    const rolesOf = (member: FamilyMember): GroupRole[] =>
        (view?.members.find((entry) => entry.userId === member.userId)?.roles ??
            member.roles) as GroupRole[];
    const me = active.find((member) => member.userId === userId);
    const iAmOrganizer = me ? rolesOf(me).includes('billing') : false;

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
                        line={`${member.email} · ${rolesLine(roles)}`}
                    >
                        {manager && !self && (
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
                                                onClick={() =>
                                                    setConfirming({ member, kind: 'stop' })
                                                }
                                            >
                                                Stop them managing the family
                                            </DropdownMenuItem>
                                        ) : (
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    setConfirming({ member, kind: 'manage' })
                                                }
                                            >
                                                Let them manage the family
                                            </DropdownMenuItem>
                                        )}
                                        {iAmOrganizer && !roles.includes('billing') && (
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    setConfirming({ member, kind: 'organizer' })
                                                }
                                            >
                                                Make them the organizer
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuItem onClick={() => setShowingCode(member)}>
                                            Show {who}’s join code
                                        </DropdownMenuItem>
                                    </DropdownMenuGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
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
                            onConfirm={() => {
                                const change = confirming;
                                setConfirming(null);
                                void apply(change);
                            }}
                        />
                    )}
                </AlertDialogContent>
            </AlertDialog>
            {showingCode && (
                <JoinCodeDialog
                    userId={userId}
                    groupId={groupId}
                    member={showingCode}
                    version={
                        view?.members.some(
                            (entry) =>
                                entry.userId === showingCode.userId && entry.status === 'active',
                        )
                            ? view.rosterVersion
                            : null
                    }
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
    return 'This is waiting for you to finish checking.';
}

function RoleConfirm({
    change,
    family,
    onConfirm,
}: {
    change: RoleChange;
    family: string;
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
                <Button onClick={onConfirm}>{copy.action}</Button>
            </AlertDialogFooter>
        </>
    );
}

/*
 * A join code again, for a newcomer whose typed code did not match: the code
 * of the newest member list this device checked. Any member list at or after
 * the one that let them in is a mark that covers it (the newcomer's device
 * then checks the family's history through it), so the newest is used: it
 * needs no version from the server, which a server could pick to cover less,
 * and it is the number the newcomer's screen offers first. Both screens show
 * the number, so the two compare it too.
 */
function JoinCodeDialog({
    userId,
    groupId,
    member,
    version,
    onClose,
}: {
    userId: string;
    groupId: string;
    member: FamilyMember;
    version: number | null;
    onClose: () => void;
}) {
    const who = firstName(member.name);
    const code = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'join-code', member.userId, version],
        queryFn: async () => {
            if (version === null) throw new Error('Reload the page, then try again.');
            return (await familyContext(userId).rpc('groupJoinCode', { groupId, version })).code;
        },
        staleTime: Infinity,
        retry: false,
    });
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>{who}’s join code</DialogTitle>
                    <DialogDescription>
                        If {who}’s screen says the join code didn’t match, read this to them again.
                    </DialogDescription>
                </DialogHeader>
                {code.isPending ? null : code.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                        {errorCopy(code.error)}
                    </p>
                ) : (
                    <div className="flex flex-col gap-3">
                        <p className="text-[15px] font-semibold">
                            Join code for member list {version}
                        </p>
                        <WordList words={code.data} label="Join code" kind="join-code" />
                    </div>
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
                    line={`Invited by ${inviter(invitation.invitedBy)} · open until ${formatDay(invitation.expiresAt)}`}
                >
                    <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void cancel(invitation)}
                    >
                        {busy === invitation.id ? 'Cancelling…' : 'Cancel invitation'}
                    </Button>
                </Row>
            ))}
        </Section>
    );
}
