import { cn } from 'cn';
import { Spinner } from '@/components/motion';
import type { Act } from '@/components/stageshow/act';
import { segmentOn, segmentTrack } from '@/components/ui/segment';
import {
    AppWindow,
    Dialog,
    FAMILY,
    FauxButton,
    Field,
    MAYA,
    PersonRow,
    Section,
    QuietSection,
    Title,
    Toast,
} from './faux';
import { Scene } from './scene';

/*
 * Creating a family and choosing its plan. It opens on Create a family's dialog, already open over
 * the Family page (a page that is mostly empty until there is a family); the name is typed, Create
 * family makes it; the family's page asks for a plan first, Family Pro is chosen,
 * and back from Polar's checkout the plan is on. The payoff (the poster) is the family's page with
 * its plan, and the toast that says so. Polar's own page is left out: it is someone else's.
 */

type S = {
    dialog: boolean;
    name: string;
    focus: boolean;
    created: boolean;
    paying: boolean;
    paid: boolean;
};

const initial: S = {
    dialog: true,
    name: '',
    focus: false,
    created: false,
    paying: false,
    paid: false,
};
const poster: S = { ...initial, dialog: false, name: FAMILY, created: true, paid: true };

async function script(a: Act<S>) {
    await a.wait(900);
    await a.click({ at: 'name', x: 0.3, y: 0.5 });
    await a.set({ focus: true });
    await a.type('name', FAMILY, { interval: 60 });
    await a.wait(350);
    await a.click({ at: 'make', x: 0.5, y: 0.55 });
    await a.set({ dialog: false, focus: false, created: true });
    await a.wait(1400);
    await a.click({ at: 'pro', x: 0.5, y: 0.55 });
    await a.set({ paying: true });
    await a.wait(1300);
    await a.set({ paying: false, paid: true });
    await a.wait(2400);
}

const TIERS = [
    { name: 'Family Plus', size: '800 GB', price: '$10 a month' },
    { name: 'Family Pro', size: '2 TB', price: '$20 a month', lead: true },
    { name: 'Family Max', size: '4 TB', price: '$30 a month' },
];

/* Choose a plan, as a new family's page puts it first: the period, then the three tiers. */
function ChoosePlan({ compact }: { compact: boolean }) {
    return (
        <Section
            title="Choose a plan"
            description={`Choose a plan before you invite anyone to ${FAMILY} or make family folders. Until then, only you are in it.`}
        >
            <span className={cn('mt-3 flex w-fit gap-1 rounded-md p-1 text-[13px]', segmentTrack)}>
                <span className={cn('rounded-sm px-3 py-1.5 font-bold', segmentOn)}>Monthly</span>
                <span className="px-3 py-1.5 font-medium text-muted-foreground">
                    Yearly · 2 months free
                </span>
            </span>
            <span className={cn('mt-3 grid gap-2.5', !compact && 'grid-cols-3')}>
                {TIERS.map((tier) =>
                    compact ? (
                        <span
                            key={tier.name}
                            className="flex items-center justify-between gap-3 rounded-xl border border-rule px-3 py-2.5"
                        >
                            <span className="flex flex-col gap-0.5">
                                <span className="text-sm font-bold">
                                    {tier.name} · {tier.size}
                                </span>
                                <span className="text-[13px] text-muted-foreground">
                                    {tier.price}
                                </span>
                            </span>
                            <FauxButton
                                size="sm"
                                variant={tier.lead ? 'default' : 'outline'}
                                target={tier.lead ? 'pro' : undefined}
                            >
                                Choose
                            </FauxButton>
                        </span>
                    ) : (
                        <span
                            key={tier.name}
                            className="flex flex-col gap-2 rounded-xl border border-rule p-3.5"
                        >
                            <span className="text-[15px] font-bold">{tier.name}</span>
                            <span className="text-[22px] leading-none font-extrabold tracking-[-0.02em]">
                                {tier.size}
                            </span>
                            <span className="text-[13px] font-semibold">{tier.price}</span>
                            <FauxButton
                                variant={tier.lead ? 'default' : 'outline'}
                                target={tier.lead ? 'pro' : undefined}
                                className="mt-1 w-full"
                            >
                                Choose {tier.name}
                            </FauxButton>
                        </span>
                    ),
                )}
            </span>
            <span className="mt-3 text-[13px] text-muted-foreground">
                Plus tax where it applies; Polar adds it at checkout. Payments are handled by Polar.
            </span>
        </Section>
    );
}

/* What the server learns from a family, at the foot of the families pages, as the app says it. */
function ServerKnows() {
    return (
        <span className="mt-auto px-6 pb-5 text-[13px] leading-snug text-muted-foreground">
            HushOS’s server knows the family’s name, who is in it and what each person can do, who
            invited and let in whom, and how many family folders there are and roughly how big. It
            can’t open family folders.
        </span>
    );
}

export function CreateFamilyScene() {
    return (
        <Scene<S>
            label={`Creating a family in HushOS. In the Create a family dialog, the name ${FAMILY} is typed and the family is made. Its page then asks for a plan before anyone can be invited: Family Plus, 800 GB for $10 a month; Family Pro, 2 TB for $20; Family Max, 4 TB for $30. Choosing Family Pro and paying ends on the family's page with its plan: “Payment received. Family Pro (monthly) is on”.`}
            height={430}
            compact={{ height: 520 }}
            initial={initial}
            poster={poster}
            script={script}
            cursor={{ at: { wide: { x: 620, y: 330 }, compact: { x: 300, y: 360 } } }}
        >
            {(s, _rect, layout) => {
                const compact = layout === 'compact';
                return (
                    <AppWindow
                        className="inset-0"
                        overlay={
                            <>
                                <Dialog
                                    open={s.dialog}
                                    title="Create a family"
                                    description="You’ll be its organizer. Then choose a plan and invite people by email."
                                    className={
                                        compact
                                            ? 'inset-x-3 top-16'
                                            : 'top-14 left-[180px] w-[400px]'
                                    }
                                    footer={
                                        <>
                                            <FauxButton variant="outline">Cancel</FauxButton>
                                            <FauxButton target="make">Create family</FauxButton>
                                        </>
                                    }
                                >
                                    <span className="flex flex-col gap-1.5">
                                        <Field
                                            label="Name"
                                            value={s.name}
                                            focus={s.focus}
                                            target="name"
                                            placeholder="Lindqvist family"
                                        />
                                        <span className="text-[13px] text-muted-foreground">
                                            Everyone you invite sees this name, and so does the
                                            server.
                                        </span>
                                    </span>
                                </Dialog>
                                <Toast
                                    compact={compact}
                                    show={s.paid}
                                    title="Payment received. Family Pro (monthly) is on"
                                    description="You can invite people now."
                                />
                            </>
                        }
                    >
                        {/* No family yet: Family, and Create a family, the page's one blue button. */}
                        <span
                            className={cn(
                                'absolute inset-0 flex flex-col transition-opacity duration-300',
                                s.created && 'opacity-0',
                            )}
                        >
                            <Title
                                actions={
                                    !compact && (
                                        <FauxButton target={compact ? undefined : 'create'}>
                                            Create a family
                                        </FauxButton>
                                    )
                                }
                                description="A family shares one plan’s storage, for everyone’s own files and the family folders. You can be in one family."
                            >
                                Family
                            </Title>
                            {compact && (
                                <span className="px-6">
                                    <FauxButton target="create">Create a family</FauxButton>
                                </span>
                            )}
                            <Section
                                title="Invitations"
                                description="Someone in a family invites you by email, and you join from the link in it."
                                className="mt-4"
                            >
                                <span className="py-3 text-sm text-muted-foreground">
                                    No invitations right now.
                                </span>
                            </Section>
                            <ServerKnows />
                        </span>

                        {/* The family's page: the plan first, then, once it's on, its members. */}
                        <span
                            className={cn(
                                'absolute inset-0 flex flex-col transition-opacity duration-300',
                                !s.created && 'opacity-0',
                            )}
                        >
                            <Title
                                actions={
                                    !compact && (
                                        <>
                                            <FauxButton variant="outline">
                                                Family folders
                                            </FauxButton>
                                            {s.paid && <FauxButton>Invite someone</FauxButton>}
                                        </>
                                    )
                                }
                                description={s.paid ? '1 of 4 places taken.' : undefined}
                            >
                                {FAMILY}
                            </Title>
                            <span className="relative flex-1">
                                <span
                                    className={cn(
                                        'absolute inset-x-0 top-0 transition-opacity duration-300',
                                        (s.paying || s.paid) && 'opacity-0',
                                    )}
                                >
                                    <ChoosePlan compact={compact} />
                                </span>
                                <span
                                    className={cn(
                                        'absolute inset-x-6 top-0 flex items-center gap-2 rounded-xl bg-tint px-4 py-3 text-sm text-on-tint transition-opacity duration-300',
                                        !s.paying && 'opacity-0',
                                    )}
                                >
                                    <Spinner className="size-3.5" />
                                    Finishing your payment…
                                </span>
                                <span
                                    className={cn(
                                        'absolute inset-x-0 top-0 flex flex-col gap-5 transition-opacity duration-300',
                                        !s.paid && 'opacity-0',
                                    )}
                                >
                                    <Section title="Members">
                                        <PersonRow person={MAYA} you badge="Organizer" />
                                    </Section>
                                    <Section title="Billing">
                                        <span className="grid grid-cols-[6rem_1fr] gap-y-1 py-3 text-sm">
                                            <span className="font-semibold">Plan</span>
                                            <span className="flex flex-col">
                                                <span>Family Pro · 2 TB</span>
                                                <span className="text-[13px] text-muted-foreground">
                                                    $20 a month · renews 5 Dec
                                                </span>
                                            </span>
                                        </span>
                                    </Section>
                                    <QuietSection title="Storage" />
                                </span>
                            </span>
                        </span>
                    </AppWindow>
                );
            }}
        </Scene>
    );
}
