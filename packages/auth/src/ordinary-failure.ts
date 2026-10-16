import { GROUP_OPERATIONS } from '@hushos/crypto/protocol';

/*
 * Worker operations whose failure leaves the session as it was: Drive's, and
 * exactly the family operations the worker lists (GROUP_OPERATIONS, checked
 * against session-groups.ts's requests; identityConsent among them), whose
 * refusals drop only that family's state. A server that serves a member list
 * which does not hold must not be able to lock the account on every sync, and
 * an account operation that merely starts with "group" must still reset.
 * Shared by the worker (which otherwise resets) and the client (which
 * otherwise locks).
 */
const FAMILY: ReadonlySet<string> = new Set(GROUP_OPERATIONS);
export function ordinaryFailure(operation: string) {
    return operation.startsWith('drive') || FAMILY.has(operation);
}
