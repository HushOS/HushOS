import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { cn } from 'cn';
import { container, H1, H2, Lede, StartFree } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { type Answer, type Comparison, comparisons, findComparison } from '@/lib/compare';
import { formatDate } from '@/lib/content';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

/*
 * One page per service people ask about, from the same data: the questions a
 * person choosing a drive actually has, each answered for both with a short
 * answer first and the detail under it, then where each is the better pick at
 * the same size, and how to move files across. No ticks or crosses: the
 * reader decides.
 */

export const Route = createFileRoute('/vs/$slug')({
    loader: ({ params }) => {
        const comparison = findComparison(params.slug);
        if (!comparison) throw notFound();
        return { origin: publicOrigin(), comparison };
    },
    head: ({ loaderData }) =>
        loaderData
            ? {
                  meta: pageSocialMeta({
                      origin: loaderData.origin,
                      path: `/vs/${loaderData.comparison.slug}`,
                      card: `vs-${loaderData.comparison.slug}`,
                      title: `HushOS vs ${loaderData.comparison.name}`,
                      description: loaderData.comparison.summary,
                  }),
                  links: [
                      {
                          rel: 'canonical',
                          href: `${loaderData.origin}/vs/${loaderData.comparison.slug}`,
                      },
                  ],
              }
            : {},
    component: ComparePage,
});

function ComparePage() {
    const { comparison } = Route.useLoaderData();
    const others = comparisons.filter((entry) => entry.slug !== comparison.slug);
    return (
        <div className="flex min-h-svh flex-col bg-card">
            <SiteHeader />
            <main className="flex-1">
                <header className={cn(container, 'pt-10 pb-10 lg:pt-20 lg:pb-14')}>
                    <div className="flex max-w-[760px] flex-col gap-5">
                        <p className="text-[15px] text-muted-foreground">
                            Checked against {comparison.maker}’s own pages on{' '}
                            <time dateTime={comparison.checked}>
                                {formatDate(comparison.checked)}
                            </time>
                        </p>
                        <H1 className="lg:text-[56px]">HushOS and {comparison.name}</H1>
                        <Lede>{comparison.summary}</Lede>
                    </div>
                </header>

                <section aria-labelledby="questions-title" className={container}>
                    <h2 id="questions-title" className="sr-only">
                        Question by question
                    </h2>
                    <Questions comparison={comparison} />
                </section>

                <section
                    aria-label="Where each is the better pick"
                    className={cn(container, 'grid gap-10 py-14 md:grid-cols-2 md:gap-16 lg:py-20')}
                >
                    <Picks title="Choose HushOS if" items={comparison.ours} />
                    <Picks
                        title={`${comparison.name} is the better pick if`}
                        items={comparison.theirs}
                    />
                </section>

                <section aria-labelledby="moving-title" className="bg-muted">
                    <div
                        className={cn(
                            container,
                            'grid items-start gap-8 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-20',
                        )}
                    >
                        <div className="flex flex-col gap-5">
                            <H2 id="moving-title">Moving from {comparison.name}</H2>
                            <StartFree className="w-full sm:w-fit" />
                        </div>
                        <ol className="flex flex-col">
                            {comparison.switching.map((step, index) => (
                                <li
                                    key={step}
                                    className="grid grid-cols-[32px_1fr] border-b border-rule py-4 text-[17px] leading-[1.55] text-pretty first:pt-0 last:border-b-0"
                                >
                                    <span
                                        className="font-bold text-muted-foreground tabular-nums"
                                        aria-hidden="true"
                                    >
                                        {index + 1}
                                    </span>
                                    {step}
                                </li>
                            ))}
                        </ol>
                    </div>
                </section>

                <aside className={cn(container, 'flex flex-col gap-3 py-10 lg:py-14')}>
                    <h2 className="text-[15px] font-bold">Also compared</h2>
                    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
                        {others.map((entry) => (
                            <li key={entry.slug}>
                                <Link
                                    to="/vs/$slug"
                                    params={{ slug: entry.slug }}
                                    className="text-link"
                                >
                                    vs {entry.name}
                                </Link>
                            </li>
                        ))}
                    </ul>
                    <p className="max-w-[70ch] pt-4 text-sm leading-relaxed text-muted-foreground">
                        Services change. If something here about {comparison.name} is out of date,{' '}
                        <a
                            href="https://github.com/HushOS/HushOS/issues"
                            target="_blank"
                            rel="noreferrer"
                            className="text-link"
                        >
                            tell us on GitHub
                        </a>{' '}
                        and we will fix it. Everything this page says about HushOS is explained step
                        by step on the{' '}
                        <Link to="/security" className="text-link">
                            security page
                        </Link>
                        .
                    </p>
                </aside>
            </main>
            <SiteFooter />
        </div>
    );
}

/*
 * One list for every width. On a wide screen each question is a row with the
 * two answers in columns under one heading line; on a phone the question sits
 * on top and both answers stack under it, HushOS first, each named, in the
 * same type.
 */
function Questions({ comparison }: { comparison: Comparison }) {
    const row = 'md:grid md:grid-cols-[24%_1fr_1fr] md:gap-x-6';
    return (
        <div className="border-t border-rule md:border-t-0">
            <div
                aria-hidden="true"
                className={cn(
                    row,
                    'hidden border-b-2 border-foreground py-3 text-[15px] font-bold',
                )}
            >
                <span />
                <span>HushOS</span>
                <span>{comparison.name}</span>
            </div>
            {comparison.rows.map((entry) => (
                <div
                    key={entry.topic}
                    className={cn(row, 'flex flex-col gap-3 border-b border-rule py-5')}
                >
                    <h3 className="text-[17px] font-bold md:text-base">{entry.topic}</h3>
                    <Reply who="HushOS" answer={entry.hushos} />
                    <Reply who={comparison.name} answer={entry.other} />
                </div>
            ))}
        </div>
    );
}

function Reply({ who, answer }: { who: string; answer: Answer }) {
    return (
        <p className="flex min-w-0 flex-col gap-0.5 md:gap-1">
            <span className="text-[13px] font-semibold text-muted-foreground md:sr-only">
                {who}
            </span>
            <span className="text-base font-semibold">{answer.short}</span>
            {answer.detail && (
                <span className="text-[15px] leading-[1.55] text-pretty text-muted-foreground">
                    {answer.detail}
                </span>
            )}
        </p>
    );
}

function Picks({ title, items }: { title: string; items: string[] }) {
    return (
        <div className="flex flex-col gap-3">
            <h2 className="text-[22px] leading-tight font-extrabold tracking-[-0.02em] text-balance sm:text-[26px]">
                {title}
            </h2>
            <ul className="flex flex-col">
                {items.map((item) => (
                    <li
                        key={item}
                        className="border-b border-rule py-3.5 text-base leading-[1.55] text-pretty last:border-b-0"
                    >
                        {item}
                    </li>
                ))}
            </ul>
        </div>
    );
}
