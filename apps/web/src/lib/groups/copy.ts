import { keyChangeWords } from '@/lib/key-change-words';
import { GroupApiError, NO_ANSWER } from './api';
import type { GroupNotice } from './context';
import type { SendOutcome } from './outbox';
import { joinCheckMessage } from '@hushos/crypto/join-session';

/*
 * What the families pages say when the server refuses something, when the
 * outbox gives an outcome other than "landed", and for the data layer's own
 * notices. One sentence or two, in the person's words: no codes, no
 * "roster", no "succession" (DESIGN.md, Content). Names come from the server
 * and are passed in; a family is named, a person by their first name.
 */

export type CopyContext = {
    family?: string;
    /* The person the change was about, by first name. */
    person?: string;
    /* First names by user id, for codes whose data names people (left-due). */
    names?: Record<string, string>;
};

/* Why this person can't leave or step back yet: someone else must hold the role first. */
export const ORGANIZER_FIRST = 'Make someone else the organizer first.';
export const MANAGER_FIRST = 'Let someone else manage the family first.';

const list = (names: string[]) =>
    names.length <= 1
        ? (names[0] ?? 'someone')
        : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

function stringField(data: unknown, key: string) {
    const value =
        data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
    return typeof value === 'string' ? value : null;
}

/* The caller's own family that an `in-family` refusal names, when it names one. */
export function familyField(data: unknown) {
    const family = (data as { family?: unknown } | null)?.family;
    const name = (family as { name?: unknown } | null)?.name;
    const groupId = (family as { groupId?: unknown } | null)?.groupId;
    return typeof name === 'string' && typeof groupId === 'string' ? { groupId, name } : null;
}

/*
 * The join page for someone already in a family (docs/families-shared-pool.md
 * 6.2): one family per account, so they leave theirs first. The invitation
 * keeps its date; it isn't spent by being opened.
 */
export function joinInFamilyCopy(yours: string, invitedTo: string, expiresAt: string) {
    const until = new Date(expiresAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
    });
    return `You’re in ${yours}. To join ${invitedTo}, leave yours first, from its page. This invitation stays open until ${until}.`;
}

/* Create a family, for someone already in one. */
export const createInFamilyCopy = (yours: string) =>
    `You’re in ${yours}. Leave it before you create another.`;

function numberField(data: unknown, key: string) {
    const value = (data as Record<string, unknown> | null)?.[key];
    return typeof value === 'number' ? value : null;
}

/*
 * The departures a 409 left-due names (people who left, or whose account
 * went: removals are finished in their own call), as one state rather than a failure:
 * marking them left rotates every family folder, which the family folder
 * clients do (plan steps 6 and 7), so a change waits until a manager has.
 */
export function leftDueCopy(data: unknown, ctx: CopyContext = {}) {
    const ids = (data as { userIds?: unknown } | null)?.userIds;
    const names = Array.isArray(ids)
        ? ids
              .filter((id): id is string => typeof id === 'string')
              .map((id) => ctx.names?.[id] ?? 'Someone')
        : [];
    const who = list(names.length ? names : ['Someone']);
    return `${who} left the family. A manager needs to finish that before anyone can join or roles change.`;
}

/* A refusal's sentence: a definite 4xx with a code. */
export function refusalCopy(
    /* A GroupErrorCode, or any code a newer server sends. */
    code: string,
    data: unknown,
    ctx: CopyContext = {},
): string {
    const family = ctx.family ?? 'this family';
    const person = ctx.person ?? 'They';
    switch (code) {
        case 'invalid':
            return 'Couldn’t save that change. Reload and try again.';
        case 'succession-due':
            return `A manager of ${family} needs to finish an earlier change first. Reload and try again.`;
        case 'left-due':
            return leftDueCopy(data, ctx);
        case 'members-changed':
            return `The member list of ${family} changed while you were working on it. Try again.`;
        case 'stale':
            return `The member list of ${family} changed while you were working on it. Try again.`;
        // The family's payer leaving or removed while a change to its plan holds the plan's claim.
        case 'busy':
            return 'Another change to this plan is in progress. Try again in a moment.';
        case 'seats': {
            // With billing on, the server says why no place could be had (docs/groups-design.md 3.5).
            switch (stringField(data, 'reason')) {
                case 'no-plan':
                    return `Choose a plan for ${ctx.family ?? 'this family'} before letting anyone in.`;
                case 'payer':
                    return `Every place in the plan for ${family} is taken. Ask the person who pays for it to add a place.`;
                case 'cap':
                    return `The plan for ${family} allows no more members.`;
                case 'canceling':
                    return `The plan for ${family} is set to end, so nobody new can join. Resume it under Billing first.`;
                case 'declined':
                    return 'Your bank declined the charge for another place. Nothing was charged and nobody was let in.';
                case 'confirm':
                    return 'Your bank wants you to confirm the charge for another place. Confirm it, then let them in again.';
                case 'payment':
                    return 'The payment for another place didn’t go through. Nobody was let in.';
                case 'busy':
                    return 'Another change to this plan is in progress. Try again in a moment.';
                case 'changed':
                    return 'The charge went through but the plan changed at the same time. Refresh to see your places.';
            }
            const used = numberField(data, 'used');
            const limit = numberField(data, 'limit');
            return used !== null && limit !== null
                ? `Every place in ${family} is taken (${used} of ${limit}).`
                : `Every place in ${family} is taken.`;
        }
        case 'no-plan':
            // The invitee of a family whose plan lapsed, or a manager inviting or making a folder.
            return data && typeof data === 'object' && (data as { invitee?: unknown }).invitee
                ? `Nobody new can join ${ctx.family ?? 'this family'} right now. Ask whoever invited you; this invitation works again once there’s a plan.`
                : `Choose a plan for ${ctx.family ?? 'this family'} first. Until it has one, nobody can be invited and no family folders can be made.`;
        case 'in-family': {
            // Let them in: the newcomer's other family is never named to this one.
            if (stringField(data, 'reason') === 'newcomer')
                return 'They’ve joined another family since they accepted. They can join yours once they leave it.';
            const yours = familyField(data);
            return yours
                ? createInFamilyCopy(yours.name)
                : 'You’re in a family already. Leave it before you create another.';
        }
        case 'pool-full':
            // No figure: managers learn only that the newcomer's files are more than what's free.
            return 'Their files don’t fit in the family’s free space. Free up space or move to a bigger plan, then let them in.';
        case 'organizer':
            return ORGANIZER_FIRST;
        // The payer of a live plan can't leave or be removed until it is cancelled, under Billing
        // on this page (through the billing portal). Removing them names them; leaving doesn't.
        case 'payer':
            return ctx.person
                ? `${ctx.person} pays for the family’s plan. They can cancel it under Billing on this page; then you can remove them.`
                : `You pay for the family’s plan. Cancel it under Billing on this page first; the family keeps it until the end of the period.`;
        case 'last-holder':
            return MANAGER_FIRST;
        case 'unsupported':
            return 'Update HushOS to do this. Reload the page to get the latest version.';
        case 'forbidden':
            return 'Only someone who manages the family can do that.';
        case 'email-mismatch':
            return 'This invitation is for another email address. Sign in with that one.';
        case 'not-member':
            return 'You’re not in this family any more.';
        case 'not-pending':
            return `${person} isn’t waiting to join any more.`;
        case 'held':
            return 'Another manager paused your changes in this family for now.';
        case 'rotating':
        case 'epoch-stale':
        case 'root-moved':
        case 'document-stale':
            return 'A family folder was changing at the same time. Try again in a moment.';
        case 'root-mid-rotation':
            return 'A family folder is in the middle of a key change this server can’t account for. Contact the server’s operator.';
        case 'not-rotating':
        case 'area-moved':
            return 'A family folder changed meanwhile. Reload and try again.';
        case 'no-seal':
            return 'Another manager needs to open the family before you can change it. Try again later.';
        case 'area-limit': {
            const limit = numberField(data, 'limit');
            return limit !== null
                ? `A family can have at most ${limit} shared folders on this server.`
                : 'This family has as many shared folders as this server allows.';
        }
        case 'group-limit': {
            const limit = numberField(data, 'limit');
            return limit !== null
                ? `You can create at most ${limit} families on this server.`
                : 'You’ve created as many families as this server allows.';
        }
        case 'grants-due':
            return 'Someone in the family is still missing a folder’s keys. Try again in a moment.';
        case 'exists':
            return 'That address already has an open invitation.';
        case 'already-member':
            return 'That person is already in the family.';
        case 'gone':
            return 'This invitation is no longer open. Ask for a new one.';
        case 'too-large':
            return 'That change is too large for this server.';
        case 'rate-limited':
            return 'That’s been tried too often. Wait a little, then try again.';
        case 'unavailable':
            return 'HushOS couldn’t save that just now. Try again in a moment.';
        default:
            return 'Couldn’t save that change. Reload and try again.';
    }
}

/* Any error from the families layer, worded: a coded refusal, no answer at all, or the worker's own sentence. */
export function errorCopy(error: unknown, ctx: CopyContext = {}) {
    if (error instanceof GroupApiError) {
        if (error.status === 0) return NO_ANSWER;
        if (error.status === 401 || error.code === 'signed-out')
            return 'You were signed out. Sign in again, then retry.';
        if (error.code) return refusalCopy(error.code, error.data, ctx);
        if (error.status === 501) return 'Families aren’t available on this server.';
        return 'HushOS couldn’t do that just now. Try again in a moment.';
    }
    // A request the client gave up on (lib/api-client.ts, 30 s), in each browser's words:
    // "signal timed out" (Chromium), "The operation timed out." (Safari, Firefox). A DOMException,
    // which some runtimes don't count as an Error.
    const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
    if (
        name === 'TimeoutError' ||
        (typeof message === 'string' &&
            /^(signal timed out|the operation timed out)/i.test(message))
    )
        return 'HushOS’s server took too long to answer.';
    if (!(error instanceof Error) || !error.message) return 'Something went wrong. Try again.';
    // A request outside the groups client (the worker's, a sync's) that never reached the server
    // fails with the browser's own words, as isNetworkFailure in lib/drive.ts reads them.
    if (/^(failed to fetch|load failed|networkerror\b)/i.test(error.message)) return NO_ANSWER;
    return keyChangeWords(error.message);
}

/*
 * What a roster call's outcome means for the person, or null when it landed.
 * `pending` is kept on this device and sent again: it is said as such, never
 * as a failure that lost the change.
 */
export function outcomeCopy(outcome: SendOutcome, ctx: CopyContext = {}): string | null {
    switch (outcome.status) {
        case 'landed':
            return null;
        case 'stale':
            return refusalCopy('stale', outcome.data, ctx);
        case 'membership-moved':
            return refusalCopy(outcome.code, outcome.data, ctx);
        case 'refused':
            return refusalCopy(outcome.code, outcome.data, ctx);
        case 'pending':
            return 'HushOS couldn’t reach the server. This device keeps the change and sends it when it can.';
        case 'awaiting-check':
            return 'This wasn’t sent. Start again.';
        case 'other-keys':
            return 'This was for keys you no longer have as checked, so it wasn’t sent. Let them in again.';
        case 'wiped':
            return 'You’re not in this family any more.';
    }
}

/* The data layer's notices, worded. Folder names are sealed, so a folder is "a family folder". */
export function noticeCopy(
    notice: GroupNotice,
    family = 'the family',
    person: (userId: string) => string | undefined = () => undefined,
    familyOf: (groupId: string) => string | undefined = () => undefined,
) {
    switch (notice.kind) {
        case 'foreign-listing': {
            // Nothing was trusted, so no alarm. A committed member list needs a manager's signature
            // and an honest server refuses this, so both had a part; no one is named, since which
            // manager it was isn't something this screen can say. The owner's name stays out of the
            // advice, so a forwarded notice says no more than it must about the person's families.
            const them = notice.count === 1 && notice.owner !== null ? 'it' : 'them';
            const what =
                notice.owner === null
                    ? 'your own files, in My files'
                    : `${notice.count === 1 ? 'one' : notice.count} of the folders belonging to ${familyOf(notice.owner) ?? 'another family'}`;
            return [
                `It names ${what}.`,
                `HushOS ignored that, so nothing in ${them} was shared or changed.`,
                `Someone who manages, or managed, ${family} signed it, and the server accepted it.`,
                'A member list keeps everything it names, so this notice stays.',
                `Tell the other members of ${family}.`,
            ].join(' ');
        }
        case 'admission-dropped':
            return `An earlier admission of ${person(notice.userId) ?? 'someone waiting to join'} wasn’t sent; let them in again.`;
        case 'record-reset':
            return `This device’s saved check of ${family} couldn’t be opened, so HushOS checked the family again from the start.`;
        case 'changes-lost':
            return notice.count === 1
                ? `A change to ${family} hadn’t reached the server and couldn’t be opened on this device. Make it again.`
                : `${notice.count} changes to ${family} hadn’t reached the server and couldn’t be opened on this device. Make them again.`;
        case 'documents-cleared':
            return `A family folder’s ${notice.document === 'tags' ? 'tags' : 'settings'} couldn’t be opened while its keys were replaced, and started again empty.`;
    }
}

/* A notice's title, where it has one. */
export function noticeTitle(notice: GroupNotice, family = 'the family') {
    if (notice.kind !== 'foreign-listing') return null;
    // My files isn't a folder, and one family may name both: the titles differ.
    if (notice.owner === null) return `The member list of ${family} names your own files`;
    return notice.count === 1
        ? `The member list of ${family} names a folder that isn’t its own`
        : `The member list of ${family} names folders that aren’t its own`;
}

/*
 * The two hidden words of the join code typed, and not the code's: most
 * likely one misheard, so it is said calmly, and never which one, or a
 * guesser could find them one at a time. The warning that HushOS may be
 * showing a different member list is kept for "They don't match".
 */
/* After the family's first wrong pair: the calm line (the core's join_check_message says the same). */
export function wrongWordsCopy(them: string) {
    return joinCheckMessage(false, them);
}

/* After a wrong pair again: the alarm's first line. */
export function mismatchCopy(them: string) {
    return joinCheckMessage(true, them);
}
