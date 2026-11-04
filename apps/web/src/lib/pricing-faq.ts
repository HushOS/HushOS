import { formatMoney } from '@/lib/format';
import { familyPrice, type FamilyOffer } from '@/lib/plans';

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

const middle = (twoMonths: boolean): Question[] => [
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
        a: `Yes. Choose the one you want and the difference is charged, or credited, to your saved card straight away.${twoMonths ? ' Paying yearly gets you two months free.' : ''}`,
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
export function faqFor(
    family: readonly FamilyOffer[],
    currency = 'usd',
    // Whether "two months free" is true of this catalogue (twoMonthsFree); said only then.
    twoMonths = true,
): Question[] {
    const first = family[0];
    if (!first) return [paidPlans, ...middle(twoMonths), selfHosting];
    const { includedMembers, maxMembers } = first.plan;
    const price = familyPrice(first.plan, currency);
    const perMonth = first.plan.interval === 'month';
    const extra = price
        ? ` Each member after that is ${formatMoney(price.perMember, price.currency)} ${perMonth ? 'a month' : 'a year'}, up to ${maxMembers}.`
        : ` A family can have up to ${maxMembers} members.`;
    return [
        {
            q: paidPlans.q,
            a: `On a personal plan, more storage. On a family plan, storage that covers everyone’s own files and the family folders. Every plan protects your files the same way: your password never leaves your device and your keys are made on it.`,
        },
        ...middle(twoMonths),
        {
            q: 'What is a family plan?',
            a: `One plan with ${includedMembers} members included.${extra} It gives family folders that every member can open, end-to-end encrypted. ${poolsLine(family)}, and that storage covers everyone’s own files and the family folders together. You can be in one family. Family folders are on the web for now.`,
        },
        {
            q: 'Can the family see my files?',
            a: 'No. Nobody else in the family can open your own files unless you share them. The people who manage the family see how much space your files take, rounded up to the whole GB, never your files’ names, how many there are or what is in them. Everyone in the family can open the family folders.',
        },
        {
            q: 'Can a family change plans?',
            a: 'Yes. The member who pays moves the family to a bigger plan straight away, and pays the difference for the rest of the period. A smaller plan starts at the next renewal, and nothing is refunded. It can be chosen only while everything the family stores fits in it; if the family stores more by the time it starts, uploads pause for everyone until there is room. Nothing is deleted. Members and places stay as they are.',
        },
        {
            q: 'Who pays for a family plan?',
            a: 'The member who chooses the plan pays for it, through Polar, and is the one who changes the plan or adds and removes places. Every other member needs only a HushOS account. Anyone who already pays for a plan of their own stops paying for it once their files use the family’s storage, and the unused days are refunded.',
        },
        {
            q: 'What happens if a member leaves or is removed?',
            a: 'They lose the family folders straight away. Their own files stay theirs and go back to their own storage, Free unless they choose a plan. If the files take more than that, they can still open, download and delete everything, but can’t upload until they make room. Nothing is deleted. When a member is removed, the device of whoever removed them replaces the family folders’ keys at once. When a member leaves, the keys are replaced the next time someone who manages the family opens it. The member who pays for a live plan has to cancel it before they can leave.',
        },
        {
            q: 'What happens when a family plan is cancelled?',
            a: 'The member who pays cancels it under Billing, on the family’s page. The plan stays until the end of the time paid for. Then everyone’s own files go back to their own storage, as when someone leaves. Nobody can upload to the family folders, and nobody new can join, until someone chooses a plan again. Nothing is deleted.',
        },
        selfHosting,
    ];
}
