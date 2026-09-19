import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { comparisons, findComparison } from '@/lib/compare';
import { formatDate } from '@/lib/content';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

/*
 * One page per service people ask about, from the same data: a table that
 * answers the questions a person choosing a drive actually has, then where
 * the other service is the better choice, where HushOS is different, and how
 * to move files across.
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
    const { hasSession } = Route.useRouteContext();
    const others = comparisons.filter((entry) => entry.slug !== comparison.slug);
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-8 sm:py-14">
                <article className="sheet flex flex-col gap-12 px-6 py-10 sm:px-12 sm:py-14">
                    <header className="flex max-w-[70ch] flex-col gap-5">
                        <p className="eyebrow text-muted-foreground">
                            Compared · checked {formatDate(comparison.checked)}
                        </p>
                        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                            HushOS vs {comparison.name}
                        </h1>
                        <p className="text-lg leading-relaxed text-pretty text-muted-foreground">
                            {comparison.summary}
                        </p>
                        <div className="flex flex-wrap gap-3">
                            <Button
                                render={<Link to={hasSession ? '/app/drive' : '/register'} />}
                                nativeButton={false}
                                size="lg"
                            >
                                {hasSession ? 'Open Drive' : 'Try HushOS free'}{' '}
                                <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        </div>
                    </header>

                    <section aria-labelledby="table-title">
                        <h2 id="table-title" className="text-lg font-bold">
                            Side by side
                        </h2>
                        <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[36rem] border-collapse text-sm">
                                <thead>
                                    <tr className="eyebrow text-muted-foreground">
                                        <th
                                            scope="col"
                                            className="border-b border-rule py-3 pr-5 text-left"
                                        >
                                            &nbsp;
                                        </th>
                                        <th
                                            scope="col"
                                            className="border-b border-rule py-3 pr-5 text-left text-foreground"
                                        >
                                            HushOS
                                        </th>
                                        <th
                                            scope="col"
                                            className="border-b border-rule py-3 text-left"
                                        >
                                            {comparison.name}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {comparison.rows.map((row) => (
                                        <tr key={row.topic} className="align-top">
                                            <th
                                                scope="row"
                                                className="w-1/4 border-b border-rule py-4 pr-5 text-left font-semibold"
                                            >
                                                {row.topic}
                                            </th>
                                            <td className="w-[37.5%] border-b border-rule py-4 pr-5 leading-relaxed">
                                                {row.hushos}
                                            </td>
                                            <td className="w-[37.5%] border-b border-rule py-4 leading-relaxed text-muted-foreground">
                                                {row.other}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section
                        aria-label="Where each is better"
                        className="grid gap-10 md:grid-cols-2"
                    >
                        <article>
                            <h2 className="text-lg font-bold">Choose HushOS if</h2>
                            <ul className="mt-3">
                                {comparison.ours.map((item) => (
                                    <li
                                        key={item}
                                        className="border-b border-rule py-3 text-sm leading-relaxed text-pretty last:border-b-0"
                                    >
                                        {item}
                                    </li>
                                ))}
                            </ul>
                        </article>
                        <article>
                            <h2 className="text-lg font-bold">
                                {comparison.name} is the better pick if
                            </h2>
                            <ul className="mt-3">
                                {comparison.theirs.map((item) => (
                                    <li
                                        key={item}
                                        className="border-b border-rule py-3 text-sm leading-relaxed text-pretty last:border-b-0"
                                    >
                                        {item}
                                    </li>
                                ))}
                            </ul>
                        </article>
                    </section>

                    <section aria-labelledby="switch-title" className="max-w-[70ch]">
                        <h2 id="switch-title" className="text-lg font-bold">
                            Moving from {comparison.name}
                        </h2>
                        <p className="mt-3 leading-relaxed text-pretty">{comparison.switching}</p>
                    </section>

                    <p className="max-w-[70ch] border-t border-rule pt-6 text-xs leading-relaxed text-muted-foreground">
                        What this page says about {comparison.name} was checked against its own
                        published pages on {formatDate(comparison.checked)}. Services change; if
                        something here is out of date, tell us on GitHub and we will fix it. What it
                        says about HushOS is explained claim by claim on the{' '}
                        <Link to="/security" className="text-link">
                            security page
                        </Link>
                        .
                    </p>
                </article>

                <aside className="mt-10 px-2 text-sm">
                    <p className="eyebrow text-muted-foreground">Also compared</p>
                    <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                        {others.map((entry) => (
                            <li key={entry.slug}>
                                <Link
                                    to="/vs/$slug"
                                    params={{ slug: entry.slug }}
                                    className="text-link"
                                >
                                    HushOS vs {entry.name}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </aside>
            </main>
            <SiteFooter />
        </div>
    );
}
