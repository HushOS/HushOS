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
            <main className="flex flex-1 flex-col">
                <section className="grid border-b lg:grid-cols-12">
                    <div className="flex flex-col gap-6 px-5 py-12 sm:px-10 lg:col-span-8 lg:py-16">
                        <p className="eyebrow text-muted-foreground">
                            Compared · checked {formatDate(comparison.checked)}
                        </p>
                        <h1 className="max-w-3xl font-mono text-4xl leading-[1.05] font-medium tracking-tight text-balance sm:text-5xl">
                            HushOS vs {comparison.name}
                        </h1>
                        <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                            {comparison.summary}
                        </p>
                        <div className="flex flex-wrap gap-3">
                            <Button
                                render={<Link to={hasSession ? '/app' : '/register'} />}
                                nativeButton={false}
                                size="lg"
                            >
                                {hasSession ? 'Open Drive' : 'Try HushOS free'}{' '}
                                <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        </div>
                    </div>
                    <aside className="flex flex-col border-t lg:col-span-4 lg:border-t-0 lg:border-l">
                        <p className="eyebrow border-b px-5 py-4 text-muted-foreground">
                            Also compared
                        </p>
                        <ul className="flex-1">
                            {others.map((entry) => (
                                <li key={entry.slug} className="border-b last:border-b-0">
                                    <Link
                                        to="/vs/$slug"
                                        params={{ slug: entry.slug }}
                                        className="flex items-center justify-between px-5 py-3 text-sm transition-colors hover:bg-muted"
                                    >
                                        HushOS vs {entry.name}
                                        <ArrowRightIcon
                                            className="size-3.5 text-primary"
                                            aria-hidden="true"
                                        />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </aside>
                </section>

                <section aria-labelledby="table-title" className="border-b">
                    <div className="border-b px-5 py-4 sm:px-10">
                        <h2 id="table-title" className="eyebrow text-muted-foreground">
                            Side by side
                        </h2>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[40rem] border-collapse text-sm">
                            <thead>
                                <tr className="eyebrow text-muted-foreground">
                                    <th
                                        scope="col"
                                        className="border-b px-5 py-3 text-left font-normal sm:px-10"
                                    >
                                        &nbsp;
                                    </th>
                                    <th
                                        scope="col"
                                        className="border-b border-l px-5 py-3 text-left font-normal text-foreground"
                                    >
                                        HushOS
                                    </th>
                                    <th
                                        scope="col"
                                        className="border-b border-l px-5 py-3 text-left font-normal"
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
                                            className="w-1/4 border-b px-5 py-4 text-left font-medium tracking-tight sm:px-10"
                                        >
                                            {row.topic}
                                        </th>
                                        <td className="w-[37.5%] border-b border-l px-5 py-4 leading-relaxed">
                                            {row.hushos}
                                        </td>
                                        <td className="w-[37.5%] border-b border-l px-5 py-4 leading-relaxed text-muted-foreground">
                                            {row.other}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section aria-label="Where each is better" className="grid border-b md:grid-cols-2">
                    <article className="border-b px-5 py-8 sm:px-10 md:border-r md:border-b-0">
                        <h2 className="eyebrow text-muted-foreground">
                            Choose {comparison.name} if
                        </h2>
                        <ul className="mt-4 flex flex-col gap-3">
                            {comparison.theirs.map((item) => (
                                <li
                                    key={item}
                                    className="border-b border-dotted pb-3 text-sm leading-relaxed text-pretty last:border-b-0"
                                >
                                    {item}
                                </li>
                            ))}
                        </ul>
                    </article>
                    <article className="px-5 py-8 sm:px-10">
                        <h2 className="eyebrow text-muted-foreground">Choose HushOS if</h2>
                        <ul className="mt-4 flex flex-col gap-3">
                            {comparison.ours.map((item) => (
                                <li
                                    key={item}
                                    className="border-b border-dotted pb-3 text-sm leading-relaxed text-pretty last:border-b-0"
                                >
                                    {item}
                                </li>
                            ))}
                        </ul>
                    </article>
                </section>

                <section
                    aria-labelledby="switch-title"
                    className="grid grid-cols-1 border-b lg:grid-cols-12"
                >
                    <div className="px-5 py-8 sm:px-10 lg:col-span-5 lg:border-r">
                        <h2 id="switch-title" className="eyebrow text-muted-foreground">
                            Moving from {comparison.name}
                        </h2>
                    </div>
                    <p className="max-w-xl px-5 py-8 text-sm leading-relaxed text-pretty sm:px-10 lg:col-span-7">
                        {comparison.switching}
                    </p>
                </section>

                <section className="grid border-b lg:grid-cols-12">
                    <p className="max-w-xl px-5 py-6 text-xs leading-relaxed text-muted-foreground sm:px-10 lg:col-span-12">
                        What this page says about {comparison.name} was checked against its own
                        published pages on {formatDate(comparison.checked)}. Services change; if
                        something here is out of date, tell us on GitHub and we will fix it. What it
                        says about HushOS is explained claim by claim on the{' '}
                        <Link to="/security" className="text-link">
                            security page
                        </Link>
                        .
                    </p>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
