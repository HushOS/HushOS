import { publicOrigin, publicSocialMeta, structuredData } from '@/lib/social';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon, CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Faq } from '@/components/faq';
import { Shot } from '@/components/screenshot';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { Button } from '@/components/ui/button';
import { formatDate, posts } from '@/lib/content';
import { cue } from '@/lib/sounds';

const commands = [
    'git clone https://github.com/HushOS/HushOS',
    'cd HushOS',
    'cp .env.production.example .env',
    'docker compose up -d --build',
];

/* Copies the commands as one block; the icon answers for a moment. */
function CopyCommands() {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1_800);
        return () => window.clearTimeout(timer);
    }, [copied]);
    return (
        <Button
            variant="outline"
            size="xs"
            aria-label="Copy the commands"
            aria-live="polite"
            onClick={() => {
                navigator.clipboard.writeText(`${commands.join('\n')}\n`).then(
                    () => {
                        cue('success', { volume: 0.4 });
                        setCopied(true);
                    },
                    () => cue('error'),
                );
            }}
        >
            {copied ? (
                <CheckIcon className="text-success" aria-hidden="true" />
            ) : (
                <CopyIcon aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
        </Button>
    );
}

/*
 * The front page is written for someone who has never thought about
 * encryption and does not want to. It says what HushOS does, why it is easy,
 * and what the protection means in everyday words. The technical account
 * lives on the security page, one link away, for the people who want it.
 */

const faq = [
    {
        q: 'Do I need to understand encryption to use this?',
        a: 'No. You create an account with an email and a password, and everything else happens for you. The one extra step is writing down a 24-word recovery phrase when you sign up. That phrase is what gets you back in if you ever forget your password.',
    },
    {
        q: 'What happens if I forget my password?',
        a: 'You reset it with your recovery phrase and a link we send to your email. Your files stay exactly as they were. Without the phrase, nobody can get in, including us. That is the trade for real privacy, and it is why we ask you to keep the phrase somewhere safe.',
    },
    {
        q: 'Can the people running HushOS see my files?',
        a: 'No. Your files are locked on your device before they are uploaded, and only your devices hold the keys. The server stores scrambled data it cannot read. It does not know your file names either. What it can see is how much space you use and when you use it.',
    },
    {
        q: 'Can I share things with people who do not use HushOS?',
        a: 'Yes. Make a link, and anyone with it can open the folder or file in their browser, with no account. You can add a password and an expiry date, and you can stop the link at any time.',
    },
    {
        q: 'Does it work on my phone?',
        a: 'Yes. HushOS works in the browser on any phone or computer, and you can add it to your home screen like an app. There is nothing to install.',
    },
    {
        q: 'Why should I care about privacy if I have nothing to hide?',
        a: "Because it is not about hiding. Your files are your medical letters, your kids' photos, your lease, your half-written plans. When a service can read them, they are read: by systems that sort and profile you, by staff on a bad day, by whoever breaks in, and lately by models trained on everything they can reach. Privacy just means those things stay yours. It costs you nothing to have it here.",
    },
    {
        q: 'Is this only for work?',
        a: 'No. It is for whatever you keep: family photos, tax returns, a novel, a shared folder for the flat. Work is one of the things people put in a drive, not the only one.',
    },
    {
        q: 'What does it cost?',
        a: 'The hosted service starts free with 2 GiB of storage, and inviting a friend earns you both more. Paid plans add space and nothing else: every plan is protected the same way. If you prefer, you can run HushOS on your own server for free.',
    },
];

const facts = [
    ['Storage', '2 GiB free'],
    ['Your files', 'Locked on your device'],
    ['Your password', 'Never sent to us'],
    ['If you forget it', '24-word recovery phrase'],
    ['Sharing', 'With people, or by link'],
    ['The code', 'Open for anyone to read'],
    ['Where it runs', 'Our cloud, or yours'],
] as const;

const easy = [
    {
        title: 'Drag, drop, done',
        detail: 'Drop files or whole folders onto the page. Big uploads carry on if you close the tab and pick up where they left off when you come back.',
    },
    {
        title: 'Look before you download',
        detail: 'Open photos, PDFs, videos, music, Word and Excel files, and plain text right in the browser. Nothing is unlocked anywhere but on your screen.',
    },
    {
        title: 'Share the way you already do',
        detail: 'Send a link, or share a folder with someone you know. Set a password or an end date if you like. Stop sharing whenever you want.',
    },
];

const features = [
    {
        title: 'Folders and files',
        detail: 'Organise things the way you would anywhere else. Drag to move, rename, copy and sort. Deleted files wait in the trash, and a file you replaced keeps its earlier version.',
    },
    {
        title: 'Open it right here',
        detail: 'Photos, PDFs, video and music, Word documents and spreadsheets open in the browser. There is nothing to download first.',
    },
    {
        title: 'Share with a link or a person',
        detail: 'Send a link anyone can open, with a password or an end date if you like. Or share a folder with someone you know, to view or to edit.',
    },
    {
        title: 'Stop sharing, and mean it',
        detail: 'When you stop sharing something, the person you cut off cannot open it any more. Not even the parts they had already seen.',
    },
    {
        title: 'Find anything',
        detail: 'Press / and start typing. Put a word and a colour on anything and find it by that too. The search happens on your device, so what you type stays with you.',
    },
    {
        title: 'On your phone, and on your own terms',
        detail: 'Add HushOS to your home screen and it works like an app. You can also download your files exactly as we store them, so you never depend on us to get at your things.',
    },
];

const protection = [
    [
        'You add a file',
        'Before it goes anywhere, your device locks it. The key to that lock is made on your device and stays there.',
    ],
    [
        'We store it',
        'What reaches us is scrambled. We can keep it safe and hand it back, but we cannot open it, and neither can anyone who breaks in.',
    ],
    [
        'You open it, or someone you chose does',
        'It is unlocked on the screen in front of you and nowhere else. Sharing hands a copy of the key to that one person, from your device to theirs.',
    ],
    [
        'If you forget your password',
        'The 24 words you wrote down when you signed up let you back in. Without them nobody can, including us. That is the one trade for real privacy.',
    ],
] as const;

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

/* One centred column for every section, the same one the header and footer keep to. */
const container = 'mx-auto w-full max-w-6xl px-5 sm:px-8';
const sectionTitle = 'mt-3 max-w-2xl text-3xl font-bold tracking-tight text-balance sm:text-4xl';

function LandingPage() {
    const { hasSession } = Route.useRouteContext();
    const latest = posts[0];
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 flex-col gap-20 pb-20 lg:gap-28 lg:pb-28">
                <section
                    className={`${container} grid items-center gap-12 pt-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16 lg:pt-20`}
                >
                    <div className="flex flex-col gap-7">
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                            <p className="eyebrow text-muted-foreground">
                                Private storage · Simple to use
                            </p>
                            <Link
                                to="/blog/$slug"
                                params={{ slug: 'hushos-1-0' }}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline-offset-4 transition-colors hover:text-primary-hover hover:underline"
                            >
                                <span className="whitespace-nowrap">HushOS 1.0 is out</span>
                                <ArrowRightIcon className="size-3.5 shrink-0" aria-hidden="true" />
                            </Link>
                        </div>
                        <h1 className="text-5xl leading-[1.04] font-bold tracking-tight text-balance sm:text-6xl">
                            You hold <span className="text-primary">the only key.</span>
                        </h1>
                        <p className="max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
                            HushOS Drive keeps your files locked on your own devices, so nobody else
                            can read them, not even us. It works like any drive you have used: drop
                            files in, open them, share them. The privacy is built in, not bolted on
                            for you to manage.
                        </p>
                        <div className="flex flex-wrap gap-3">
                            {hasSession ? (
                                <Button
                                    render={<Link to="/app/drive" />}
                                    nativeButton={false}
                                    size="lg"
                                >
                                    Open Drive <ArrowRightIcon aria-hidden="true" />
                                </Button>
                            ) : (
                                <>
                                    <Button
                                        render={<Link to="/register" />}
                                        nativeButton={false}
                                        size="lg"
                                    >
                                        Get started <ArrowRightIcon aria-hidden="true" />
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
                    <aside className="sheet px-6 py-6 sm:px-8 sm:py-7">
                        <p className="eyebrow text-muted-foreground">At a glance</p>
                        <dl className="mt-3 text-sm">
                            {facts.map(([key, value]) => (
                                <div
                                    key={key}
                                    className="flex items-baseline justify-between gap-6 border-b border-dotted border-rule py-2.5"
                                >
                                    <dt className="text-muted-foreground">{key}</dt>
                                    <dd
                                        className={`text-right ${value.startsWith('Never') ? 'font-bold' : 'font-medium'}`}
                                    >
                                        {value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        <Link
                            to="/about"
                            className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-primary underline-offset-4 transition-colors hover:text-primary-hover hover:underline"
                        >
                            Why we are building this{' '}
                            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                        </Link>
                    </aside>
                </section>

                <section
                    aria-label="Made to feel easy"
                    className={`${container} grid gap-10 md:grid-cols-3`}
                >
                    {easy.map(({ title, detail }) => (
                        <article key={title} className="flex flex-col gap-2">
                            <h2 className="text-lg font-bold text-balance">{title}</h2>
                            <p className="leading-relaxed text-pretty text-muted-foreground">
                                {detail}
                            </p>
                        </article>
                    ))}
                </section>

                {/* The columns are in the ratio of the pictures' shapes, so both stand the same height. */}
                <section
                    aria-label="What it looks like"
                    className={`${container} grid gap-10 lg:grid-cols-[1.6fr_0.462fr]`}
                >
                    <figure className="flex min-w-0 flex-col gap-4">
                        <Shot
                            name="drive-wide"
                            width={2560}
                            height={1600}
                            sizes="(min-width: 72rem) 51rem, (min-width: 64rem) 72vw, 100vw"
                            alt="HushOS Drive in a browser: folders named Family, Finances, Recipes and Work, and a lease, a reading list and a trip plan, with a storage meter in the sidebar."
                        />
                        <figcaption className="text-sm text-muted-foreground">
                            Your drive on a computer. Folders, files, and how much room is left.
                        </figcaption>
                    </figure>
                    <figure className="mx-auto flex w-full max-w-64 min-w-0 flex-col gap-4 lg:max-w-none">
                        <Shot
                            name="phone-grid"
                            width={780}
                            height={1688}
                            sizes="(min-width: 72rem) 15rem, (min-width: 64rem) 21vw, 16rem"
                            alt="HushOS Drive on a phone, showing a folder of holiday photos as a grid of thumbnails."
                        />
                        <figcaption className="text-sm text-muted-foreground">
                            And on a phone, with the same files.
                        </figcaption>
                    </figure>
                </section>

                <section aria-labelledby="features-title" className={container}>
                    <div className="grid gap-x-16 gap-y-4 lg:grid-cols-2">
                        <div>
                            <p className="eyebrow text-muted-foreground">What you get</p>
                            <h2 id="features-title" className={sectionTitle}>
                                Everything a drive should do. Nothing you have to babysit.
                            </h2>
                        </div>
                        <p className="max-w-xl self-end leading-relaxed text-pretty text-muted-foreground">
                            Most privacy tools ask you to learn their rules first: key files to
                            keep, settings to get right, a second app to install. HushOS asks for an
                            email, a password and one phrase to keep safe. After that, it is just
                            your drive.
                        </p>
                    </div>
                    {/* Twelve entries: whole rows at one, two and three columns. */}
                    <div className="mt-10 grid gap-x-12 sm:grid-cols-2 lg:grid-cols-3">
                        {features.map(({ title, detail }) => (
                            <article
                                key={title}
                                className="flex flex-col gap-1.5 border-t border-rule py-5"
                            >
                                <h3 className="font-bold text-balance">{title}</h3>
                                <p className="text-[15px] leading-relaxed text-pretty text-muted-foreground">
                                    {detail}
                                </p>
                            </article>
                        ))}
                    </div>
                </section>

                <section
                    aria-labelledby="protection-title"
                    className={`${container} grid gap-x-16 gap-y-8 lg:grid-cols-[5fr_7fr]`}
                >
                    <div>
                        <p className="eyebrow text-muted-foreground">How it works</p>
                        <h2 id="protection-title" className={sectionTitle}>
                            Locked on your device. Stays locked everywhere else.
                        </h2>
                        <p className="mt-4 max-w-md leading-relaxed text-muted-foreground">
                            You do not have to take our word for it. The code is public, so anyone
                            can check, and the security page goes through every step in detail.
                        </p>
                        <Link
                            to="/security"
                            className="text-link mt-5 inline-flex items-center gap-2 text-sm"
                        >
                            Read the security model <ArrowRightIcon className="size-4" />
                        </Link>
                    </div>
                    <dl>
                        {protection.map(([term, detail], index) => (
                            <div
                                key={term}
                                className="grid gap-x-8 gap-y-1 border-b border-rule py-5 first:pt-0 last:border-b-0 sm:grid-cols-[12rem_1fr]"
                            >
                                <dt className="font-bold">
                                    <span className="mr-2 text-muted-foreground tabular-nums">
                                        {index + 1}.
                                    </span>
                                    {term}
                                </dt>
                                <dd className="text-[15px] leading-relaxed text-pretty text-muted-foreground">
                                    {detail}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section
                    aria-labelledby="selfhost-title"
                    className={`${container} grid items-start gap-x-16 gap-y-8 lg:grid-cols-[5fr_7fr]`}
                >
                    <div>
                        <p className="eyebrow text-muted-foreground">Prefer your own server?</p>
                        <h2 id="selfhost-title" className={sectionTitle}>
                            Run it yourself, for free.
                        </h2>
                        <p className="mt-4 max-w-md leading-relaxed text-muted-foreground">
                            The same HushOS that runs here can run on a machine you control, for
                            you, your family or your team. It takes a few commands, and the guide
                            walks through each one.
                        </p>
                        <a
                            href="https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md"
                            target="_blank"
                            rel="noreferrer"
                            className="text-link mt-5 inline-flex items-center gap-2 text-sm"
                        >
                            Read the self-hosting guide <ArrowRightIcon className="size-4" />
                        </a>
                    </div>
                    <div className="min-w-0 rounded-md border border-rule bg-muted">
                        <div className="flex items-center justify-between gap-4 px-5 pt-3">
                            <p className="eyebrow text-muted-foreground">Terminal</p>
                            <CopyCommands />
                        </div>
                        <pre className="overflow-x-auto px-5 pt-3 pb-5 font-mono text-[13px] leading-loose">
                            <code>
                                {commands.map((command, index) => (
                                    <span key={command}>
                                        <span className="text-muted-foreground">$ </span>
                                        {command}
                                        {index < commands.length - 1 ? '\n' : ''}
                                    </span>
                                ))}
                            </code>
                        </pre>
                    </div>
                </section>

                {latest && (
                    <section aria-labelledby="blog-title" className={container}>
                        <h2 id="blog-title" className="eyebrow text-muted-foreground">
                            From the blog · {formatDate(latest.meta.date)}
                        </h2>
                        <Link
                            to="/blog/$slug"
                            params={{ slug: latest.slug }}
                            className="group mt-3 inline-flex items-baseline gap-3 text-xl font-bold tracking-tight text-balance transition-colors hover:text-primary"
                        >
                            {latest.meta.title}
                            <ArrowRightIcon
                                className="size-4 shrink-0 self-center text-primary transition-transform group-hover:translate-x-0.5"
                                aria-hidden="true"
                            />
                        </Link>
                    </section>
                )}
                <section
                    aria-labelledby="faq-title"
                    className={`${container} grid gap-x-16 gap-y-4 lg:grid-cols-[5fr_7fr]`}
                >
                    <h2 id="faq-title" className="text-2xl font-bold tracking-tight sm:text-3xl">
                        Questions people ask
                    </h2>
                    <Faq items={faq} />
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
