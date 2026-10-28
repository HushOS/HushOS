import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GroupView } from '@hushos/crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FamilyMember } from '@/lib/families';
import type * as Pending from '@/lib/family-pending';
import type * as Copy from '@/lib/groups/copy';

/*
 * The family page's member lists (docs/optional-verification.md 6.9), with
 * the checks, the outbox and Continue as stand-ins: what is tested is what
 * the page asks of them, and when.
 */

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const SAM = 'b2b2b2b2-0000-4000-8000-000000000002';
const ANA = 'c3c3c3c3-0000-4000-8000-000000000003';
const LEE = 'd4d4d4d4-0000-4000-8000-000000000004';

/* Whether They match was pressed: the standings say verified from then on. */
let matched = false;
const order: string[] = [];
const stageChange = vi.fn(async (..._args: unknown[]) => {
    order.push('roles');
    return { status: 'sent', outcome: { status: 'landed', sync: null } };
});
const continueMembers = vi.fn(async (..._args: unknown[]) => {
    order.push('continue');
    return {
        status: 'sent',
        outcome: { status: 'landed', sync: { status: 'accepted', view: viewWith([]) } },
    };
});
const toastAdd = vi.fn();
/* This account's settings, as the settings query reads them. */
let settingsDoc: Record<string, unknown> = { version: 2, contacts: {} };
/* What clearing a waiting role saves: the same change, on the settings above. */
const clearPendingRoles = vi.fn(
    async (_queryClient: unknown, _userId: string, groupId: string, userIds: string[] | 'all') => {
        const { withoutPendingRoles } =
            await vi.importActual<typeof Pending>('@/lib/family-pending');
        settingsDoc = withoutPendingRoles(settingsDoc as never, groupId, userIds) as never;
        return true;
    },
);
/* Who route 16 says waits, with the roles the server keeps for their invitation. */
let waitingPeople: unknown[] = [];
const letInWithoutWords = vi.fn(async (..._args: unknown[]) => ({
    outcome: 'staged',
    staged: { status: 'sent', outcome: { status: 'landed' } },
    heldBack: [],
}));
/* The family as a sync reads it now: Sam managing it, when another device gave the role. */
let syncedView: GroupView | null = null;

vi.mock('@/components/drive/contact-flow', () => ({
    ContactFlowDialog: ({
        start,
        onResolved,
        onOpenChange,
    }: {
        start: { person: { name: string } } | null;
        onResolved?: () => void;
        onOpenChange: (open: boolean) => void;
    }) =>
        start ? (
            <dialog open aria-label={`Their words: ${start.person.name}`}>
                <button
                    onClick={() => {
                        matched = true;
                        onResolved?.();
                        // Done: the flow closes.
                        onOpenChange(false);
                    }}
                >
                    They match
                </button>
            </dialog>
        ) : null,
}));
vi.mock('./family-check', async () => {
    const { useQueryClient } = await import('@tanstack/react-query');
    return {
        FamilyCheckDialog: ({
            onCheckWords,
            onChecked,
            onClose,
        }: {
            onCheckWords: () => void;
            onChecked?: (result: { verified: boolean }) => void;
            onClose: () => void;
        }) => {
            const queryClient = useQueryClient();
            return (
                <dialog open aria-label="Family check">
                    <button onClick={onCheckWords}>Check Sam’s words</button>
                    <button
                        onClick={() => {
                            // The family check's They match: verified, and the page reads again.
                            matched = true;
                            onChecked?.({ verified: true });
                            void queryClient.invalidateQueries().then(onClose);
                        }}
                    >
                        Family words match
                    </button>
                </dialog>
            );
        },
    };
});
vi.mock('./remove-dialog', () => ({ RemoveDialog: () => null }));
vi.mock('./family-billing', () => ({ SeatHelp: () => null, SeatNote: () => null }));
vi.mock('@/components/drive/file-list', () => ({
    RowMenuButton: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));
vi.mock('@/components/ui/toast', () => ({
    toast: { add: (...args: unknown[]) => toastAdd(...args) },
}));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
vi.mock('@/lib/drive', () => ({ formatDay: () => '3 Nov' }));
vi.mock('@/lib/contacts', () => ({
    guardRevision: () => 0,
    settingsQueryOptions: (userId: string) => ({
        queryKey: ['settings', userId],
        queryFn: async () => ({ settings: settingsDoc }),
    }),
}));
vi.mock('@/lib/families', () => ({
    afterFamilyChange: vi.fn(async (queryClient: { invalidateQueries: () => Promise<void> }) =>
        queryClient.invalidateQueries(),
    ),
    afterMembershipChange: vi.fn(async () => {}),
    familiesQueryOptions: (userId: string) => ({
        queryKey: ['families', userId],
        queryFn: async () => [{ id: 'g', roles: ['billing', 'members'] }],
    }),
    pendingQueryOptions: (userId: string, groupId: string) => ({
        queryKey: ['pending', userId, groupId],
        queryFn: async () => waitingPeople,
    }),
    familyContext: () => ({}),
    familyKeys: {
        family: (userId: string, groupId: string) => ['family', userId, groupId],
        invitations: (userId: string, groupId: string) => ['invitations', userId, groupId],
    },
    firstName: (name: string) => name.split(' ')[0],
    rolesLine: () => '',
    withRole: (roles: string[], role: string, on: boolean) =>
        ['billing', 'guardian', 'members'].filter((at) => (at === role ? on : roles.includes(at))),
}));
vi.mock('@/lib/family-leave', () => ({ removeBlocker: () => null }));
vi.mock('@/lib/family-trust', () => ({
    continueMembers: (...args: unknown[]) => continueMembers(...args),
    letInWithoutWords: (...args: unknown[]) => letInWithoutWords(...args),
    memberStandings: async () =>
        new Map([
            [SAM, matched ? 'verified' : 'not-verified'],
            [ANA, 'not-verified'],
        ]),
    needsCheckFor: (roles: string[], next: string[]) =>
        (next.includes('members') && !roles.includes('members')) ||
        (next.includes('billing') && !roles.includes('billing')),
}));
const revokeInvitation = vi.fn(async (..._args: unknown[]) => ({ revoked: true }));
vi.mock('@/lib/groups/api', () => ({
    GroupApiError: class extends Error {},
    groupsApi: { revokeInvitation: (...args: unknown[]) => revokeInvitation(...args) },
}));
vi.mock('@/lib/groups/outbox', () => ({
    dropKeptAdmission: vi.fn(),
    stageChange: (...args: unknown[]) => stageChange(...args),
}));
vi.mock('@/lib/family-pending', async (original) => ({
    ...(await original<typeof Pending>()),
    clearPendingRoles: (...args: Parameters<typeof clearPendingRoles>) =>
        clearPendingRoles(...args),
    // A save of this account's settings, as compare-and-set makes it: the change over what's there.
    clearInvitedRole: async (
        _queryClient: unknown,
        _userId: string,
        groupId: string,
        id: string,
    ) => {
        const held = { ...(settingsDoc.pendingRoles as Record<string, Record<string, unknown>>) };
        const group = { ...held[groupId] };
        delete group[id];
        if (Object.keys(group).length) held[groupId] = group;
        else delete held[groupId];
        settingsDoc = { ...settingsDoc, pendingRoles: Object.keys(held).length ? held : undefined };
        return true;
    },
    savePendingRoles: async (
        queryClient: { invalidateQueries: () => Promise<void> } | undefined,
        _userId: string,
        change: (settings: never) => never,
    ) => {
        settingsDoc = change(settingsDoc as never);
        await queryClient?.invalidateQueries();
        return true;
    },
}));
vi.mock('@/lib/groups/sync', () => ({
    syncGroup: async () => (syncedView ? { status: 'accepted', view: syncedView } : null),
}));
vi.mock('@/lib/groups/copy', async (original) => ({
    ...(await original<typeof Copy>()),
    errorCopy: (cause: Error) => cause.message,
    outcomeCopy: () => null,
}));
const { ChangedMembers, InvitationList, MemberList, PendingList } = await import('./members');
const { pendingRolesOf } = await import('@/lib/family-pending');

const person = (userId: string, name: string, roles: string[] = []): FamilyMember =>
    ({
        userId,
        name,
        email: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
        state: 'active',
        roles,
    }) as unknown as FamilyMember;
const ORGANIZER = ['billing', 'guardian', 'members'];
function viewWith(managers: string[]): GroupView {
    return {
        rosterDigest: `digest-${managers.join()}`,
        members: [
            { userId: ALICE, status: 'active', roles: ORGANIZER },
            { userId: SAM, status: 'active', roles: managers.includes(SAM) ? ['members'] : [] },
            { userId: ANA, status: 'active', roles: [] },
        ],
    } as unknown as GroupView;
}

function list(needsCheck: string[]) {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <MemberList
                userId={ALICE}
                groupId="g"
                family="Holm family"
                members={[
                    person(ALICE, 'Alice Holm', ORGANIZER),
                    person(SAM, 'Sam Holm'),
                    person(ANA, 'Ana Holm'),
                ]}
                view={viewWith([])}
                manager
                names={{ [SAM]: 'Sam', [ANA]: 'Ana' }}
                needsCheck={needsCheck}
            />
        </QueryClientProvider>,
    );
}

/* Let them manage the family, on Sam's row, then the check it asks for first. */
async function askToManageSam(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'More for Sam Holm' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Let them manage the family' }));
    await user.click(await screen.findByRole('button', { name: 'Check it’s Sam' }));
}

const promotedSam = () =>
    stageChange.mock.calls.some(
        ([, , op]) =>
            (op as { kind: string; userId: string; roles: string[] }).kind === 'roles' &&
            (op as { userId: string }).userId === SAM &&
            (op as { roles: string[] }).roles.includes('members'),
    );

/*
 * A role that waits on a check (DESIGN.md, Members: "Check it's Sam first"):
 * when the check goes through someone's own twelve words, whether straight
 * away (their account changed) or because the family check can't be done on
 * this device, They match must still finish the role change, and someone
 * whose account changed goes back into the family folders first, so the role
 * is given over the keys just checked.
 */
describe('a role change that waits on a check of their own words', () => {
    beforeEach(() => {
        matched = false;
        order.length = 0;
        stageChange.mockClear();
        continueMembers.mockClear();
        toastAdd.mockClear();
    });

    test('for someone whose account changed: They match lets them back in, then gives the role', async () => {
        const user = userEvent.setup();
        list([SAM]);
        await askToManageSam(user);
        // Their account changed, so straight to their own words; nothing is signed before.
        await user.click(
            (await screen.findByRole('dialog', { name: 'Their words: Sam Holm' })).querySelector(
                'button',
            )!,
        );
        await waitFor(() => expect(promotedSam()).toBe(true));
        expect(order).toEqual(['continue', 'roles']);
        expect(continueMembers.mock.calls[0]![4]).toEqual([
            { userId: SAM, name: 'Sam Holm', email: 'sam@example.com' },
        ]);
    });

    test('when the family check falls back to their words: They match still gives the role', async () => {
        const user = userEvent.setup();
        list([]);
        await askToManageSam(user);
        await user.click(await screen.findByRole('button', { name: 'Check Sam’s words' }));
        await user.click(
            (await screen.findByRole('dialog', { name: 'Their words: Sam Holm' })).querySelector(
                'button',
            )!,
        );
        await waitFor(() => expect(promotedSam()).toBe(true));
        // Their account didn't change: no one is let back in on the way.
        expect(continueMembers).not.toHaveBeenCalled();
    });

    test('while someone else’s account change waits too, nothing is signed and the page says why', async () => {
        const user = userEvent.setup();
        list([SAM, ANA]);
        await askToManageSam(user);
        await user.click(
            (await screen.findByRole('dialog', { name: 'Their words: Sam Holm' })).querySelector(
                'button',
            )!,
        );
        await waitFor(() =>
            expect(toastAdd).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'error',
                    description: 'Ana’s account changed too. Continue first, then try again.',
                }),
            ),
        );
        expect(continueMembers).not.toHaveBeenCalled();
        expect(stageChange).not.toHaveBeenCalled();
    });
});

/*
 * Everyone whose account changed, on one notice (6.9): named together, with
 * one Continue that lets them all back in, since no one of them can go back
 * in while another waits; Check it's Sam checks one person, and when others
 * wait too, Sam waits with them for Continue.
 */
function notice(changed: string[]) {
    const everyone = [
        person(ALICE, 'Alice Holm', ORGANIZER),
        person(SAM, 'Sam Holm'),
        person(ANA, 'Ana Holm'),
        person(LEE, 'Lee Holm'),
    ];
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ChangedMembers
                userId={ALICE}
                groupId="g"
                family="Holm family"
                members={everyone}
                view={viewWith([])}
                needsCheck={changed}
                names={{ [SAM]: 'Sam', [ANA]: 'Ana', [LEE]: 'Lee' }}
            />
        </QueryClientProvider>,
    );
}
const continuedFor = () =>
    (continueMembers.mock.calls[0]![4] as { userId: string }[]).map((member) => member.userId);

describe('the notice for accounts that changed', () => {
    beforeEach(() => {
        continueMembers.mockClear();
        toastAdd.mockClear();
    });

    test('names one person as the spec says it', async () => {
        notice([SAM]);
        expect(await screen.findByText('Sam’s account changed')).toBeTruthy();
        expect(
            screen.getByText(
                'This happens when someone starts their HushOS account over. Continue to give Sam the family folders again.',
            ),
        ).toBeTruthy();
    });

    test('names two, with one Continue for both', async () => {
        const user = userEvent.setup();
        notice([SAM, ANA]);
        expect(await screen.findByText('Sam’s and Ana’s accounts changed')).toBeTruthy();
        expect(
            screen.getByText(
                'This happens when someone starts their HushOS account over. Continue to give Sam and Ana the family folders again.',
            ),
        ).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(continueMembers).toHaveBeenCalledTimes(1));
        expect(continuedFor()).toEqual([SAM, ANA]);
        await waitFor(() =>
            expect(toastAdd).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Sam and Ana have the family folders again' }),
            ),
        );
    });

    test('names three, with one Continue for all of them', async () => {
        const user = userEvent.setup();
        notice([SAM, ANA, LEE]);
        expect(await screen.findByText('Sam’s, Ana’s and Lee’s accounts changed')).toBeTruthy();
        expect(
            screen.getByText(
                'This happens when someone starts their HushOS account over. Continue to give Sam, Ana and Lee the family folders again.',
            ),
        ).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await waitFor(() => expect(continueMembers).toHaveBeenCalledTimes(1));
        expect(continuedFor()).toEqual([SAM, ANA, LEE]);
    });

    test('Check it’s Sam checks Sam alone: with others waiting, no one is let back in yet', async () => {
        const user = userEvent.setup();
        notice([SAM, ANA]);
        await user.click(await screen.findByRole('button', { name: 'Check it’s Sam' }));
        await user.click(
            (await screen.findByRole('dialog', { name: 'Their words: Sam Holm' })).querySelector(
                'button',
            )!,
        );
        expect(continueMembers).not.toHaveBeenCalled();
    });

    test('Check it’s Sam, when Sam is the only one, lets Sam back in', async () => {
        const user = userEvent.setup();
        notice([SAM]);
        await user.click(await screen.findByRole('button', { name: 'Check it’s Sam' }));
        await user.click(
            (await screen.findByRole('dialog', { name: 'Their words: Sam Holm' })).querySelector(
                'button',
            )!,
        );
        await waitFor(() => expect(continueMembers).toHaveBeenCalledTimes(1));
        expect(continuedFor()).toEqual([SAM]);
    });
});

/*
 * The manager role this account asked for at invitation (6.8), held back at
 * Let them in: kept only in its own settings, shown only here as "Will manage
 * the family once checked", and offered once Sam reads Verified, from any
 * check. Never from anything the server says.
 */
describe('a manager role held back at Let them in', () => {
    /* Alice's record of Invite someone, tied to Sam (let in under the address she typed). */
    const invited = (tied = true) =>
        (settingsDoc = {
            version: 2,
            contacts: {},
            pendingRoles: {
                g: {
                    'invitation-1': {
                        email: 'sam@example.com',
                        roles: ['members'],
                        since: '2026-10-28T00:00:00Z',
                        ...(tied ? { userId: SAM } : {}),
                    },
                },
            },
        });
    let client: QueryClient;
    function page(options: { manager?: boolean; members?: FamilyMember[]; userId?: string } = {}) {
        client = new QueryClient();
        render(
            <QueryClientProvider client={client}>
                <MemberList
                    userId={options.userId ?? ALICE}
                    groupId="g"
                    family="Holm family"
                    members={
                        options.members ?? [
                            person(ALICE, 'Alice Holm', ORGANIZER),
                            person(SAM, 'Sam Holm'),
                            person(ANA, 'Ana Holm'),
                        ]
                    }
                    view={viewWith([])}
                    manager={options.manager ?? true}
                    names={{ [SAM]: 'Sam', [ANA]: 'Ana' }}
                />
            </QueryClientProvider>,
        );
    }
    const prompt = () => screen.queryByRole('alertdialog', { name: /was invited to manage/ });
    const samRow = () => document.querySelector('[data-member="sam@example.com"]')!;
    async function checkSamInTheFamily(user: ReturnType<typeof userEvent.setup>) {
        await user.click(await screen.findByRole('button', { name: 'More for Sam Holm' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Check it’s Sam' }));
    }

    beforeEach(() => {
        matched = false;
        syncedView = null;
        settingsDoc = { version: 2, contacts: {} };
        stageChange.mockClear();
        clearPendingRoles.mockClear();
        toastAdd.mockClear();
    });

    test('says so under Sam on this account’s devices, and asks after a family check', async () => {
        const user = userEvent.setup();
        invited();
        page();
        await waitFor(() =>
            expect(samRow().textContent).toContain('Will manage the family once checked'),
        );
        expect(prompt()).toBeNull();
        await checkSamInTheFamily(user);
        await user.click(await screen.findByRole('button', { name: 'Family words match' }));
        const asked = await screen.findByRole(
            'alertdialog',
            {
                name: 'Sam was invited to manage the family',
            },
            { timeout: 5_000 },
        );
        expect(asked.textContent).toContain('Let them manage it now?');
        // Let them manage it: the role, and nothing waits any more.
        await user.click(screen.getByRole('button', { name: 'Let them manage it' }));
        await waitFor(() => expect(promotedSam()).toBe(true));
        await waitFor(() =>
            expect(clearPendingRoles).toHaveBeenCalledWith(expect.anything(), ALICE, 'g', [SAM]),
        );
    });

    test('asks after a check of Sam’s own words', async () => {
        const user = userEvent.setup();
        invited();
        page();
        await checkSamInTheFamily(user);
        await user.click(await screen.findByRole('button', { name: 'Check Sam’s words' }));
        await user.click(
            (await screen.findByRole('dialog', { name: 'Their words: Sam Holm' })).querySelector(
                'button',
            )!,
        );
        expect(
            await screen.findByRole(
                'alertdialog',
                {
                    name: 'Sam was invited to manage the family',
                },
                { timeout: 5_000 },
            ),
        ).toBeTruthy();
    });

    test('asks after a check on another of this account’s devices; Not now clears it and gives nothing', async () => {
        const user = userEvent.setup();
        invited();
        page();
        await waitFor(() =>
            expect(samRow().textContent).toContain('Will manage the family once checked'),
        );
        // Checked elsewhere: this device only reads it.
        matched = true;
        await client.invalidateQueries();
        await screen.findByRole(
            'alertdialog',
            { name: 'Sam was invited to manage the family' },
            { timeout: 5_000 },
        );
        await user.click(screen.getByRole('button', { name: 'Not now' }));
        await waitFor(() =>
            expect(clearPendingRoles).toHaveBeenCalledWith(expect.anything(), ALICE, 'g', [SAM]),
        );
        expect(stageChange).not.toHaveBeenCalled();
        await waitFor(() => expect(prompt()).toBeNull());
        await client.invalidateQueries();
        await waitFor(() =>
            expect(samRow().textContent).not.toContain('Will manage the family once checked'),
        );
    });

    test('never comes from the server: no waiting role here, no line and no question, however Sam was invited', async () => {
        matched = true;
        page({
            members: [
                person(ALICE, 'Alice Holm', ORGANIZER),
                // What route 3 and the invitation say: Sam asked to manage it.
                { ...person(SAM, 'Sam Holm'), invitationRoles: ['members'] } as FamilyMember,
                person(ANA, 'Ana Holm'),
            ],
        });
        await waitFor(() => expect(samRow().textContent).toContain('Verified'));
        expect(samRow().textContent).not.toContain('Will manage the family once checked');
        expect(prompt()).toBeNull();
    });

    test('asks only while this account manages the family', async () => {
        invited();
        matched = true;
        page({ manager: false });
        await waitFor(() => expect(samRow().textContent).toContain('Verified'));
        expect(prompt()).toBeNull();
    });

    test('given meanwhile from another device, Let them manage it ends quietly', async () => {
        const user = userEvent.setup();
        invited();
        matched = true;
        page();
        await screen.findByRole(
            'alertdialog',
            { name: 'Sam was invited to manage the family' },
            { timeout: 5_000 },
        );
        stageChange.mockRejectedValueOnce(new Error('Sam already manages the family.'));
        syncedView = viewWith([SAM]);
        await user.click(screen.getByRole('button', { name: 'Let them manage it' }));
        await waitFor(() =>
            expect(clearPendingRoles).toHaveBeenCalledWith(expect.anything(), ALICE, 'g', [SAM]),
        );
        expect(toastAdd).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    test('goes when Sam is removed or leaves', async () => {
        invited();
        page({
            members: [
                person(ALICE, 'Alice Holm', ORGANIZER),
                { ...person(SAM, 'Sam Holm'), state: 'removed' } as unknown as FamilyMember,
                person(ANA, 'Ana Holm'),
            ],
        });
        await waitFor(() => expect(settingsDoc.pendingRoles).toBeUndefined());
    });

    test('Alice invited Sam to manage it and Ana let him in: only Alice’s device asks', async () => {
        matched = true;
        const everyone = [
            person(ALICE, 'Alice Holm', ORGANIZER),
            person(SAM, 'Sam Holm'),
            person(ANA, 'Ana Holm', ['members']),
        ];
        // Ana's device: she pressed Let them in, and holds no record of anyone's intent.
        page({ userId: ANA, members: everyone });
        await waitFor(() => expect(samRow().textContent).toContain('Verified'));
        expect(samRow().textContent).not.toContain('Will manage the family once checked');
        expect(prompt()).toBeNull();
        cleanup();
        // Alice's device: her record of Invite someone asks.
        invited();
        page({ members: everyone });
        expect(
            await screen.findByRole(
                'alertdialog',
                {
                    name: 'Sam was invited to manage the family',
                },
                { timeout: 5_000 },
            ),
        ).toBeTruthy();
    });

    test('already checked when the inviter lets him in: asked straight away, and the role only on Let them manage it', async () => {
        const user = userEvent.setup();
        // Just let in (as a member), checked before, under the address Alice typed.
        invited(false);
        matched = true;
        page();
        await screen.findByRole(
            'alertdialog',
            { name: 'Sam was invited to manage the family' },
            { timeout: 5_000 },
        );
        expect(stageChange).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Let them manage it' }));
        await waitFor(() => expect(promotedSam()).toBe(true));
    });

    test('is tied to Sam only once he is let in under the address Alice typed', async () => {
        invited(false);
        // Let in under another address: never him.
        page({
            members: [
                person(ALICE, 'Alice Holm', ORGANIZER),
                { ...person(SAM, 'Sam Holm'), email: 'sam.other@example.com' } as FamilyMember,
                person(ANA, 'Ana Holm'),
            ],
        });
        await waitFor(() =>
            expect(document.querySelector('[data-member="sam.other@example.com"]')).not.toBeNull(),
        );
        expect(document.body.textContent).not.toContain('Will manage the family once checked');
        expect(pendingRolesOf(settingsDoc as never, 'g', SAM)).toEqual([]);
        cleanup();
        // Let in under the address she typed: tied, and the line shows.
        invited(false);
        page();
        await waitFor(() =>
            expect(samRow().textContent).toContain('Will manage the family once checked'),
        );
        expect(pendingRolesOf(settingsDoc as never, 'g', SAM)).toEqual(['members']);
    });

    test('goes with its invitation, cancelled on this device', async () => {
        const user = userEvent.setup();
        invited(false);
        render(
            <QueryClientProvider client={new QueryClient()}>
                <InvitationList
                    userId={ALICE}
                    groupId="g"
                    invitations={[
                        {
                            id: 'invitation-1',
                            email: 'sam@example.com',
                            roles: ['members'],
                            invitedBy: ALICE,
                            expiresAt: '2026-11-04T00:00:00.000Z',
                        } as never,
                    ]}
                    members={[person(ALICE, 'Alice Holm', ORGANIZER)]}
                />
            </QueryClientProvider>,
        );
        await user.click(screen.getByRole('button', { name: 'Cancel invitation' }));
        await user.click(
            within(await screen.findByRole('alertdialog')).getByRole('button', {
                name: 'Cancel invitation',
            }),
        );
        await waitFor(() => expect(revokeInvitation).toHaveBeenCalledWith('g', 'invitation-1'));
        await waitFor(() => expect(settingsDoc.pendingRoles).toBeUndefined());
    });
});

/*
 * Let them in (6.8, 3.6): always as a plain member. The roles the server
 * keeps for the invitation never reach the admission, whatever they say.
 */
describe('Let them in', () => {
    test('passes on none of the roles the server keeps for the invitation', async () => {
        const user = userEvent.setup();
        const sam = {
            userId: SAM,
            name: 'Sam Holm',
            email: 'sam@example.com',
            // Altered by the server: nobody ticked "Let them manage the family".
            roles: ['members', 'billing'],
            acceptedAt: '2026-10-28T00:00:00.000Z',
            identity: { keyVersion: 1 },
            inFamily: false,
        };
        waitingPeople = [sam];
        letInWithoutWords.mockClear();
        render(
            <QueryClientProvider client={new QueryClient()}>
                <PendingList
                    userId={ALICE}
                    groupId="g"
                    family="Holm family"
                    pending={[sam] as never}
                    names={{ [SAM]: 'Sam' }}
                />
            </QueryClientProvider>,
        );
        await user.click(await screen.findByRole('button', { name: 'Let them in' }));
        await waitFor(() => expect(letInWithoutWords).toHaveBeenCalledTimes(1));
        const person = letInWithoutWords.mock.calls[0]![4] as Record<string, unknown>;
        expect(person).toEqual({
            userId: SAM,
            email: 'sam@example.com',
            identity: { keyVersion: 1 },
        });
    });
});
