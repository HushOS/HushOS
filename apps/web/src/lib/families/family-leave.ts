import { MANAGER_FIRST, ORGANIZER_FIRST } from '@/lib/groups/copy';

/*
 * Why this person can't leave the family now, by the rule the server applies
 * (packages/db `blocker` in groups.ts), or null when Leave family can be
 * offered. The family page shows it beside a disabled Leave family rather
 * than offering it and refusing after the confirm. The last one in a family
 * may always leave: that ends it. The server stays the judge (a manager
 * without a seal of the current key doesn't count there, and a payer is
 * refused too); this only says up front what the member list already shows.
 */
export function leaveBlocker(
    userId: string,
    members: readonly { userId: string; state: string; roles: readonly string[] }[],
): string | null {
    const active = members.filter((member) => member.state === 'active');
    const me = active.find((member) => member.userId.toLowerCase() === userId.toLowerCase());
    if (!me) return null;
    const others = active.filter((member) => member !== me);
    if (others.length === 0) return null;
    const holds = (role: string) => others.some((member) => member.roles.includes(role));
    if (me.roles.includes('billing') && !holds('billing')) return ORGANIZER_FIRST;
    if (me.roles.includes('members') && !holds('members')) return MANAGER_FIRST;
    return null;
}

/*
 * Why this person can't be removed, by the write's own rule (packages/db `applyRoster`'s
 * `no-billing`): the family's only `billing` holder, whom the member list then doesn't offer to
 * remove. The server stays the judge, and refuses it before anything ends (a lapsed plan they
 * pay for included).
 */
export function removeBlocker(
    targetId: string,
    who: string,
    members: readonly { userId: string; state: string; roles: readonly string[] }[],
): string | null {
    const active = members.filter((member) => member.state === 'active');
    const target = active.find((member) => member.userId === targetId);
    if (!target?.roles.includes('billing')) return null;
    if (active.some((member) => member !== target && member.roles.includes('billing'))) return null;
    return `${who} is the only one who manages the family’s plan. Make someone else the organizer first.`;
}
