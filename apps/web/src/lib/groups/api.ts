import type { CreateGroupBody, RosterCallBody, WorkspaceKeyEnvelope } from '@hushos/crypto';
import type { GroupErrorCode } from '@hushos/groups/protocol';
import { apiClient } from '@/lib/api-client';

/*
 * The group routes (docs/groups-server.md 4, routes 1 to 29), typed from the
 * server through Eden. Every answer that is not a
 * success becomes a GroupApiError carrying what the outbox decides on: the
 * HTTP status, the refusal's code and its data. A request that never got an
 * answer (a dropped connection, the 30-second timeout) is status 0 with no
 * code: an unknown outcome, never a refusal.
 */

export class GroupApiError extends Error {
    constructor(
        message: string,
        /* 0 when no answer came back. */
        readonly status: number,
        /* The refusal's code, when the server gave one. */
        readonly code: GroupErrorCode | 'signed-out' | null,
        readonly data: unknown,
    ) {
        super(message);
        this.name = 'GroupApiError';
    }
}

/*
 * A definite refusal (docs/groups-design.md 2.4, "Staged chains"): a 4xx
 * carrying a code. Anything else (a 5xx, a 4xx without a code, no answer at
 * all) leaves the outcome unknown. Two coded 4xx are not refusals of the bytes
 * either: a 401 says the session ended, and a 429 `rate-limited` says to send
 * the same bytes later (groups-server 6).
 */
export function isRefusal(error: unknown): error is GroupApiError & { code: GroupErrorCode } {
    return (
        error instanceof GroupApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.code !== null &&
        error.code !== 'signed-out' &&
        error.code !== 'rate-limited'
    );
}

/* The only answer a client may wipe a group on: 404 with the code `not-member` (groups-server 0.9). */
export function isNotMember(error: unknown) {
    return error instanceof GroupApiError && error.status === 404 && error.code === 'not-member';
}

/* The same sentence errorCopy gives for status 0 (DESIGN.md, Errors). */
export const NO_ANSWER = 'Couldn’t reach HushOS. Check your connection, then retry.';

async function answer<
    R extends { data: unknown; error: unknown; status: number; response?: unknown },
>(pending: Promise<R>): Promise<NonNullable<R['data']>> {
    let settled: R;
    try {
        settled = await pending;
    } catch {
        throw new GroupApiError(NO_ANSWER, 0, null, null);
    }
    const { data, error, status, response } = settled;
    // Eden turns a fetch that threw (offline, the timeout) into a 503 with no response: no answer.
    // This relies on @elysia/eden 2.0.0-beta.5's thrown-fetch path; check it when Eden is upgraded.
    if (error && response === undefined) throw new GroupApiError(NO_ANSWER, 0, null, null);
    if (error) {
        const value = (error as { value?: unknown }).value;
        const body =
            value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
        throw new GroupApiError(
            typeof body?.message === 'string' ? body.message : 'Please try again.',
            status,
            typeof body?.code === 'string' ? (body.code as GroupErrorCode) : null,
            body?.data ?? null,
        );
    }
    return data as NonNullable<R['data']>;
}

/* What every roster route answers: the new head, and whether it was already stored. */
export type ChainHead = {
    version: number;
    digest: string;
    revision: number;
    groupKeyVersion: number;
    replayed: boolean;
};

/*
 * Bodies go through as the worker built them: the crypto package's wire
 * types are the routes' own shapes (session-groups.ts), and the server checks
 * every field again.
 */
type Body = never;
const body = (value: CreateGroupBody | RosterCallBody | object) => value as Body;

export function createGroupsApi(client = () => apiClient()) {
    const groups = (id: string) => client().groups({ id });
    return {
        /* 1 */
        createGroup: (input: CreateGroupBody) => answer(client().groups.post(body(input))),
        /* 2 */
        listGroups: () => answer(client().groups.get()),
        /* 3 */
        group: (groupId: string) => answer(groups(groupId).get()),
        /* 4 */
        rename: (groupId: string, name: string) => answer(groups(groupId).patch({ name })),
        /* 5 */
        rosters: (groupId: string, after: number) =>
            answer(groups(groupId).rosters.get({ query: after > 0 ? { after } : {} })),
        /* 6 */
        identities: (groupId: string, after: string | null) =>
            answer(groups(groupId).identities.get({ query: after ? { after } : {} })),
        /* 7 */
        postRoster: (groupId: string, call: RosterCallBody) =>
            answer(groups(groupId).rosters.post(body(call))) as Promise<ChainHead>,
        /* 8 */
        keySeal: (groupId: string) => answer(groups(groupId)['key-seal'].get()),
        /* 9 */
        putKeySeals: (groupId: string, seals: RosterCallBody['seals'] & object) =>
            answer(groups(groupId)['key-seals'].put(body({ seals }))),
        /* 10 */
        postSuccession: (
            groupId: string,
            call: Required<Pick<RosterCallBody, 'succession' | 'seals'>> & {
                expectedRevision: number;
            },
        ) => answer(groups(groupId)['key-successions'].post(body(call))),
        /* 11 */
        invite: (groupId: string, email: string, roles: ('billing' | 'guardian' | 'members')[]) =>
            answer(groups(groupId).invitations.post({ email, roles })),
        /* 12 */
        invitations: (groupId: string) => answer(groups(groupId).invitations.get()),
        /* 13 */
        revokeInvitation: (groupId: string, invitationId: string) =>
            answer(groups(groupId).invitations({ invitationId }).delete({})),
        /* 14b: open invitations to this account's address (accepted from the emailed link) */
        myInvitations: () => answer(client().invitations.get()),
        /* 14 */
        openInvitation: (token: string) => answer(client().invitations.open.post({ token })),
        /* 15 */
        acceptInvitation: (token: string) => answer(client().invitations.accept.post({ token })),
        /* 16 */
        pending: (groupId: string) => answer(groups(groupId).pending.get()),
        /* 17 */
        admit: (groupId: string, userId: string, call: RosterCallBody) =>
            answer(
                groups(groupId).members({ userId }).admit.post(body(call)),
            ) as Promise<ChainHead>,
        /* 18 */
        patchMember: (groupId: string, userId: string, call: RosterCallBody) =>
            answer(groups(groupId).members({ userId }).patch(body(call))) as Promise<ChainHead>,
        /* 19 */
        removeMember: (
            groupId: string,
            userId: string,
            call: RosterCallBody & { endsLapsed?: string[] },
        ) =>
            answer(
                groups(groupId).members({ userId }).remove.post(body(call)),
            ) as Promise<ChainHead>,
        /* 19, asked first: the plans the person pays for that give nothing, which removing them ends. */
        removalPreview: (groupId: string, userId: string) =>
            answer(groups(groupId).members({ userId })['remove-preview'].post({})) as Promise<{
                plans: LapsedPlanNamed[];
            }>,
        /* 20 */
        leave: (groupId: string, confirm: { endsLapsed?: string[] } = {}) =>
            answer(groups(groupId).leave.post(confirm)),
        /* 21 */
        createArea: (groupId: string, call: RosterCallBody) =>
            answer(groups(groupId).areas.post(body(call))) as unknown as Promise<ChainHead>,
        /* 22 */
        postGrants: (
            groupId: string,
            workspaceId: string,
            grants: NonNullable<RosterCallBody['grants']>,
        ) => answer(groups(groupId).areas({ workspaceId }).grants.post(body({ grants }))),
        /* 23 */
        putSelfGrant: (groupId: string, workspaceId: string, grant: WorkspaceKeyEnvelope) =>
            answer(groups(groupId).areas({ workspaceId })['self-grant'].put(body({ grant }))),
        /* 24 */
        rotateArea: (groupId: string, workspaceId: string, call: RosterCallBody) =>
            answer(
                groups(groupId).areas({ workspaceId }).rotations.post(body(call)),
            ) as Promise<ChainHead>,
        /* Deleting a family folder: its tombstone on the roster (groups design 2.10). */
        deleteArea: (groupId: string, workspaceId: string, call: RosterCallBody) =>
            answer(
                groups(groupId).areas({ workspaceId }).delete.post(body(call)),
            ) as Promise<ChainHead>,
        /* 25 */
        spaces: () => answer(client().drive.spaces.get()),
        /* 26 */
        decline: (groupId: string, userId: string) =>
            answer(groups(groupId).members({ userId }).decline.post({})),
        /* 27 */
        hold: (groupId: string, userId: string) =>
            answer(groups(groupId).members({ userId }).hold.post({})),
        /* 28 */
        putPreviousRoot: (
            groupId: string,
            workspaceId: string,
            input: { rotationId: string; previousRootKeyEnvelope: string },
        ) => answer(groups(groupId).areas({ workspaceId })['previous-root'].put(input)),
        /* 29 */
        areaRoot: (groupId: string, workspaceId: string) =>
            answer(groups(groupId).areas({ workspaceId }).root.get()),
    };
}

export type GroupsApi = ReturnType<typeof createGroupsApi>;

/* A plan someone pays for that gives nothing, as `ends-lapsed` and the removal preview name it. */
export type LapsedPlanNamed = { id: string; name: string; standing: 'payment-failed' | 'paused' };

/* The plans an `ends-lapsed` refusal names, kept only as far as they are well formed. */
export function lapsedPlansIn(data: unknown): LapsedPlanNamed[] {
    const plans = (data as { plans?: unknown } | null)?.plans;
    if (!Array.isArray(plans)) return [];
    return plans.flatMap((plan) => {
        const { id, name, standing } = (plan ?? {}) as Record<string, unknown>;
        return typeof id === 'string' && typeof name === 'string'
            ? [
                  {
                      id,
                      name,
                      standing:
                          standing === 'paused' ? ('paused' as const) : ('payment-failed' as const),
                  },
              ]
            : [];
    });
}

export const groupsApi: GroupsApi = createGroupsApi();

export type ServedRosterPage = Awaited<ReturnType<GroupsApi['rosters']>>;
export type GroupDetail = Awaited<ReturnType<GroupsApi['group']>>;
export type GroupSummary = Awaited<ReturnType<GroupsApi['listGroups']>>['groups'][number];
export type MemberIdentity = Awaited<ReturnType<GroupsApi['identities']>>['identities'][number];
export type SpaceList = Awaited<ReturnType<GroupsApi['spaces']>>['spaces'];
