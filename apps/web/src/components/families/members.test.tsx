import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GroupView } from '@hushos/crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FamilyMember } from '@/lib/families';
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

vi.mock('@/components/drive/contact-flow', () => ({
    ContactFlowDialog: ({
        start,
        onResolved,
    }: {
        start: { person: { name: string } } | null;
        onResolved?: () => void;
    }) =>
        start ? (
            <dialog open aria-label={`Their words: ${start.person.name}`}>
                <button
                    onClick={() => {
                        matched = true;
                        onResolved?.();
                    }}
                >
                    They match
                </button>
            </dialog>
        ) : null,
}));
vi.mock('./family-check', () => ({
    FamilyCheckDialog: ({ onCheckWords }: { onCheckWords: () => void }) => (
        <dialog open aria-label="Family check">
            <button onClick={onCheckWords}>Check Sam’s words</button>
        </dialog>
    ),
}));
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
        queryFn: async () => ({ settings: { version: 2, contacts: {} } }),
    }),
}));
vi.mock('@/lib/families', () => ({
    afterFamilyChange: vi.fn(async () => {}),
    afterMembershipChange: vi.fn(async () => {}),
    familiesQueryOptions: vi.fn(),
    pendingQueryOptions: vi.fn(),
    familyContext: () => ({}),
    familyKeys: { family: (userId: string, groupId: string) => ['family', userId, groupId] },
    firstName: (name: string) => name.split(' ')[0],
    rolesLine: () => '',
    withRole: (roles: string[], role: string, on: boolean) =>
        ['billing', 'guardian', 'members'].filter((at) => (at === role ? on : roles.includes(at))),
}));
vi.mock('@/lib/family-leave', () => ({ removeBlocker: () => null }));
vi.mock('@/lib/family-trust', () => ({
    continueMembers: (...args: unknown[]) => continueMembers(...args),
    letInWithoutWords: vi.fn(),
    memberStandings: async () =>
        new Map([
            [SAM, matched ? 'verified' : 'not-verified'],
            [ANA, 'not-verified'],
        ]),
    needsCheckFor: (roles: string[], next: string[]) =>
        (next.includes('members') && !roles.includes('members')) ||
        (next.includes('billing') && !roles.includes('billing')),
}));
vi.mock('@/lib/groups/api', () => ({ GroupApiError: class extends Error {}, groupsApi: {} }));
vi.mock('@/lib/groups/outbox', () => ({
    dropKeptAdmission: vi.fn(),
    stageChange: (...args: unknown[]) => stageChange(...args),
}));
vi.mock('@/lib/groups/copy', async (original) => ({
    ...(await original<typeof Copy>()),
    errorCopy: (cause: Error) => cause.message,
    outcomeCopy: () => null,
}));
const { ChangedMembers, MemberList } = await import('./members');

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
