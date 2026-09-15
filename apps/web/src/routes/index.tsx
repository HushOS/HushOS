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
        <button
            type="button"
            aria-label="Copy the commands"
            aria-live="polite"
            data-cuelume-hover="tick"
            className="eyebrow inline-flex items-center gap-2 border px-3 py-1.5 text-foreground transition-colors hover:bg-muted"
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
                <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
            ) : (
                <CopyIcon className="size-3.5" aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
        </button>
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
    ['Against quantum computers', 'Files always were; shares now too'],
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
        detail: 'Organise your work the way you would anywhere else. Move things by dragging them. Rename, copy, and sort.',
    },
    {
        title: 'Previews',
        detail: 'Images, PDFs, video and audio, Markdown, code, Word documents, spreadsheets and CSV files open in place.',
    },
    {
        title: 'Links for anyone',
        detail: 'A link opens in any browser, no account needed. Add a password, an expiry, or show it as a QR code.',
    },
    {
        title: 'Sharing with people',
        detail: 'Share a folder with someone as a viewer or an editor. They see it under "Shared with me" and can keep their own copy.',
    },
    {
        title: 'Stop sharing, for real',
        detail: 'When you stop a share or a link, the folder gets new keys. Whoever you cut off cannot open anything, even what they saw before.',
    },
    {
        title: 'Undo mistakes',
        detail: 'Deleted files go to the trash first. A file you replaced keeps its earlier version, so you can go back.',
    },
    {
        title: 'On your phone',
        detail: 'Add HushOS to your home screen and it behaves like an app, with the same files and the same protection.',
    },
    {
        title: 'Report something wrong',
        detail: 'If someone shares something with you that should not exist, you can report it and it is handled. Privacy is not a shield for abuse.',
    },
];

const protection = [
    [
        'Before a file leaves your device',
        'It is locked with a key that only exists on your devices. What travels and what we store is scrambled.',
    ],
    [
        'Your password',
        'It is checked without ever being sent, using a method called OPAQUE. Not even a disguised version of it reaches the server.',
    ],
    [
        'When you share',
        'The key to a folder is wrapped up for the person you chose, on your device, with a classical key and a post-quantum one together. We pass the parcel; we cannot open it, and neither could a quantum computer later.',
    ],
    [
        'If you lose your password',
        'Your recovery phrase unlocks the same key. Nothing is rebuilt, nothing is lost.',
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

function LandingPage() {
    const { hasSession } = Route.useRouteContext();
    const latest = posts[0];
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 flex-col">
                <section className="grid border-b lg:grid-cols-12">
                    <div className="flex flex-col justify-between gap-12 px-5 py-14 sm:px-10 lg:col-span-8 lg:py-20">
                        <div className="flex flex-wrap items-center gap-3">
                            <p className="eyebrow text-muted-foreground">
                                Private storage · Simple to use
                            </p>
                            <Link
                                to="/blog/$slug"
                                params={{ slug: 'hushos-1-0' }}
                                data-cuelume-hover="tick"
                                className="eyebrow inline-flex items-center gap-2 border px-3 py-1.5 text-foreground transition-colors hover:bg-muted"
                            >
                                <span className="size-2 shrink-0 bg-primary" aria-hidden="true" />
                                <span className="whitespace-nowrap">
                                    HushOS 1.0 is out
                                    <span className="hidden sm:inline">
                                        {' '}
                                        · Read the announcement
                                    </span>
                                </span>
                                <ArrowRightIcon
                                    className="size-3.5 shrink-0 text-primary"
                                    aria-hidden="true"
                                />
                            </Link>
                        </div>
                        <h1 className="max-w-4xl font-mono text-[2.75rem] leading-[1.02] font-medium tracking-tight text-balance sm:text-6xl lg:text-7xl">
                            Your files, private. Without the homework.
                        </h1>
                        <div className="flex flex-col gap-8">
                            <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                                HushOS Drive keeps your files locked on your own devices, so nobody
                                else can read them, not even us. It works like any drive you have
                                used: drop files in, open them, share them. The privacy is built in,
                                not bolted on for you to manage.
                            </p>
                            <div className="flex flex-wrap gap-3">
                                {hasSession ? (
                                    <Button
                                        render={<Link to="/app" />}
                                        nativeButton={false}
                                        size="lg"
                                        data-cuelume-press="pulse"
                                    >
                                        Open Drive <ArrowRightIcon aria-hidden="true" />
                                    </Button>
                                ) : (
                                    <>
                                        <Button
                                            render={<Link to="/register" />}
                                            nativeButton={false}
                                            size="lg"
                                            data-cuelume-press="pulse"
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
                    </div>
                    <aside className="flex flex-col border-t lg:col-span-4 lg:border-t-0 lg:border-l">
                        <p className="eyebrow border-b px-5 py-4 text-muted-foreground">
                            At a glance
                        </p>
                        <dl className="flex-1 px-5 py-4 font-mono text-[13px]">
                            {facts.map(([key, value]) => (
                                <div
                                    key={key}
                                    className="flex justify-between gap-6 border-b border-dotted py-2.5 last:border-b-0"
                                >
                                    <dt className="eyebrow self-center text-muted-foreground">
                                        {key}
                                    </dt>
                                    <dd
                                        className={value.startsWith('Never') ? 'font-semibold' : ''}
                                    >
                                        {value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                        <Link
                            to="/about"
                            className="eyebrow flex items-center justify-between border-t px-5 py-4 text-foreground transition-colors hover:bg-muted"
                        >
                            Why we are building this{' '}
                            <ArrowRightIcon className="size-3.5 text-primary" aria-hidden="true" />
                        </Link>
                    </aside>
                </section>

                <section aria-label="Made to feel easy" className="grid border-b md:grid-cols-3">
                    {easy.map(({ title, detail }, index) => (
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

                <section aria-label="What it looks like" className="grid border-b lg:grid-cols-12">
                    <figure className="flex min-w-0 flex-col border-b bg-muted lg:col-span-8 lg:border-r lg:border-b-0">
                        <div className="flex-1 px-5 pt-8 sm:px-10">
                            <Shot
                                name="drive-wide"
                                width={2560}
                                height={1600}
                                alt="HushOS Drive in a browser: folders named Family, Finances, Recipes and Work, and a lease, a reading list and a trip plan, with a storage meter in the sidebar."
                            />
                        </div>
                        <figcaption className="px-5 py-4 text-sm text-muted-foreground sm:px-10">
                            Your drive on a computer. Folders, files, and how much room is left.
                        </figcaption>
                    </figure>
                    <figure className="flex min-w-0 flex-col bg-muted lg:col-span-4">
                        {/* The wide picture sets the row's height; the phone fills the same height. */}
                        <div className="relative min-h-[28rem] flex-1">
                            <Shot
                                name="phone-grid"
                                width={780}
                                height={1688}
                                alt="HushOS Drive on a phone, showing a folder of holiday photos as a grid of thumbnails."
                                className="absolute inset-x-8 top-8 bottom-0 flex justify-center"
                                imageClassName="h-full w-auto max-w-full"
                            />
                        </div>
                        <figcaption className="px-5 py-4 text-sm text-muted-foreground sm:px-10">
                            And on a phone, with the same files.
                        </figcaption>
                    </figure>
                </section>

                <section aria-labelledby="features-title" className="border-b">
                    <div className="grid border-b lg:grid-cols-12">
                        <div className="px-5 py-8 sm:px-10 lg:col-span-5 lg:border-r">
                            <p className="eyebrow text-muted-foreground">What you get</p>
                            <h2
                                id="features-title"
                                className="mt-4 text-2xl font-medium tracking-tight text-balance sm:text-3xl"
                            >
                                Everything a drive should do. Nothing you have to babysit.
                            </h2>
                        </div>
                        <p className="max-w-xl px-5 py-8 text-sm leading-relaxed text-pretty text-muted-foreground sm:px-10 lg:col-span-7">
                            Most privacy tools ask you to learn their rules first: key files to
                            keep, settings to get right, a second app to install. HushOS asks for an
                            email, a password and one phrase to keep safe. After that, it is just
                            your drive.
                        </p>
                    </div>
                    <div className="grid md:grid-cols-2 lg:grid-cols-4">
                        {features.map(({ title, detail }) => (
                            <article
                                key={title}
                                className="flex flex-col gap-3 border-b px-5 py-6 sm:px-10 md:border-r md:even:border-r-0 lg:border-r lg:even:border-r lg:nth-[4n]:border-r-0 lg:nth-last-[-n+4]:border-b-0"
                            >
                                <h3 className="text-base font-medium tracking-tight text-balance">
                                    {title}
                                </h3>
                                <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
                                    {detail}
                                </p>
                            </article>
                        ))}
                    </div>
                </section>

                <section
                    aria-labelledby="protection-title"
                    className="grid grid-cols-1 border-b lg:grid-cols-12"
                >
                    <div className="px-5 py-10 sm:px-10 lg:col-span-5 lg:border-r">
                        <p className="eyebrow text-muted-foreground">How it protects you</p>
                        <h2
                            id="protection-title"
                            className="mt-4 text-2xl font-medium tracking-tight text-balance sm:text-3xl"
                        >
                            Locked on your device. Stays locked everywhere else.
                        </h2>
                        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
                            You do not have to take our word for any of this. HushOS is open source,
                            so anyone can read the code, and the security page explains each step
                            for people who want the detail.
                        </p>
                        <Link
                            to="/security"
                            className="text-link mt-6 inline-flex items-center gap-2 text-sm"
                        >
                            Read the security model <ArrowRightIcon className="size-4" />
                        </Link>
                    </div>
                    <dl className="lg:col-span-7">
                        {protection.map(([term, detail]) => (
                            <div
                                key={term}
                                className="grid gap-2 border-b px-5 py-5 last:border-b-0 sm:grid-cols-12 sm:px-10"
                            >
                                <dt className="eyebrow text-muted-foreground sm:col-span-4">
                                    {term}
                                </dt>
                                <dd className="text-sm leading-relaxed text-pretty sm:col-span-8">
                                    {detail}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section
                    aria-labelledby="selfhost-title"
                    className="grid grid-cols-1 border-b lg:grid-cols-12"
                >
                    <div className="px-5 py-10 sm:px-10 lg:col-span-5 lg:border-r">
                        <p className="eyebrow text-muted-foreground">Prefer your own server?</p>
                        <h2
                            id="selfhost-title"
                            className="mt-4 text-2xl font-medium tracking-tight text-balance sm:text-3xl"
                        >
                            Run it yourself, for free.
                        </h2>
                        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
                            The same HushOS that runs here can run on a machine you control, for
                            you, your family or your team. It takes a few commands, and the guide
                            walks through each one.
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
                        <div className="flex items-center justify-between gap-4 border-b px-5 py-2 sm:px-10">
                            <p className="eyebrow text-muted-foreground">Terminal</p>
                            <CopyCommands />
                        </div>
                        <pre className="flex-1 overflow-x-auto px-5 py-6 font-mono text-[13px] leading-loose sm:px-10">
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
                            Questions people ask
                        </h2>
                    </div>
                    <Faq items={faq} />
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
