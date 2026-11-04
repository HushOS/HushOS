import { fitAnswer, type FitAnswer, type Sized } from '@/components/fit-answer';

/*
 * The family plans post's storage view, apart from its screen: one plan's storage holding
 * everyone's own files and the family folders, and what happens to it when someone leaves. The
 * plan is the pricing planner's answer (fitAnswer, for this many people); someone leaving takes
 * their own files back to their own storage, Free unless they choose a plan, while the family
 * keeps the plan it has. Sizes are bytes, counted in 1024s.
 */

const GB = 1024 ** 3;
const TB = 1024 * GB;

export type FamilyTier = Sized & { name: string; maxMembers: number };

/* The tiers as the post's own table gives them: 800 GB, 2 TB and 4 TB, each up to 20 people. */
export const FAMILY_TIERS: readonly FamilyTier[] = [
    { key: 'family-plus', name: 'Family Plus', quotaBytes: 800 * GB, maxMembers: 20 },
    { key: 'family-pro', name: 'Family Pro', quotaBytes: 2 * TB, maxMembers: 20 },
    { key: 'family-max', name: 'Family Max', quotaBytes: 4 * TB, maxMembers: 20 },
];

export type FamilyStorage = {
    /* The plan for everyone, as the planner answers it before anyone leaves. */
    answer: FitAnswer<FamilyTier>;
    /* What the family's storage holds now: everyone's own files, then the family folders. */
    ownBytes: number;
    folderBytes: number;
    /* Someone who left: their files, back on their own storage, and whether they fit there. */
    leaver: { bytes: number; quotaBytes: number; fits: boolean } | null;
};

export function familyStorage({
    people,
    ownEach,
    folders,
    leaving,
    freeBytes,
    tiers = FAMILY_TIERS,
}: {
    /* Everyone in the family, the one who may leave included. */
    people: number;
    /* Each person's own files. */
    ownEach: number;
    /* The family folders, shared by everyone. */
    folders: number;
    /* Whether one person leaves. */
    leaving: boolean;
    /* What an account gets with no plan of its own (Free). */
    freeBytes: number;
    tiers?: readonly FamilyTier[];
}): FamilyStorage {
    const answer = fitAnswer<FamilyTier>({
        personal: [],
        family: tiers,
        people,
        total: people * ownEach + folders,
        contact: false,
    });
    const staying = leaving ? people - 1 : people;
    return {
        answer,
        ownBytes: staying * ownEach,
        folderBytes: folders,
        leaver: leaving
            ? { bytes: ownEach, quotaBytes: freeBytes, fits: ownEach <= freeBytes }
            : null,
    };
}
