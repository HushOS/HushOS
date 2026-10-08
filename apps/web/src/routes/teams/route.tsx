import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { cn } from 'cn';
import { Shot } from '@/components/screenshot';
import { container, H1, H2, Lede, StartFree, TalkToUs, TextLink } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { catalogueQueryOptions } from '@/lib/queries';
import { pageSocialMeta, publicOrigin, salesContactQueryOptions } from '@/lib/social';

/*
 * For teams: what a small team can do with HushOS today, and, separately and
 * plainly, what is coming. One action: talk to us, where this server has
 * someone to talk to; otherwise start free and share a folder. Nothing here is
 * for sale until a team plan exists, and the page exists only where plans do.
 */

export const Route = createFileRoute('/teams')({
    loader: async ({ context }) => {
        const catalogue = await context.queryClient.ensureQueryData(catalogueQueryOptions);
        if (!catalogue.enabled) throw notFound();
        await context.queryClient.ensureQueryData(salesContactQueryOptions);
        return { origin: publicOrigin() };
    },
    head: ({ loaderData }) => {
        const description =
            'Share folders with the people you work with. Everything is locked on your devices first, so nobody outside the team can open it.';
        return {
            meta: loaderData
                ? pageSocialMeta({
                      origin: loaderData.origin,
                      path: '/teams',
                      card: 'teams',
                      title: 'For teams',
                      description,
                  })
                : [{ title: 'HushOS for teams' }],
            links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/teams` }] : [],
        };
    },
    component: TeamsPage,
});

const today = [
    {
        title: 'Share a folder, choose what each person can do',
        body: 'Add a colleague to a folder as someone who can view or someone who can edit. What an editor uploads counts against the owner’s space.',
    },
    {
        title: 'See who can open everything',
        body: 'Every file and folder in the list says who can open it. A link anyone can open is marked in its own colour, so it never hides.',
    },
    {
        title: 'Links for clients and suppliers',
        body: 'Send a link to someone without an account. Add a password or an end date, see how often it was opened, and turn it off when the job is done.',
    },
    {
        title: 'Stop sharing, and mean it',
        body: 'When someone leaves, stop sharing with them. They’re refused straight away, and the folder’s keys change so what they had stops opening.',
    },
    {
        title: 'Kept in the EU',
        body: 'The service we run keeps its servers and your files in the European Union.',
    },
    {
        title: 'Or run it on your own server',
        body: 'HushOS is open source. Run your own copy for the whole team, free, with as much space as your server has.',
    },
];

const coming = [
    'A team plan with one bill for everyone',
    'Folders that belong to the team, not to whoever made them',
    'Adding and removing people from one place',
    'Desktop apps',
];

function TeamsPage() {
    const { data: contact } = useQuery(salesContactQueryOptions);
    // Without anyone to write to, the page's action is the one that works today.
    const action = (className: string) =>
        contact ? <TalkToUs className={className} /> : <StartFree className={className} />;
    return (
        <div className="flex min-h-svh flex-col bg-card">
            <SiteHeader />
            <main className="flex-1">
                <section className={cn(container, 'pt-10 pb-10 lg:pt-20 lg:pb-16')}>
                    <div className="grid items-center gap-10 lg:grid-cols-[1fr_minmax(0,30rem)] lg:gap-12">
                        <div className="flex max-w-[620px] flex-col gap-6">
                            <H1 className="lg:text-[56px]">Private files for small teams.</H1>
                            <Lede>
                                Share folders with the people you work with, the way you already do.
                                Everything is locked on your devices first, so nobody outside the
                                team can open it. That includes us.
                            </Lede>
                            <div className="flex flex-col gap-3 pt-1">
                                {action('w-full sm:w-fit')}
                                <span className="text-[15px] text-muted-foreground">
                                    Sharing works on every plan, including Free, today.
                                </span>
                            </div>
                        </div>
                        <figure className="max-lg:hidden">
                            <Shot
                                name="drive-wide"
                                width={2560}
                                height={1600}
                                sizes="30rem"
                                alt="HushOS Drive in a browser: shared folders, each saying who can open it."
                            />
                        </figure>
                    </div>
                </section>

                <section aria-labelledby="today-title" className="bg-muted/60">
                    <div className={cn(container, 'py-14 lg:py-20')}>
                        <H2 id="today-title">What your team can do today</H2>
                        <div className="mt-8 grid gap-6 lg:grid-cols-3 lg:gap-x-12 lg:gap-y-10">
                            {today.map((item) => (
                                <div
                                    key={item.title}
                                    className="flex flex-col gap-2 border-t border-rule pt-5"
                                >
                                    <h3 className="text-lg leading-snug font-bold text-balance">
                                        {item.title}
                                    </h3>
                                    <p className="text-[15px] leading-[1.6] text-pretty text-muted-foreground">
                                        {item.body}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <section
                    aria-labelledby="coming-title"
                    className={cn(
                        container,
                        'grid items-start gap-6 py-14 lg:grid-cols-[5fr_7fr] lg:gap-16 lg:py-20',
                    )}
                >
                    <div className="flex flex-col gap-3">
                        <H2 id="coming-title">Coming soon</H2>
                        <p className="max-w-[26.5em] text-[17px] leading-[1.6] text-muted-foreground">
                            These are planned, not for sale. If your team needs one of them, tell
                            us; it helps us decide what comes first.
                        </p>
                    </div>
                    <ul className="flex flex-col border-t border-rule">
                        {coming.map((line) => (
                            <li
                                key={line}
                                className="border-b border-rule py-4 text-[17px] font-semibold"
                            >
                                {line}
                            </li>
                        ))}
                    </ul>
                </section>

                <section className="border-t border-rule">
                    <div
                        className={cn(
                            container,
                            'flex flex-col gap-6 py-14 lg:flex-row lg:items-center lg:justify-between lg:py-20',
                        )}
                    >
                        <div className="flex flex-col gap-3">
                            <H2>
                                {contact ? 'Tell us about your team.' : 'Try it with your team.'}
                            </H2>
                            <p className="max-w-[34.5em] text-[17px] text-muted-foreground">
                                {contact
                                    ? 'How many people, what you keep, and what you use now. We’ll write back when the team plan is ready.'
                                    : 'Start free, make a folder, and share it with the people you work with.'}
                            </p>
                            <TextLink to="/pricing">Compare plans</TextLink>
                        </div>
                        {action('w-full lg:w-auto')}
                    </div>
                </section>
            </main>
            <SiteFooter />
        </div>
    );
}
