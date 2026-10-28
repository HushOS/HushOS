import type { GroupView } from '@hushos/crypto';
import { GroupApiError, isNotMember, lapsedPlansIn, type LapsedPlanNamed } from './api';
import type { GroupContext } from './context';
import { refusalCopy } from './copy';
import { fillGrants, markDepartedLeft, renewHold, stageChange, type StageOutcome } from './outbox';
import { fetchIdentities, syncGroup, type AreaState, type SyncResult } from './sync';

/*
 * Taking someone out of a family, and the work a manager's device does on its
 * own (1c step 7; the plan's section 2 "Remove", "Leave", "Areas" and
 * "Successions"; docs/groups-server.md 3 and 8).
 *
 * A removal goes hold, finish, remove, in that order: the hold (route 27)
 * stops the person's Drive writes, epoch draws and rotation starts in the
 * family's folders, so they can no longer put a node above the drawn target
 * epoch or start a walk the removal must wait on; then any walk already
 * running in a folder is finished; only then is the roster marking them left
 * staged, with every folder rotated, the succession when they managed the
 * family, and the grants, in one call (route 19). The walk of each folder
 * that follows runs in the background (lib/spaces.ts), from the server's
 * state, so it resumes after a reload.
 */

export type RemovalStep = 'demote' | 'hold' | 'finish' | 'remove';

export type RemovalOutcome =
    | { status: 'removed' }
    /*
     * Someone paused this person's changes (route 27 answered held). `heldBy`
     * is who, as route 3's `due.holds` lists it, or null when it does not say:
     * the client names nobody it was not told of. When it is the person being
     * removed and they manage the family too, the way out is to stop them
     * managing first (`demoteFirst`), which ends every hold they placed
     * (groups-server 8, "Equal holders race").
     */
    | { status: 'held'; heldBy: string | null; targetManages: boolean }
    /* They are not an active member any more (left, removed by someone else meanwhile). */
    | { status: 'changed' }
    /* Kept on this device and sent again later: an unknown outcome, or a fix it could not make now. */
    | { status: 'pending'; message: string }
    | { status: 'failed'; message: string }
    /* This person is not in the family any more. */
    | { status: 'wiped' }
    /*
     * They pay for the family's plans that give nothing (asked first, or route 19 answered
     * `ends-lapsed`): those end at once when they are removed, so the removal waits for the
     * remover to confirm them, by id (`endsLapsed`). Nothing was changed: asked before any
     * demotion, hold or walk.
     */
    | { status: 'ends-lapsed'; plans: LapsedPlanNamed[] };

const MAX_REBUILDS = 3;

function manages(view: GroupView | null, userId: string) {
    const entry = view?.members.find((member) => member.userId === userId);
    return Boolean(entry && entry.status === 'active' && entry.roles.includes('members'));
}

/* A stageChange outcome other than landed, as a removal says it. */
function failure(staged: StageOutcome, family: string): RemovalOutcome | null {
    if (staged.status === 'not-synced')
        return staged.sync.status === 'wiped'
            ? { status: 'wiped' }
            : {
                  status: 'failed',
                  message:
                      staged.sync.status === 'fork'
                          ? `${family} looks different on this device.`
                          : `Couldn’t check ${family}. Try again.`,
              };
    if (staged.status !== 'sent') return { status: 'failed', message: 'Nothing was changed.' };
    const { outcome } = staged;
    switch (outcome.status) {
        case 'landed':
            return null;
        case 'pending':
            return {
                status: 'pending',
                // The outbox's reason is a sentence of its own (often the transport's), never spliced in.
                message: `HushOS couldn’t finish this yet. This device keeps the change and sends it the next time you open ${family}.`,
            };
        case 'wiped':
            return { status: 'wiped' };
        case 'membership-moved':
            return outcome.code === 'members-changed'
                ? { status: 'changed' }
                : {
                      status: 'failed',
                      message: refusalCopy(outcome.code, outcome.data, { family }),
                  };
        case 'stale':
            return { status: 'failed', message: refusalCopy('stale', outcome.data, { family }) };
        case 'refused': {
            if (outcome.code === 'ends-lapsed')
                return { status: 'ends-lapsed', plans: lapsedPlansIn(outcome.data) };
            return {
                status: 'failed',
                message: refusalCopy(outcome.code, outcome.data, { family }),
            };
        }
        default:
            return { status: 'failed', message: 'Nothing was changed.' };
    }
}

/*
 * Removes `userId` from the family: hold, finish, remove. `demoteFirst` takes
 * `members` from them before the hold (the equal-holders way out: once they no
 * longer manage the family, every hold they placed ends, and they can no
 * longer rewrite a folder's documents to keep the removal stale).
 */
export async function removeMember(
    ctx: GroupContext,
    groupId: string,
    userId: string,
    options: {
        family?: string;
        demoteFirst?: boolean;
        /* The lapsed plans (ids) this person pays for that the remover confirmed end. */
        endsLapsed?: string[];
        onStep?: (step: RemovalStep) => void;
    } = {},
): Promise<RemovalOutcome> {
    const family = options.family ?? 'The family';
    const rotations = ctx.rotations;
    if (!rotations)
        return { status: 'failed', message: 'Open the family’s folders, then try again.' };
    let synced = await syncGroup(ctx, groupId);
    if (synced.status === 'wiped') return { status: 'wiped' };
    if (synced.status !== 'accepted')
        return { status: 'failed', message: `Couldn’t check ${family}. Try again.` };
    if (!synced.view.members.some((m) => m.userId === userId && m.status === 'active'))
        return { status: 'changed' };

    // Asked first, before anything changes (a demotion, a hold, a walk): the plans they pay for
    // that give nothing, which removing them ends. One not yet confirmed stops here; a plan that
    // can't be ended (a checkout waiting on the bank, one paid again just now) is said as it is.
    let preview: { plans: LapsedPlanNamed[] };
    try {
        preview = await ctx.api.removalPreview(groupId, userId);
    } catch (error) {
        if (isNotMember(error)) {
            await syncGroup(ctx, groupId);
            return { status: 'wiped' };
        }
        if (error instanceof GroupApiError && error.code === 'payer')
            return { status: 'failed', message: error.message };
        throw error;
    }
    const confirmed = new Set(options.endsLapsed ?? []);
    if (preview.plans.some((plan) => !confirmed.has(plan.id)))
        return { status: 'ends-lapsed', plans: preview.plans };

    if (options.demoteFirst && manages(synced.view, userId)) {
        options.onStep?.('demote');
        const entry = synced.view.members.find((member) => member.userId === userId)!;
        const demoted = await stageChange(ctx, groupId, {
            kind: 'roles',
            userId,
            roles: entry.roles.filter((role) => role !== 'members'),
        });
        const stopped = failure(demoted, family);
        if (stopped) return stopped;
        // Read again: the view from before the demotion would still say they manage the family.
        synced = await syncGroup(ctx, groupId);
        if (synced.status === 'wiped') return { status: 'wiped' };
        if (synced.status !== 'accepted')
            return { status: 'failed', message: `Couldn’t check ${family}. Try again.` };
    }

    options.onStep?.('hold');
    try {
        await ctx.api.hold(groupId, userId);
    } catch (error) {
        if (isNotMember(error)) {
            await syncGroup(ctx, groupId);
            return { status: 'wiped' };
        }
        if (error instanceof GroupApiError && error.code === 'held')
            return {
                status: 'held',
                heldBy: await whoHolds(ctx, groupId),
                targetManages: manages(synced.view, userId),
            };
        if (error instanceof GroupApiError && error.code === 'members-changed') {
            await syncGroup(ctx, groupId).catch(() => null);
            return { status: 'changed' };
        }
        throw error;
    }

    /* The hold placed again; a refusal ends the removal with what it means. */
    const holdAgain = async (): Promise<RemovalOutcome | null> => {
        const refused = await renewHold(ctx, groupId, userId);
        if (!refused) return null;
        if (refused.code === 'held')
            return {
                status: 'held',
                heldBy: await whoHolds(ctx, groupId),
                targetManages: synced.status === 'accepted' && manages(synced.view, userId),
            };
        if (refused.code === 'members-changed') return { status: 'changed' };
        return {
            status: 'failed',
            message: refusalCopy(refused.code ?? '', refused.data, { family }),
        };
    };

    // Finish: a walk running in a folder would make the removal answer `rotating`, and one that
    // re-keyed anything cannot be taken over (groups-server 8). Said as a step only when a walk
    // was running: otherwise nothing was finished.
    synced = await syncGroup(ctx, groupId);
    if (synced.status === 'wiped') return { status: 'wiped' };
    if (synced.status !== 'accepted')
        return { status: 'failed', message: `Couldn’t check ${family}. Try again.` };
    let finishing = false;
    for (const area of synced.areas) {
        const running = area.view.rotation;
        if (!running) continue;
        if (!finishing) options.onStep?.('finish');
        finishing = true;
        // Placed again before each folder's walk: walks of large folders add up past 15 minutes.
        const lapsed = await holdAgain();
        if (lapsed) return lapsed;
        // The walk keeps every writer's record re-keyed, the person being removed included:
        // their records never come back as the walker's, whatever the committed chain says.
        await rotations.finish(groupId, {
            workspaceId: area.workspaceId,
            rotationId: running.id,
            nodeId: running.nodeId,
            targetEpoch: running.targetEpoch,
        });
    }

    options.onStep?.('remove');
    for (let attempt = 0; attempt < MAX_REBUILDS; attempt++) {
        const areas = Object.keys(synced.view.areas).map((workspaceId) => ({
            workspaceId,
            kinds: [],
        }));
        // The hold placed again right before the folders are read: a long finish (or a rebuild
        // round) must not let it lapse while the target epochs are drawn.
        const lapsed = await holdAgain();
        if (lapsed) return lapsed;
        const staged = await stageChange(
            ctx,
            groupId,
            {
                kind: 'remove',
                userId,
                rotations: await rotations.read(groupId, areas),
                ...(options.endsLapsed?.length ? { endsLapsed: options.endsLapsed } : {}),
            },
            {
                writers: await rotations.writers(groupId),
                // The server answered `rotating`: a walk that started meanwhile is finished first.
                walking: (running) => options.onStep?.(running ? 'finish' : 'remove'),
            },
        );
        if (staged.status === 'sent' && staged.outcome.status === 'membership-moved') {
            if (staged.outcome.code === 'left-due') {
                const departed = leftDue(staged.outcome.data);
                // Marked left first (with every folder rotated), then the removal again; if they
                // left themselves meanwhile, marking them left is the whole removal.
                const marked = await markDepartedLeft(ctx, groupId, departed);
                if (marked.status !== 'sent' || marked.outcome.status !== 'landed') {
                    const stopped = failure(marked as StageOutcome, family);
                    return stopped ?? { status: 'failed', message: 'Nothing was changed.' };
                }
                if (departed.includes(userId)) return { status: 'removed' };
            } else return { status: 'changed' };
        } else if (staged.status === 'sent' && staged.outcome.status === 'stale') {
            // Another manager's change landed first: built again on top of it.
        } else {
            const stopped = failure(staged, family);
            return stopped ?? { status: 'removed' };
        }
        const again = await syncGroup(ctx, groupId);
        if (again.status !== 'accepted')
            return failure({ status: 'not-synced', sync: again }, family)!;
        synced = again;
        if (!synced.view.members.some((m) => m.userId === userId && m.status === 'active'))
            return { status: 'removed' };
    }
    return { status: 'failed', message: `${family} kept changing. Try again in a moment.` };
}

/* Who holds this person, from route 3's `due.holds` (listed to every holder); null when unknown. */
async function whoHolds(ctx: GroupContext, groupId: string) {
    try {
        const holds = (await ctx.api.group(groupId)).due?.holds ?? [];
        const mine = holds.filter((hold) => hold.userId === ctx.userId);
        return mine.length === 1 ? (mine[0]!.heldBy ?? null) : null;
    } catch {
        return null;
    }
}

function leftDue(data: unknown) {
    const ids = (data as { userIds?: unknown } | null)?.userIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/*
 * "Replace keys" on a family folder (route 24): a new key for the folder on
 * the member list, its top folder re-keyed and its documents sealed again in
 * the same call, then walked in the background like a removal's.
 */
export async function replaceKeys(ctx: GroupContext, groupId: string, workspaceId: string) {
    const rotations = ctx.rotations;
    if (!rotations) throw new Error('Open the family’s folders, then try again.');
    const [rotation] = await rotations.read(groupId, [{ workspaceId, kinds: [] }]);
    return stageChange(
        ctx,
        groupId,
        { kind: 'rotate', rotation: rotation! },
        { writers: await rotations.writers(groupId) },
    );
}

/*
 * Folds in members whose served identity moved on from their entry (route 3's
 * `due.foldIn`), each followed through their signed succession links, then
 * seals the family key to those who manage the family under their new keys
 * (route 9). One's own fold-in is signed with the keys the old entry names
 * (the worker opens them from the history envelopes for that roster only).
 * Members no chain reaches come back in `needsCheck`: their words need
 * comparing again.
 */
export async function foldIn(ctx: GroupContext, groupId: string, userIds: readonly string[]) {
    const identities = await fetchIdentities(ctx, groupId);
    const members = userIds.flatMap((userId) => {
        const member = identities.get(userId);
        return member?.identity ? [{ userId, served: member.identity, links: member.links }] : [];
    });
    if (members.length === 0) return { needsCheck: [] as string[], landed: false };
    const history = members.some((member) => member.userId === ctx.userId)
        ? (await ctx.identities()).history
        : undefined;
    const staged = await stageChange(ctx, groupId, {
        kind: 'foldIn',
        members,
        ...(history ? { history } : {}),
    });
    if (staged.status === 'nothing') return { needsCheck: staged.needsCheck, landed: false };
    if (staged.status !== 'sent' || staged.outcome.status !== 'landed')
        return { needsCheck: staged.status === 'sent' ? staged.needsCheck : [], landed: false };
    await resealFolded(ctx, groupId, staged.outcome.sync, members, identities);
    return { needsCheck: staged.needsCheck, landed: true };
}

/*
 * After a fold-in landed: the family key sealed again (route 9) to those of
 * `members` who still manage the family on the roster it made, under their
 * new keys. A manager let back in on a Continue over keys nobody checked has
 * lost the role on that roster (the worker's foldIn), so is sealed nothing.
 */
export async function resealFolded(
    ctx: GroupContext,
    groupId: string,
    sync: SyncResult | null,
    members: readonly { userId: string }[],
    identities: Awaited<ReturnType<typeof fetchIdentities>>,
) {
    const holders =
        sync?.status === 'accepted'
            ? sync.view.members.filter(
                  (entry) =>
                      entry.status === 'active' &&
                      entry.roles.includes('members') &&
                      entry.userId !== ctx.userId &&
                      members.some((member) => member.userId === entry.userId),
              )
            : [];
    if (holders.length === 0) return;
    const { seals } = await ctx.rpc('groupReseal', {
        groupId,
        holders: holders.map((holder) => ({
            userId: holder.userId,
            kemPublicKey: identities.get(holder.userId)!.identity!.kemPublicKey,
        })),
    });
    await ctx.api.putKeySeals(groupId, seals);
}

/*
 * A family folder whose previous top-folder key (option A) does not open
 * with its current key, while its walk runs: a manager whose device held the
 * old key puts one that opens (route 28), so a member given only the new key
 * reads the part the walk has not reached.
 */
export async function repairPreviousRoots(
    ctx: GroupContext,
    groupId: string,
    areas: readonly AreaState[],
) {
    let repaired = 0;
    for (const area of areas) {
        const { rotation, root } = area.view;
        if (!rotation || !root?.prevKeyEnvelope) continue;
        const checked = await ctx.rpc('groupPreviousRoot', {
            groupId,
            workspaceId: area.workspaceId,
            root: {
                id: root.id,
                parentKeyEpoch: root.parentKeyEpoch,
                prevKeyEnvelope: root.prevKeyEnvelope,
                prevKeyEpoch: root.prevKeyEpoch,
                prevParentKeyEpoch: root.prevParentKeyEpoch,
            },
        });
        if (checked.status !== 'repair') continue;
        await ctx.api.putPreviousRoot(groupId, area.workspaceId, {
            rotationId: rotation.id,
            previousRootKeyEnvelope: checked.previousRootKeyEnvelope,
        });
        repaired++;
    }
    return repaired;
}

export type DueReport = {
    /* Members whose words need comparing again before their new keys are taken. */
    needsCheck: string[];
    /* What was done quietly, for tests and the family page. */
    done: ('grants' | 'mark-left' | 'fold-in' | 'rotations' | 'repair')[];
};

/*
 * What route 3 says is due, done quietly (the plan, section 2): grants any
 * member can fill; and for those who manage the family, departures marked
 * left (every folder rotated, with the succession when the person managed
 * the family: route 7), fold-ins, folders whose keys are owed a change (a
 * share or link stopped there), and a previous top-folder key to repair.
 * Each step reads route 3 again, since the one before may have cleared it.
 */
export async function runDue(
    ctx: GroupContext,
    groupId: string,
    options: { manager: boolean; areas: readonly AreaState[] },
): Promise<DueReport> {
    const report: DueReport = { needsCheck: [], done: [] };
    let due = (await ctx.api.group(groupId)).due;
    if (!due) return report;
    if (due.grants.length > 0) {
        await ctx.lock(groupId, () => fillGrants(ctx, groupId, { missing: due!.grants }));
        report.done.push('grants');
    }
    if (!options.manager) return report;
    if (due.markLeft && due.markLeft.length > 0) {
        const marked = await markDepartedLeft(ctx, groupId, due.markLeft);
        if (marked.status === 'sent' && marked.outcome.status === 'landed')
            report.done.push('mark-left');
        due = (await ctx.api.group(groupId)).due ?? due;
    }
    if (due.foldIn && due.foldIn.length > 0) {
        const folded = await foldIn(ctx, groupId, due.foldIn);
        report.needsCheck = folded.needsCheck;
        if (folded.landed) report.done.push('fold-in');
        due = (await ctx.api.group(groupId)).due ?? due;
    }
    for (const workspaceId of due.rotations ?? []) {
        const staged = await replaceKeys(ctx, groupId, workspaceId);
        if (staged.status === 'sent' && staged.outcome.status === 'landed')
            report.done.push('rotations');
    }
    if ((await repairPreviousRoots(ctx, groupId, options.areas)) > 0) report.done.push('repair');
    return report;
}
