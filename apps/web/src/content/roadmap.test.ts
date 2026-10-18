import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sections, updated, type RoadmapLink, type RoadmapSection } from './roadmap';

/*
 * The public roadmap says what HushOS has done and will do, so a mistake in
 * it is a broken promise or a dead link on the live site. Each rule below is
 * checked against the real file, and against a copy broken on purpose, so a
 * rule that stopped catching anything would fail too. Links to pages on this
 * site are typed by the router instead: a page that doesn't exist fails the
 * typecheck, and the last test proves the type refuses one.
 */

const WEB = join(import.meta.dirname, '..', '..');
const REPO = join(WEB, '..', '..');
const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];
const ORDER = ['shipped', 'now', 'next', 'later'] as const;
// A date or a promise of one: a month or season with a year, a quarter, a bare year, or "soon".
const DATED =
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|spring|summer|autumn|fall|winter)\b\.?\s+(?:of\s+)?\d{4}\b|\bq[1-4]\b|\bh[12]\s+\d{4}\b|\b20\d\d\b|\b(?:coming\s+)?soon\b|\bthis year\b|\bnext year\b|\bby the end of\b/i;
// Certainty about when, without a date.
const CERTAIN =
    /\bwill (?:ship|arrive|launch|land|be (?:ready|available|out|live))\b|\bshortly\b|\bimminent(?:ly)?\b|\bin (?:a few |\d+ )?(?:days|weeks|months)\b|\bguarantee/i;
/* A day of slack: an author ahead of UTC (in India, say) writes tomorrow's date. */
const SLACK_MS = 86_400_000;

const promises = (text: string) => DATED.test(text) || CERTAIN.test(text);

/* Every way the roadmap can be wrong, as sentences; none for a sound one. */
function problemsOf(input: RoadmapSection[], lastUpdated: string, today = new Date()) {
    const problems: string[] = [];
    const seen = new Set<string>();
    if (input.map((section) => section.status).join() !== ORDER.join())
        problems.push('sections are not Shipped, Now, Next, Later');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(lastUpdated)
        ? new Date(`${lastUpdated}T00:00:00Z`)
        : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== lastUpdated)
        problems.push(`updated "${lastUpdated}" is not a date`);
    else if (day.getTime() > today.getTime() + SLACK_MS)
        problems.push(`updated ${lastUpdated} is in the future`);
    for (const section of input) {
        if (promises(section.summary)) problems.push(`${section.title}'s summary names a date`);
        for (const item of section.items) {
            if (seen.has(item.id)) problems.push(`${item.id} is used twice`);
            seen.add(item.id);
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id))
                problems.push(`${item.id} is not an anchor`);
            if (item.status !== section.status)
                problems.push(`${item.id} is ${item.status} under ${section.title}`);
            if (item.status === 'shipped') {
                const match = /^([A-Z][a-z]+) (\d{4})$/.exec(item.month ?? '');
                const month = match ? MONTHS.indexOf(match[1]!) : -1;
                const start = match && month >= 0 ? Date.UTC(Number(match[2]), month, 1) : NaN;
                if (Number.isNaN(start)) problems.push(`${item.id} has no month`);
                else if (start > today.getTime() + SLACK_MS)
                    problems.push(`${item.id} shipped in the future`);
                else if (day && start > day.getTime())
                    problems.push(`${item.id} shipped after the roadmap was updated`);
            } else {
                if ('month' in item) problems.push(`${item.id} has a date`);
                if (promises(`${item.title} ${item.body}`))
                    problems.push(`${item.id} names a date`);
            }
            for (const link of item.links ?? []) {
                if (
                    link.kind === 'blog' &&
                    !existsSync(join(WEB, 'src', 'content', 'blog', `${link.slug}.mdx`))
                )
                    problems.push(`${item.id} links to a missing post: ${link.slug}`);
                if (
                    link.kind === 'docs' &&
                    (!link.path.startsWith('docs/') || !existsSync(join(REPO, link.path)))
                )
                    problems.push(`${item.id} links to a missing document: ${link.path}`);
                if (link.kind === 'release' && !/^v\d+\.\d+\.\d+$/.test(link.tag))
                    problems.push(`${item.id} links to a release that is not a tag: ${link.tag}`);
            }
        }
    }
    return problems;
}

/* The real roadmap, copied, with one thing changed. */
function broken(change: (copy: RoadmapSection[]) => void, lastUpdated = updated) {
    const copy = structuredClone(sections);
    change(copy);
    return problemsOf(copy, lastUpdated);
}
const section = (copy: RoadmapSection[], status: (typeof ORDER)[number]) =>
    copy.find((entry) => entry.status === status)!;
const setMonth = (copy: RoadmapSection[], month: string) => {
    const item = section(copy, 'shipped').items[0]!;
    if (item.status === 'shipped') item.month = month;
};

describe('the public roadmap', () => {
    test('is sound: unique anchors, dated shipped items, no dates on plans, links that resolve', () => {
        expect(problemsOf(sections, updated)).toEqual([]);
    });

    test('sections out of order are caught', () => {
        expect(broken((copy) => copy.reverse())).toContainEqual(
            expect.stringMatching(/not Shipped, Now, Next, Later/),
        );
    });

    test('a reused id, or one that is not an anchor, is caught', () => {
        expect(
            broken((copy) => {
                section(copy, 'next').items[0]!.id = section(copy, 'shipped').items[0]!.id;
            }),
        ).toContainEqual(expect.stringMatching(/used twice/));
        expect(
            broken((copy) => {
                section(copy, 'next').items[0]!.id = 'Editing in the browser';
            }),
        ).toContainEqual(expect.stringMatching(/not an anchor/));
    });

    test('an item filed under the wrong section is caught', () => {
        expect(
            broken((copy) => {
                section(copy, 'later').items.push(section(copy, 'now').items[0]!);
            }),
        ).toContainEqual(expect.stringMatching(/is now under Later/));
    });

    test('a shipped item without a month, or shipped in the future or after the update, is caught', () => {
        expect(broken((copy) => setMonth(copy, 'soon'))).toContainEqual(
            expect.stringMatching(/has no month/),
        );
        expect(broken((copy) => setMonth(copy, 'December 2099'))).toContainEqual(
            expect.stringMatching(/shipped in the future/),
        );
        // The real file has items that shipped in October; an update dated in September predates them.
        expect(broken(() => undefined, '2026-09-30')).toContainEqual(
            expect.stringMatching(/shipped after the roadmap was updated/),
        );
    });

    test('a target date or a promise of timing on a plan is caught, in an item or a summary', () => {
        expect(
            broken((copy) => {
                Object.assign(section(copy, 'now').items[0]!, { month: 'December 2026' });
            }),
        ).toContainEqual(expect.stringMatching(/has a date/));
        for (const words of [
            'Arrives in March 2027.',
            'Planned for Q2.',
            'Coming soon.',
            'Due in 2027.',
            'This will ship next.',
            'Out shortly.',
            'Ready in a few weeks.',
        ])
            expect(
                broken((copy) => {
                    section(copy, 'later').items[0]!.body = words;
                }),
            ).toContainEqual(expect.stringMatching(/names a date/));
        expect(
            broken((copy) => {
                section(copy, 'next').summary = 'Arriving in weeks.';
            }),
        ).toContainEqual(expect.stringMatching(/summary names a date/));
    });

    test('a link to a post or document that does not exist is caught', () => {
        const problems = broken((copy) => {
            section(copy, 'shipped').items[0]!.links = [
                { kind: 'blog', slug: 'no-such-post', label: 'x' },
                { kind: 'docs', path: 'docs/no-such-doc.md', label: 'x' },
                { kind: 'release', tag: 'latest', label: 'x' },
            ];
        });
        expect(problems).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/missing post/),
                expect.stringMatching(/missing document/),
                expect.stringMatching(/not a tag/),
            ]),
        );
    });

    test('a page link is typed by the router, so a page that does not exist does not compile', () => {
        // @ts-expect-error The router has no /no-such-page: if this compiles, page links are unchecked.
        const dead: RoadmapLink = { kind: 'page', to: '/no-such-page', label: 'x' };
        const live: RoadmapLink = { kind: 'page', to: '/security', label: 'x' };
        expect([dead.kind, live.kind]).toEqual(['page', 'page']);
    });

    test('an updated date in the future, or not a date, is caught, with a day of slack', () => {
        const at = (days: number) =>
            new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
        expect(problemsOf(sections, at(3))).toContainEqual(expect.stringMatching(/in the future/));
        expect(problemsOf(sections, at(1))).not.toContainEqual(
            expect.stringMatching(/in the future/),
        );
        expect(problemsOf(sections, '2026-13-01')).toContainEqual(
            expect.stringMatching(/not a date/),
        );
    });
});
