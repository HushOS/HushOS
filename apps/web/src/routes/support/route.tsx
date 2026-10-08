import { appEnv } from '@hushos/env/app';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import type { ReactNode } from 'react';
import { PageLink } from '@/components/page-link';
import { ReadingPage, type Heading } from '@/components/legal-layout';
import { pageSocialMeta, publicOrigin } from '@/lib/social';

/*
 * Where to get help, and who runs this instance: the page an app store asks
 * for as the support URL. Every detail comes from the instance's settings
 * (OPERATOR_*, HELP_CONTACT); what is not set is not shown, so a self-hoster's
 * copy never names HushOS, Inc.
 */

type Support = {
    email: string | null;
    name: string | null;
    jurisdiction: string | null;
    address: string[];
    phone: string | null;
};

const getSupportServerFn = createServerFn().handler((): Support => ({
    email: appEnv.HELP_CONTACT ?? appEnv.OPERATOR_CONTACT ?? null,
    name: appEnv.OPERATOR_NAME ?? null,
    jurisdiction: appEnv.OPERATOR_JURISDICTION ?? null,
    // Written with \n in an .env file, so the lines survive one-line settings.
    address: (appEnv.OPERATOR_ADDRESS ?? '')
        // Line breaks written as \n, as \\n (a .env or compose file that escapes the backslash), or real ones.
        .split(/\\+n|\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    phone: appEnv.OPERATOR_PHONE ?? null,
}));

const supportQueryOptions = queryOptions({
    queryKey: ['support'],
    queryFn: () => getSupportServerFn(),
    staleTime: Infinity,
});

const headings: Heading[] = [
    { id: 'get-help', title: 'Get help' },
    { id: 'password', title: 'If you forget your password' },
    { id: 'delete-account', title: 'Delete your account' },
    { id: 'more', title: 'Answers and policies' },
    { id: 'who', title: 'Who runs this service' },
];

export const Route = createFileRoute('/support')({
    loader: async ({ context }) => {
        await context.queryClient.ensureQueryData(supportQueryOptions);
        return { origin: publicOrigin() };
    },
    head: ({ loaderData }) => ({
        meta: loaderData
            ? pageSocialMeta({
                  origin: loaderData.origin,
                  path: '/support',
                  title: 'Support',
                  description: 'How to get help with HushOS, and who runs it.',
              })
            : [{ title: 'Support · HushOS' }],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/support` }] : [],
    }),
    component: SupportPage,
});

const h2 =
    'mt-12 scroll-mt-24 text-2xl leading-tight font-extrabold tracking-[-0.02em] text-balance first:mt-4 sm:text-[28px]';
const p = 'mt-4 leading-relaxed';
/* The phone and email belong to the address, so ink like its lines; the underline says they can be tapped. */
const contactLink =
    'underline decoration-1 underline-offset-4 transition-colors hover:text-primary-hover';

function Section({ id, children }: { id: string; children: ReactNode }) {
    const title = headings.find((heading) => heading.id === id)!.title;
    return (
        <section aria-labelledby={id}>
            <h2 id={id} className={h2}>
                {title}
            </h2>
            {children}
        </section>
    );
}

function SupportPage() {
    const { data: support } = useQuery(supportQueryOptions);
    const email = support?.email ?? null;
    return (
        <ReadingPage
            eyebrow="Support"
            title="Get help with HushOS"
            summary="Write to us, get back into your account, or find out who runs this service."
            headings={headings}
        >
            <Section id="get-help">
                {email ? (
                    <p className={p}>
                        Write to{' '}
                        <a href={`mailto:${email}`} className="text-link">
                            {email}
                        </a>
                        . Say which app you use (web, iPhone or Android) and what happened. Never
                        send your password or your recovery words: nobody here will ever ask for
                        them.
                    </p>
                ) : (
                    <p className={p}>
                        This server hasn’t set a support address. Ask whoever gave you your account.
                    </p>
                )}
            </Section>
            <Section id="password">
                <p className={p}>
                    Choose “Forgot your password?” when you{' '}
                    <PageLink to="/login" className="text-link">
                        sign in
                    </PageLink>
                    , on the web or in the app, and confirm your email. Then use your recovery kit:
                    its file, the code printed on it, or its 24 words. Nobody else can do this for
                    you, because nobody else has your keys.
                </p>
            </Section>
            <Section id="delete-account">
                <p className={p}>
                    You can delete your HushOS account yourself, at any time. On the web, open
                    Account and choose Delete account. In the iPhone or Android app, open the
                    Account tab and choose Delete account. You type your password and the word
                    DELETE to confirm.
                </p>
                <p className={p}>
                    Your files, folders, versions, shares, links and keys are deleted, your sessions
                    end on every device, and any paid plan is cancelled. What the apps kept on a
                    phone is removed from it. The{' '}
                    <PageLink to="/privacy#8-how-long-data-is-kept" className="text-link">
                        privacy policy
                    </PageLink>{' '}
                    says how long anything else is kept.
                </p>
                {email && (
                    <p className={p}>
                        If you can’t sign in to do it, write to{' '}
                        <a href={`mailto:${email}`} className="text-link">
                            {email}
                        </a>{' '}
                        from the address on the account.
                    </p>
                )}
            </Section>
            <Section id="more">
                <p className={p}>
                    How your files are protected is on the{' '}
                    <PageLink to="/security" className="text-link">
                        security page
                    </PageLink>
                    . What is stored, and for how long, is in the{' '}
                    <PageLink to="/privacy" className="text-link">
                        privacy policy
                    </PageLink>
                    , and the rules are in the{' '}
                    <PageLink to="/terms" className="text-link">
                        terms
                    </PageLink>
                    .
                </p>
            </Section>
            <Section id="who">
                {support?.name ? (
                    <address className="mt-4 leading-relaxed not-italic">
                        <span className="block font-semibold">
                            {support.name}
                            {support.jurisdiction && `, ${support.jurisdiction}`}
                        </span>
                        {support.address.map((line) => (
                            <span key={line} className="block">
                                {line}
                            </span>
                        ))}
                        {support.phone && (
                            <span className="mt-2 block">
                                <a
                                    href={`tel:${support.phone.replace(/[^+0-9]/g, '')}`}
                                    className={contactLink}
                                >
                                    {support.phone}
                                </a>
                            </span>
                        )}
                        {email && (
                            <span className="block">
                                <a href={`mailto:${email}`} className={contactLink}>
                                    {email}
                                </a>
                            </span>
                        )}
                    </address>
                ) : (
                    <p className={p}>
                        This copy of HushOS is run by whoever hosts this server; it hasn’t named
                        itself here.
                    </p>
                )}
            </Section>
        </ReadingPage>
    );
}
