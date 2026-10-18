import { familyPrice, formatPrice, type FamilyOffer } from '@/lib/plans';

/* The pricing page's questions: the visible FAQ and the FAQPage markup in its head. */
export type Question = { q: string; a: string };

const paidPlans: Question = {
    q: 'What do paid plans add?',
    a: 'Storage, and nothing else. Every plan protects your files the same way: your password never leaves your device and your keys are made on it. Paying only buys more room.',
};

const selfHosting: Question = {
    q: 'Is running it myself free?',
    a: 'Yes. HushOS is open source under the AGPL-3.0. Run your own copy with Docker Compose and give everyone as much space as you like. These plans are only for the service we run.',
};

const middle: Question[] = [
    {
        q: 'Who bills me?',
        a: 'Polar, our merchant of record. Polar takes the payment, works out sales tax or VAT for your country at checkout, and sends the invoices. Your card details never reach HushOS.',
    },
    {
        q: 'What happens when I cancel?',
        a: 'Your plan stays until the end of the time you paid for, and you can change your mind before then. After that you are back on Free. Nothing is deleted; uploads pause until you are under your space again.',
    },
    {
        q: 'Can I switch between monthly and yearly?',
        a: 'Yes. Choose the one you want and the difference is charged, or credited, to your saved card straight away. Paying yearly gets you more than two months free.',
    },
];

/* "Family Plus has 800 GB, Family Pro 2 TB and Family Max 4 TB". */
function poolsLine(family: readonly FamilyOffer[]) {
    const parts = family.map((offer, index) =>
        index === 0 ? `${offer.name} has ${offer.storage}` : `${offer.name} ${offer.storage}`,
    );
    return parts.length > 1
        ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
        : (parts[0] ?? '');
}

/*
 * The questions, with the family ones only where the page offers a family
 * plan, so neither the FAQ nor its markup in the head answers for a hidden
 * section. The figures come from the tiers shown, in the page's currency: the
 * members included and the most a family can have are the same on every tier,
 * as is the price of a member after that.
 */
export function faqFor(family: readonly FamilyOffer[], currency = 'usd'): Question[] {
    const first = family[0];
    if (!first) return [paidPlans, ...middle, selfHosting];
    const { includedMembers, maxMembers } = first.plan;
    const price = familyPrice(first.plan, currency);
    const perMonth = first.plan.interval === 'month';
    const extra = price
        ? ` Each member after that is ${formatPrice(price.perMember, price.currency)} ${perMonth ? 'a month' : 'a year'}, up to ${maxMembers}.`
        : ` A family can have up to ${maxMembers} members.`;
    return [
        {
            q: paidPlans.q,
            a: `On a personal plan, more storage. On a family plan, family folders with storage for its members to share. Every plan protects your files the same way: your password never leaves your device and your keys are made on it.`,
        },
        ...middle,
        {
            q: 'What is a family plan?',
            a: `One plan with ${includedMembers} members included.${extra} It gives family folders that every member can open, end-to-end encrypted. ${poolsLine(family)}; that storage is for family folders, and each member’s own files stay on their own plan, Free included. Family folders are on the web for now.`,
        },
        {
            q: 'Can a family change plans?',
            a: 'Yes. The member who pays moves the family to a bigger plan straight away, and pays the difference for the rest of the period. A smaller plan starts at the next renewal, once the family folders fit in it; nothing is refunded. Members and places stay as they are.',
        },
        {
            q: 'Who pays for a family plan?',
            a: 'The member who chooses the plan pays for it, through Polar, and is the one who changes the plan or adds and removes places. Every other member needs only a HushOS account, and Free is enough.',
        },
        {
            q: 'What happens if a member leaves or is removed?',
            a: 'They lose the family folders straight away, and their own files stay theirs. When a member is removed, the device of whoever removed them replaces the family folders’ keys at once. When a member leaves, the keys are replaced the next time someone who manages the family opens it. The member who pays for a live plan has to cancel it before they can leave.',
        },
        {
            q: 'What happens when a family plan is cancelled?',
            a: 'The member who pays cancels it in the billing portal, from the family’s page. The plan stays until the end of the time paid for. After that, nobody can upload to the family folders, and nobody new can join, until someone chooses a plan again. Nothing is deleted.',
        },
        selfHosting,
    ];
}
