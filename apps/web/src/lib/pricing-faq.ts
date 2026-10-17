import { formatQuota } from '@/lib/format';
import type { FamilyOffer } from '@/lib/plans';

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
        a: 'Yes. Choose the one you want and the difference is charged, or credited, to your saved card straight away. Paying yearly gets you two months free.',
    },
];

/*
 * The questions, with the family ones only where the page offers a family
 * plan, so neither the FAQ nor its markup in the head answers for a hidden section.
 */
export function faqFor(family: FamilyOffer | null): Question[] {
    if (!family) return [paidPlans, ...middle, selfHosting];
    const { includedMembers, maxMembers, quotaBytes } = family.plan;
    const pool = formatQuota(quotaBytes);
    return [
        {
            q: paidPlans.q,
            a: `On a personal plan, more storage. On a family plan, family folders with ${pool} for its members to share. Every plan protects your files the same way: your password never leaves your device and your keys are made on it.`,
        },
        ...middle,
        {
            q: 'What is a family plan?',
            a: `One plan for up to ${includedMembers} members, or ${maxMembers} with extra places. It gives family folders that every member can open, end-to-end encrypted. The ${pool} is for family folders; each member’s own files stay on their own plan, Free included. Family folders are on the web for now.`,
        },
        {
            q: 'Who pays for a family plan?',
            a: 'The member who chooses the plan pays for it, through Polar, and is the one who adds or removes places. Every other member needs only a HushOS account, and Free is enough.',
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
