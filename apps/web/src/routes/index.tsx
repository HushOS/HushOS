import { publicOrigin, publicSocialMeta, structuredData } from '@/lib/social';
import { createFileRoute, Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowRightIcon, CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Phones, Shot } from '@/components/screenshot';
import { container, Faq, H1, H2, Lede, StartFree, TextLink } from '@/components/site';
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
            variant="ghost"
            size="sm"
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
 * The front page, written for someone who has never thought about encryption
 * and does not want to. One promise, the product itself, three facts a person
 * can check, four steps, the self-hosting door, the questions people ask, and
 * the same single action again. The cryptography is one click away, on the
 * security page, for the people who want it.
 */

const faq = [
    {
        q: 'Do I need to understand encryption to use this?',
        a: 'No. You sign up with an email and a password, and everything else happens for you. The one extra step is saving a 24-word recovery phrase. That phrase gets you back in if you ever forget your password.',
    },
    {
        q: 'What happens if I forget my password?',
        a: 'You set a new one with your recovery kit and a link we email you. Your files stay exactly as they were. Without the kit nobody can get in, including us, which is why we ask you to keep it somewhere safe.',
    },
    {
        q: 'Can the people running HushOS see my files?',
        a: 'No. Your files and their names are locked on your device before they are uploaded, and only your devices hold the keys. What we can see is your email, how much space you use, and when.',
    },
    {
        q: 'Can I share with people who don’t use HushOS?',
        a: 'Yes. Make a link and anyone with it can open the file or folder in their browser, with no account. Add a password or an end date if you like, and turn the link off whenever you want.',
    },
    {
        q: 'Does it work on my phone?',
        a: 'Yes. Open HushOS in your phone’s browser and add it to your home screen, and it works like an app. Your files are the same everywhere.',
    },
    {
        q: 'Can my team use it?',
        a: 'Yes, today: share a folder with each person, as someone who can view or someone who can edit. A plan made for teams, with one bill, is coming.',
    },
    {
        q: 'Why should I care if I have nothing to hide?',
        a: 'Because it isn’t about hiding. Your files are your medical letters, your children’s photos, your lease, your half-written plans. When a service can read them, they get read: by systems that sort and profile you, by whoever breaks in, by models trained on whatever they can reach. Privacy just means those things stay yours.',
    },
    {
        q: 'What does it cost?',
        a: 'It starts free, and inviting a friend gives you both more space. Paid plans add space and nothing else; every plan is protected the same way. You can also run HushOS on your own server for free.',
    },
];

const facts = [
    {
        title: 'You can see who has access',
        body: 'Every file and folder says who can open it: only you, the people you chose, or anyone with the link. Stop sharing, and what you shared stops opening for them.',
    },
    {
        title: 'Kept in the EU',
        body: 'The service we run keeps its servers and your files in the European Union. Or run HushOS yourself and keep it wherever you like.',
    },
    {
        title: 'Open for anyone to check',
        body: 'All of HushOS is open source under the AGPL: the app and the server. Anyone can read how it works, and anyone can run their own.',
    },
];

const steps = [
    {
        title: 'You add a file',
        body: 'Your phone or computer locks it before it goes anywhere. The key to that lock is made on your device and stays with you.',
    },
    {
        title: 'We keep it',
        body: 'What reaches us is scrambled. We can store it and hand it back, but we can’t open it, and neither can anyone who breaks in.',
    },
    {
        title: 'You open it, or someone you chose does',
        body: 'It is unlocked on the screen in front of you and nowhere else. Sharing gives that one person their own key, from your device to theirs.',
    },
    {
        title: 'If you forget your password',
        body: 'The recovery kit you saved when you signed up gets you back in. Without it nobody can, including us. That is the one trade for real privacy.',
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
    const { billingEnabled } = Route.useRouteContext();
    const latest = posts[0];
    return (
        <div className="flex min-h-svh flex-col bg-card">
            <SiteHeader />
            <main className="flex-1">
                <section className={cn(container, 'pt-8 pb-8 lg:pt-14 lg:pb-14')}>
                    <div className="flex max-w-[860px] flex-col gap-6">
                        {/* A plain link, not a pill: the announcement is news, not a badge. */}
                        <Link
                            to="/blog/$slug"
                            params={{ slug: 'hushos-1-0' }}
                            className="inline-flex w-fit items-center gap-1.5 text-[15px] font-semibold text-primary underline-offset-4 hover:text-primary-hover hover:underline"
                        >
                            HushOS 1.0 is out
                            <ArrowRightIcon className="size-4 shrink-0" aria-hidden="true" />
                        </Link>
                        <H1>Nobody else can look inside.</H1>
                        <Lede>
                            HushOS Drive keeps your photos and documents, and the folders you share
                            with family or your team. It works like the drive you already use,
                            except everything is locked on your device first. We can’t open it.
                            Neither can anyone else.
                        </Lede>
                        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
                            <StartFree className="w-full sm:w-auto" />
                            {billingEnabled && (
                                <TextLink to="/teams" className="max-sm:self-center">
                                    HushOS for your team
                                </TextLink>
                            )}
                        </div>
                    </div>
                </section>

                <section aria-label="What it looks like" className={container}>
                    <figure className="flex flex-col gap-4">
                        {/*
                         * The same folder in the browser and in the two phone apps. The iPhone stands
                         * over the browser's sidebar; the Android phone beside it, overlapping only the
                         * window's margin, so no photo in the grid is hidden.
                         */}
                        <div className="relative max-md:hidden md:pr-[15.5%] md:pb-14 md:pl-20">
                            <Shot
                                name="drive-grid"
                                priority
                                width={2560}
                                height={1600}
                                sizes="(min-width: 72rem) 62rem, 88vw"
                                className="block overflow-hidden rounded-xl border border-rule shadow-lg"
                                alt="The Lisbon 2026 folder in a browser: twelve photos as a grid, under a line saying you, Jonas and anyone with the link can open everything in it."
                            />
                            <Phones
                                screen="folder"
                                sizes="12rem"
                                priority
                                alt="The same folder of photos as a grid, and who can open it"
                                className="absolute inset-x-0 bottom-0 flex items-end justify-between"
                                phoneClassName="w-[17%] max-w-52"
                            />
                        </div>
                        <div className="flex justify-center rounded-xl bg-muted px-4 py-6 md:hidden">
                            <Phones
                                screen="folder"
                                sizes="10rem"
                                priority
                                alt="The same folder of photos as a grid, and who can open it"
                                phoneClassName="w-[44%] max-w-48"
                            />
                        </div>
                        <figcaption className="max-w-[70ch] text-[15px] leading-relaxed text-muted-foreground">
                            Your drive in a browser and in the apps for iPhone and Android. Photos,
                            PDFs, video and Office files open right there. Deleted things wait in
                            the trash for 30 days, and replacing a file keeps the one before.
                        </figcaption>
                    </figure>
                </section>

                <section className={cn(container, 'py-14 lg:py-24')}>
                    <div className="grid gap-8 lg:grid-cols-3 lg:gap-12">
                        {facts.map((fact) => (
                            <div
                                key={fact.title}
                                className="flex flex-col gap-2 border-t border-rule pt-5"
                            >
                                <h2 className="text-xl leading-snug font-bold text-balance">
                                    {fact.title}
                                </h2>
                                <p className="text-base leading-[1.6] text-pretty text-muted-foreground">
                                    {fact.body}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>

                <section aria-labelledby="how-title" className="bg-muted/60">
                    <div
                        className={cn(
                            container,
                            'grid gap-8 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-24',
                        )}
                    >
                        <div className="flex flex-col gap-4">
                            <H2 id="how-title">How it works</H2>
                            <p className="max-w-[44ch] text-[17px] leading-[1.6] text-muted-foreground">
                                You don’t have to take our word for it. The code is public, and the
                                security page goes through every step, in plain words first.
                            </p>
                            <TextLink to="/security">How we protect your files</TextLink>
                        </div>
                        <ol className="flex flex-col">
                            {steps.map((step, index) => (
                                <li
                                    key={step.title}
                                    className="grid grid-cols-[28px_1fr] gap-x-5 border-b border-rule py-5 first:pt-0 last:border-b-0 lg:grid-cols-[36px_1fr]"
                                >
                                    <span className="pt-0.5 text-lg font-bold text-muted-foreground tabular-nums">
                                        {index + 1}
                                    </span>
                                    <span className="flex flex-col gap-1">
                                        <span className="text-lg font-bold">{step.title}</span>
                                        <span className="text-base leading-[1.6] text-pretty text-muted-foreground">
                                            {step.body}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </div>
                </section>

                <section
                    aria-labelledby="self-host-title"
                    className={cn(
                        container,
                        'grid items-start gap-8 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-24',
                    )}
                >
                    <div className="flex flex-col gap-4">
                        <H2 id="self-host-title">Run it on your own server, for free.</H2>
                        <p className="max-w-[44ch] text-[17px] leading-[1.6] text-muted-foreground">
                            The same HushOS that runs here can run on a machine you control, for
                            you, your family or your team. It takes four commands, and the guide
                            walks through each one.
                        </p>
                        <TextLink href="https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md">
                            Read the self-hosting guide
                        </TextLink>
                    </div>
                    <div className="min-w-0 overflow-hidden rounded-xl border border-rule bg-muted">
                        <div className="flex h-12 items-center justify-between border-b border-rule pr-2 pl-4">
                            <span className="text-sm font-semibold text-muted-foreground">
                                Terminal
                            </span>
                            <CopyCommands />
                        </div>
                        <pre className="overflow-x-auto px-4 py-4 font-mono text-xs leading-[2] sm:text-sm">
                            <code>
                                {commands.map((command, index) => (
                                    <span key={command}>
                                        <span className="text-muted-foreground select-none">
                                            ${' '}
                                        </span>
                                        {command}
                                        {index < commands.length - 1 ? '\n' : ''}
                                    </span>
                                ))}
                            </code>
                        </pre>
                    </div>
                </section>

                {latest && (
                    <section aria-labelledby="blog-title" className="border-t border-rule">
                        <div className={cn(container, 'flex flex-col gap-2 py-10 lg:py-14')}>
                            <h2 id="blog-title" className="text-[15px] text-muted-foreground">
                                From the blog · {formatDate(latest.meta.date)}
                            </h2>
                            <Link
                                to="/blog/$slug"
                                params={{ slug: latest.slug }}
                                className="group inline-flex w-fit items-baseline gap-3 text-2xl font-bold tracking-tight text-balance hover:text-primary"
                            >
                                {latest.meta.title}
                                <ArrowRightIcon
                                    className="size-5 shrink-0 self-center text-primary transition-transform group-hover:translate-x-0.5"
                                    aria-hidden="true"
                                />
                            </Link>
                        </div>
                    </section>
                )}
                <section aria-labelledby="faq-title" className="border-t border-rule">
                    <div
                        className={cn(
                            container,
                            'grid items-start gap-6 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-24',
                        )}
                    >
                        <H2 id="faq-title">Questions people ask</H2>
                        <Faq items={faq} />
                    </div>
                </section>

                <section className="border-t border-rule">
                    <div
                        className={cn(
                            container,
                            'flex flex-col gap-6 py-14 lg:flex-row lg:items-center lg:justify-between lg:py-20',
                        )}
                    >
                        <div className="flex flex-col gap-3">
                            <H2>Try it with your own files.</H2>
                            <p className="text-[17px] text-muted-foreground">
                                {billingEnabled
                                    ? 'Free to start, no card needed. Pay only if you want more room.'
                                    : 'Make an account and drop your first files in.'}
                            </p>
                        </div>
                        <StartFree className="w-full lg:w-auto" />
                    </div>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
