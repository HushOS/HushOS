import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sections, updated, type RoadmapSection } from './roadmap';

/*
 * The public roadmap says what HushOS has done and will do, so a mistake in
 * it is a broken promise or a dead link on the live site. Each rule below is
 * checked against the real file, and against a copy broken on purpose, so a
 * rule that stopped catching anything would fail too.
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

/* The page a site path is served by: a directory route, a flat route, or a dynamic one. */
function routeExists(path: string) {
    const segments = path.split('#')[0]!.split('/').filter(Boolean);
    const dir = join(WEB, 'src', 'routes', ...segments);
    if (segments.length === 0) return existsSync(join(WEB, 'src', 'routes', 'index.tsx'));
    return (
        existsSync(join(dir, 'route.tsx')) ||
        existsSync(join(dir, 'index.tsx')) ||
        existsSync(`${dir}.tsx`)
    );
}

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
    else if (day.getTime() > today.getTime())
        problems.push(`updated ${lastUpdated} is in the future`);
    for (const section of input)
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
                if (!match || month < 0) problems.push(`${item.id} has no month`);
                else if (Date.UTC(Number(match[2]), month, 1) > today.getTime())
                    problems.push(`${item.id} shipped in the future`);
                else if (day && Date.UTC(Number(match[2]), month, 1) > day.getTime())
                    problems.push(`${item.id} shipped after the roadmap was updated`);
            } else {
                if ('month' in item) problems.push(`${item.id} has a date`);
                if (DATED.test(`${item.title} ${item.body}`))
                    problems.push(`${item.id} names a date`);
            }
            for (const link of item.links ?? []) {
                if (
                    link.kind === 'blog' &&
                    !existsSync(join(WEB, 'src', 'content', 'blog', `${link.slug}.mdx`))
                )
                    problems.push(`${item.id} links to a missing post: ${link.slug}`);
                if (link.kind === 'page' && (!link.to.startsWith('/') || !routeExists(link.to)))
                    problems.push(`${item.id} links to a missing page: ${link.to}`);
                if (
                    link.kind === 'docs' &&
                    (!link.path.startsWith('docs/') || !existsSync(join(REPO, link.path)))
                )
                    problems.push(`${item.id} links to a missing document: ${link.path}`);
                if (link.kind === 'release' && !/^v\d+\.\d+\.\d+$/.test(link.tag))
                    problems.push(`${item.id} links to a release that is not a tag: ${link.tag}`);
            }
        }
    return problems;
}

/* The real roadmap, copied, with one thing changed. */
function broken(change: (copy: RoadmapSection[]) => void) {
    const copy = structuredClone(sections);
    change(copy);
    return problemsOf(copy, updated);
}
const section = (copy: RoadmapSection[], status: (typeof ORDER)[number]) =>
    copy.find((entry) => entry.status === status)!;

describe('the public roadmap', () => {
    test('is sound: unique anchors, dated shipped items, no dates on plans, links that resolve', () => {
        expect(problemsOf(sections, updated)).toEqual([]);
    });

    test('a reused id is caught', () => {
        expect(
            broken((copy) => {
                section(copy, 'next').items[0]!.id = section(copy, 'shipped').items[0]!.id;
            }),
        ).toContainEqual(expect.stringMatching(/used twice/));
    });

    test('a shipped item without a month is caught', () => {
        expect(
            broken((copy) => {
                const item = section(copy, 'shipped').items[0]!;
                if (item.status === 'shipped') item.month = 'soon';
            }),
        ).toContainEqual(expect.stringMatching(/has no month/));
    });

    test('a target date on a plan is caught, in a field or in the words', () => {
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
        ])
            expect(
                broken((copy) => {
                    section(copy, 'later').items[0]!.body = words;
                }),
            ).toContainEqual(expect.stringMatching(/names a date/));
    });

    test('a link to a post, page or document that does not exist is caught', () => {
        const problems = broken((copy) => {
            section(copy, 'shipped').items[0]!.links = [
                { kind: 'blog', slug: 'no-such-post', label: 'x' },
                { kind: 'page', to: '/no-such-page', label: 'x' },
                { kind: 'docs', path: 'docs/no-such-doc.md', label: 'x' },
                { kind: 'release', tag: 'latest', label: 'x' },
            ];
        });
        expect(problems).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/missing post/),
                expect.stringMatching(/missing page/),
                expect.stringMatching(/missing document/),
                expect.stringMatching(/not a tag/),
            ]),
        );
    });

    test('an updated date in the future, or not a date, is caught', () => {
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        expect(problemsOf(sections, tomorrow)).toContainEqual(
            expect.stringMatching(/in the future/),
        );
        expect(problemsOf(sections, '2026-13-01')).toContainEqual(
            expect.stringMatching(/not a date/),
        );
    });
});
