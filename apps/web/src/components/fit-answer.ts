import { formatMoney } from '@/lib/format';

/*
 * The pricing planner's answer, apart from its screen: which plan a total fits, for how many
 * people, and what lies past the biggest plan. One person is offered personal plans only, two or
 * more family plans only: a family plan is never sold to one person, and a personal plan never
 * holds a family. A plan fits with a tenth to spare, because versions, Trash and thumbnails count
 * too; within the plan but past that it is tight.
 */

export const HEADROOM = 0.9;

export type Sized = {
    key: string;
    quotaBytes: number;
    /* A family plan's most members; a plan smaller than the family asked for is skipped. */
    maxMembers?: number;
};

export type FitAnswer<P extends Sized> =
    | { kind: 'empty' }
    | { kind: 'fits'; plan: P }
    | { kind: 'tight'; plan: P }
    /*
     * More than the biggest plan holds (`largest`, null when none takes this many people): sales
     * where the server names a contact, otherwise running HushOS on your own server.
     */
    | { kind: 'beyond'; largest: P | null; reach: 'contact' | 'self-host' };

export function fitAnswer<P extends Sized>({
    personal,
    family,
    people,
    total,
    contact,
}: {
    personal: readonly P[];
    family: readonly P[];
    people: number;
    total: number;
    contact: boolean;
}): FitAnswer<P> {
    if (total <= 0) return { kind: 'empty' };
    const offered =
        people > 1 ? family.filter((plan) => (plan.maxMembers ?? Infinity) >= people) : personal;
    const sorted = [...offered].sort((a, b) => a.quotaBytes - b.quotaBytes);
    const fits = sorted.find((plan) => total <= plan.quotaBytes * HEADROOM);
    if (fits) return { kind: 'fits', plan: fits };
    const tight = sorted.find((plan) => total <= plan.quotaBytes);
    if (tight) return { kind: 'tight', plan: tight };
    return {
        kind: 'beyond',
        largest: sorted.at(-1) ?? null,
        reach: contact ? 'contact' : 'self-host',
    };
}

/* A family plan's price for one billing period, in minor units of `currency`. */
export type FamilyPrice = {
    base: number;
    perMember: number;
    currency: string;
    includedMembers: number;
    interval: 'month' | 'year';
};

/* What a family of `people` pays a period: the base, plus each member past those included. */
export function familyCost(
    price: Pick<FamilyPrice, 'base' | 'perMember' | 'includedMembers'>,
    people: number,
) {
    return price.base + Math.max(0, people - price.includedMembers) * price.perMember;
}

/*
 * The planner's note beside a family plan's button: "$26 a month for 8 people: 4 included, then
 * $1.50 a month each.", or "$20 a month, 4 included." when nobody is past those included. A yearly
 * plan says its yearly total ("$207 a year …"), as the cards say what a year is billed.
 */
export function familyNote(price: FamilyPrice, people: number) {
    const money = (minor: number) => formatMoney(minor, price.currency);
    const per = price.interval === 'year' ? 'a year' : 'a month';
    const included = price.includedMembers;
    return people > included
        ? `${money(familyCost(price, people))} ${per} for ${people} people: ${included} included, then ${money(price.perMember)} ${per} each.`
        : `${money(price.base)} ${per}, ${included} included.`;
}
