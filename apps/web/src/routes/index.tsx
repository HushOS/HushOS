import { publicOrigin, publicSocialMeta, structuredData } from '@/lib/social';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';

import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { formatDate, posts } from '@/lib/content';

const faq = [
    {
        q: 'Can the people running the server read my password?',
        a: 'No. Sign-in uses OPAQUE, a password-authenticated key exchange. The server stores a record it can verify against, but the password itself never leaves your browser, not even as a hash.',
    },
    {
        q: 'What happens if I forget my password?',
        a: 'You reset it with your 24-word recovery phrase and access to your email. The phrase unwraps the same account key, so nothing is lost. Without the phrase, nobody can recover the account, including us.',
    },
    {
        q: 'Is my data encrypted end to end?',
        a: 'Your account key and identity keys are generated and wrapped in your browser, so the server only ever holds ciphertext it cannot open. Drive follows the same model: file keys are made on your device and content is encrypted before it leaves.',
    },
    {
        q: 'Can I run it myself?',
        a: 'Yes. HushOS is AGPL-3.0 and ships with a Docker Compose setup. Clone the repository, create an environment file, and start the stack. Your instance, your data, your terms.',
    },
];

const ledger = [
    ['Protocol', 'OPAQUE'],
    ['Password sent', 'Never'],
    ['Account key', 'Created in your browser'],
    ['Recovery', '24-word phrase'],
    ['Licence', 'AGPL-3.0'],
    ['Hosting', 'Our cloud, or yours'],
] as const;

const principles = [
    {
        title: 'Your password never leaves your device',
        detail: 'Sign-in uses OPAQUE, a password-authenticated key exchange. The server never receives your password, not even a hash of it.',
    },
    {
        title: 'Your account key is yours',
        detail: 'It is generated in your browser and protected by your password and a 24-word recovery phrase. Resetting your password keeps the same key.',
    },
    {
        title: 'Open source. Easy to self-host.',
        detail: 'HushOS is AGPL-licensed. Read every line, or run your own instance in minutes. Trust should come from what you can inspect.',
    },
];

export const Route = createFileRoute('/')({
    loader: () => ({ origin: publicOrigin() }),
    headers: () => ({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' }),
    head: ({ loaderData }) =>
        loaderData
            ? {
                  meta: [
                      ...publicSocialMeta(loaderData.origin),
                      { property: 'og:url', content: loaderData.origin },
                  ],
                  links: [{ rel: 'canonical', href: loaderData.origin }],
                  scripts: [
                      ...structuredData(loaderData.origin),
                      {
                          type: 'application/ld+json',
                          children: JSON.stringify({
                              '@context': 'https://schema.org',
                              '@type': 'FAQPage',
                              mainEntity: faq.map(({ q, a }) => ({
                                  '@type': 'Question',
                                  name: q,
                                  acceptedAnswer: { '@type': 'Answer', text: a },
                              })),
                          }),
                      },
                  ],
              }
            : {},
    component: LandingPage,
});

function LandingPage() {
    const { hasSession } = Route.useRouteContext();
    const latest = posts[0];
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 flex-col">
                <section className="grid border-b lg:grid-cols-12">
                    <div className="flex flex-col justify-between gap-12 px-5 py-14 sm:px-10 lg:col-span-8 lg:py-20">
                        <p className="eyebrow text-muted-foreground">
                            Open source · Easy to self-host
                        </p>
                        <h1 className="max-w-4xl font-mono text-[2.75rem] leading-[1.02] font-medium tracking-tight text-balance sm:text-6xl lg:text-7xl">
                            A private place for your work.
                        </h1>
                        <div className="flex flex-col gap-8">
                            <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                                HushOS is a productivity suite built so you can verify how it
                                protects you instead of taking our word for it. Your password stays
                                on your device, your keys are created there, and the code is public.
                            </p>
                            <div className="flex flex-wrap gap-3">
                                {hasSession ? (
                                    <Button
                                        render={<Link to="/app" />}
                                        nativeButton={false}
                                        size="lg"
                                        data-cuelume-press="pulse"
                                    >
                                        Open your workspace <ArrowRightIcon aria-hidden="true" />
                                    </Button>
                                ) : (
                                    <>
                                        <Button
                                            render={<Link to="/register" />}
                                            nativeButton={false}
                                            size="lg"
                                            data-cuelume-press="pulse"
                                        >
                                            Create your account{' '}
                                            <ArrowRightIcon aria-hidden="true" />
                                        </Button>
                                        <Button
                                            render={<Link to="/login" />}
                                            nativeButton={false}
                                            size="lg"
                                            variant="outline"
                                        >
                                            Sign in
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                    <aside className="flex flex-col border-t lg:col-span-4 lg:border-t-0 lg:border-l">
                        <p className="eyebrow border-b px-5 py-4 text-muted-foreground">
                            What the code guarantees
                        </p>
                        <dl className="flex-1 px-5 py-4 font-mono text-[13px]">
                            {ledger.map(([key, value]) => (
                                <div
                                    key={key}
                                    className="flex justify-between gap-6 border-b border-dotted py-2.5 last:border-b-0"
                                >
                                    <dt className="eyebrow self-center text-muted-foreground">
                                        {key}
                                    </dt>
                                    <dd className={value === 'Never' ? 'font-semibold' : ''}>
                                        {value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        <Link
                            to="/security"
                            className="eyebrow flex items-center justify-between border-t px-5 py-4 text-foreground transition-colors hover:bg-muted"
                        >
                            Read the security model{' '}
                            <ArrowRightIcon className="size-3.5 text-primary" aria-hidden="true" />
                        </Link>
                    </aside>
                </section>

                <section aria-label="Principles" className="grid border-b md:grid-cols-3">
                    {principles.map(({ title, detail }, index) => (
                        <article
                            key={title}
                            className="flex flex-col gap-4 border-b px-5 py-8 last:border-b-0 sm:px-10 md:border-r md:border-b-0 md:last:border-r-0"
                        >
                            <span className="eyebrow text-muted-foreground">0{index + 1}</span>
                            <h2 className="text-lg font-medium tracking-tight text-balance">
                                {title}
                            </h2>
                            <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
                                {detail}
                            </p>
                        </article>
                    ))}
                </section>

                <section
                    aria-labelledby="selfhost-title"
                    className="grid grid-cols-1 border-b lg:grid-cols-12"
                >
                    <div className="px-5 py-10 sm:px-10 lg:col-span-5 lg:border-r">
                        <p className="eyebrow text-muted-foreground">Self-host</p>
                        <h2
                            id="selfhost-title"
                            className="mt-4 text-2xl font-medium tracking-tight text-balance sm:text-3xl"
                        >
                            Your server, three commands.
                        </h2>
                        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
                            HushOS ships as a Docker Compose stack with PostgreSQL and the web app.
                            The same code that runs here runs on your machine, under your terms and
                            your privacy policy.
                        </p>
                        <a
                            href="https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md"
                            target="_blank"
                            rel="noreferrer"
                            className="text-link mt-6 inline-flex items-center gap-2 text-sm"
                        >
                            Read the self-hosting guide <ArrowRightIcon className="size-4" />
                        </a>
                    </div>
                    <div className="flex min-w-0 flex-col lg:col-span-7">
                        <p className="eyebrow border-b px-5 py-3.5 text-muted-foreground sm:px-10">
                            Terminal
                        </p>
                        <pre className="flex-1 overflow-x-auto px-5 py-6 font-mono text-[13px] leading-loose sm:px-10">
                            <code>
                                <span className="text-muted-foreground">$ </span>git clone
                                https://github.com/HushOS/HushOS && cd hushos{'\n'}
                                <span className="text-muted-foreground">$ </span>cp
                                .env.production.example .env{'\n'}
                                <span className="text-muted-foreground">$ </span>docker compose up
                                -d --build
                            </code>
                        </pre>
                    </div>
                </section>

                {latest && (
                    <section aria-labelledby="blog-title" className="grid border-b lg:grid-cols-12">
                        <div className="flex items-center px-5 py-4 sm:px-10 lg:col-span-5 lg:border-r">
                            <h2 id="blog-title" className="eyebrow text-muted-foreground">
                                From the blog · {formatDate(latest.meta.date)}
                            </h2>
                        </div>
                        <Link
                            to="/blog/$slug"
                            params={{ slug: latest.slug }}
                            className="group flex items-center justify-between gap-6 px-5 py-4 transition-colors hover:bg-muted sm:px-10 lg:col-span-7"
                        >
                            <span className="text-base font-medium tracking-tight text-balance">
                                {latest.meta.title}
                            </span>
                            <ArrowRightIcon
                                className="size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5"
                                aria-hidden="true"
                            />
                        </Link>
                    </section>
                )}
                <section aria-labelledby="faq-title" className="border-b">
                    <div className="border-b px-5 py-4 sm:px-10">
                        <h2 id="faq-title" className="eyebrow text-muted-foreground">
                            Questions
                        </h2>
                    </div>
                    <div className="grid md:grid-cols-2">
                        {faq.map(({ q, a }, index) => (
                            <article
                                key={q}
                                className="border-b px-5 py-7 sm:px-10 md:odd:border-r nth-last-[-n+1]:border-b-0 md:nth-last-[-n+2]:border-b-0"
                            >
                                <span className="eyebrow text-muted-foreground">Q{index + 1}</span>
                                <h3 className="mt-3 text-base font-medium tracking-tight text-balance">
                                    {q}
                                </h3>
                                <p className="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground">
                                    {a}
                                </p>
                            </article>
                        ))}
                    </div>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
