/*
 * The approving device's part that needs no cryptography (docs/two-step-design.md 12), kept
 * apart from device-approval.ts so a page that only counts prompts does not load the word list.
 */

/*
 * The approving device's own limit on prompts (docs/two-step-design.md 12), for each class of
 * request, whatever the server sends, so requests from sign-ins it does not know can never use
 * up the room for the owner's own: ten a day for each class of sign-in, five for step-ups and for a class from a later release. `record` is what the device
 * kept from before (null at first); the answer says which of `requests` to show and what to
 * keep. A request shown once stays shown; one past its class's limit is not, that day.
 */
export const APPROVAL_PROMPTS_A_DAY: Readonly<Record<string, number>> = { unknown: 10, known: 10 };
const OTHER_PROMPTS_A_DAY = 5;
export type PromptRecord = { day: string; seen: Record<string, string[]> };
export function approvalPromptsAllowed(
    record: PromptRecord | null,
    requests: readonly { id: string; class: string }[],
    now: Date = new Date(),
) {
    const day = now.toISOString().slice(0, 10);
    // A map, not an object: a class is any name, `__proto__` and `constructor` included.
    const seen = new Map<string, string[]>(
        record?.day === day && typeof record.seen === 'object' && record.seen !== null
            ? Object.entries(record.seen).map(([name, ids]) => [
                  name,
                  Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [],
              ])
            : [],
    );
    const shown: string[] = [];
    for (const request of requests) {
        let ids = seen.get(request.class);
        if (!ids) seen.set(request.class, (ids = []));
        if (!ids.includes(request.id)) {
            const most = Object.hasOwn(APPROVAL_PROMPTS_A_DAY, request.class)
                ? APPROVAL_PROMPTS_A_DAY[request.class]!
                : OTHER_PROMPTS_A_DAY;
            if (ids.length >= most) continue;
            ids.push(request.id);
        }
        shown.push(request.id);
    }
    return {
        shown,
        record: { day, seen: Object.fromEntries(seen) } satisfies PromptRecord,
    };
}
