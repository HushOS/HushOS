import type { ApprovalPrompt } from '@hushos/auth/client';
import { approvalPromptsAllowed, type PromptRecord } from '@hushos/crypto/approval-prompts';
import { queryOptions } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';

/*
 * Approving on another device, in the web app (docs/two-step-design.md 12): the requests this
 * browser may answer, and the words its prompt says. The phones say the same words
 * (`approval_asks` in crates/hushos-core/src/two_step.rs).
 */

const WHAT: Record<string, string> = {
    login: 'Sign-in',
    password: 'Change your password',
    'master-key': 'Rotate your account key',
    'recovery-key': 'Make a new recovery phrase',
    delete: 'Delete your account',
    'two-step': 'Change two-step sign-in',
    'device-approval': 'Turn on Approve on another device',
};

/*
 * What is asked, by which device and roughly from where: "Change your password on Maya’s
 * Laptop", "Sign-in on a new device calling itself “Chrome on Windows”, near Lyon, France".
 * - `selfNamed`: the name is the asking device's own words, not the account's record of one
 *   of its devices. The prompt says so, so nobody reads a stranger's words as their own laptop.
 * - A device that gave no name is "a new device".
 * - A purpose from a later release is "A change to your account".
 * - The place is there only where the server was told one.
 */
export function approvalAsks(asked: {
    purpose: string;
    device: { name: string | null };
    selfNamed: boolean;
    location?: string | null;
}) {
    const name = asked.device.name?.trim();
    const device = !name
        ? 'a new device'
        : asked.selfNamed
          ? `a new device calling itself “${name}”`
          : name;
    const asks = `${WHAT[asked.purpose] ?? 'A change to your account'} on ${device}`;
    return asked.location?.trim() ? `${asks}, ${asked.location.trim()}` : asks;
}

/*
 * This browser's own count of the prompts it has shown today, by class: at most five a day for
 * each, whatever the server lists, so requests from sign-ins nobody knows can never use up the
 * room for the owner's own. Kept per browser; storage that cannot be read counts as empty.
 */
const PROMPTS_KEY = 'hushos-approval-prompts';
function withinBudget(listed: ApprovalPrompt[]) {
    // Nothing listed is nothing to count: the record is the signed-in account's, and a list
    // that came back for an account since signed out of is empty by now (`authClient.approvals`),
    // so it writes nothing into what sign-out just cleared.
    if (listed.length === 0) return [];
    let record: PromptRecord | null = null;
    try {
        record = JSON.parse(localStorage.getItem(PROMPTS_KEY) ?? 'null') as PromptRecord | null;
    } catch {
        // Unreadable: start the day again rather than show nothing.
    }
    const allowed = approvalPromptsAllowed(record, listed);
    try {
        localStorage.setItem(PROMPTS_KEY, JSON.stringify(allowed.record));
    } catch {
        // A private window: the count lasts as long as the page.
    }
    const shown = new Set(allowed.shown);
    return listed.filter((prompt) => shown.has(prompt.id));
}

/* The requests this browser may answer now, within its own daily limit. */
export const approvalsQueryOptions = queryOptions({
    queryKey: ['account', 'approvals'],
    queryFn: async () => withinBudget(await authClient.approvals()),
    staleTime: 0,
    retry: false,
});
