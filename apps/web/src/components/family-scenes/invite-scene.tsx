import type { Act } from '@/components/stageshow/act';
import {
    AppWindow,
    Checked,
    Dialog,
    FAMILY,
    FauxButton,
    Field,
    InviteMark,
    MAYA,
    PersonRow,
    Reveal,
    SAM,
    Section,
    Sidebar,
    JONAS,
    TechnicalSection,
    Title,
    Toast,
} from './faux';
import { Scene } from './scene';

/*
 * Inviting someone and letting them in. Beats: Invite someone, the address typed, Send
 * invitation; the invitation waits in its list; once Sam accepts, Sam waits to join, with Let
 * them in the page's one blue button; one click and Sam is a member. The poster is that end:
 * Sam under Members and the toast that says so.
 */

type S = {
    dialog: boolean;
    email: string;
    focus: boolean;
    invited: boolean;
    waiting: boolean;
    joined: boolean;
};

const initial: S = {
    dialog: false,
    email: '',
    focus: false,
    invited: false,
    waiting: false,
    joined: false,
};
const poster: S = { ...initial, email: SAM.email, joined: true };

async function script(a: Act<S>) {
    await a.wait(700);
    await a.click({ at: 'invite', x: 0.5, y: 0.55 });
    await a.set({ dialog: true });
    await a.wait(450);
    await a.click({ at: 'email', x: 0.3, y: 0.5 });
    await a.set({ focus: true });
    await a.type('email', SAM.email, { interval: 55 });
    await a.wait(300);
    await a.click({ at: 'send', x: 0.5, y: 0.55 });
    await a.set({ dialog: false, focus: false, invited: true });
    // Sam opens the email and accepts: the invitation becomes someone waiting to join.
    await a.wait(1800);
    await a.set({ invited: false, waiting: true });
    await a.wait(1100);
    await a.click({ at: 'let-in', x: 0.5, y: 0.55 });
    await a.set({ waiting: false, joined: true });
    await a.wait(2600);
}

export function InviteScene() {
    return (
        <Scene<S>
            label={`The page of ${FAMILY}, with Maya and Jonas in it. Invite someone opens a dialog; ${SAM.email} is typed and the invitation sent, and it waits under Invitations. Once Sam accepts from the email, Sam waits to join, with Let them in beside the name. One click, and Sam Ortega is under Members: “Sam is in ${FAMILY}”.`}
            height={400}
            compact={{ height: 470 }}
            initial={initial}
            poster={poster}
            script={script}
            cursor={{ at: { wide: { x: 660, y: 300 }, compact: { x: 300, y: 400 } } }}
        >
            {(s, _rect, layout) => {
                const compact = layout === 'compact';
                return (
                    <AppWindow
                        className="absolute inset-0"
                        sidebar={compact ? undefined : <Sidebar active="family" />}
                        overlay={
                            <>
                                <Dialog
                                    open={s.dialog}
                                    title="Invite someone"
                                    className={
                                        compact
                                            ? 'inset-x-3 top-16'
                                            : 'top-16 left-[216px] w-[400px]'
                                    }
                                    footer={
                                        <>
                                            <FauxButton variant="outline">Cancel</FauxButton>
                                            <FauxButton target="send">Send invitation</FauxButton>
                                        </>
                                    }
                                >
                                    <span className="flex flex-col gap-3">
                                        <span className="flex flex-col gap-1.5">
                                            <Field
                                                label="Email"
                                                value={s.email}
                                                focus={s.focus}
                                                target="email"
                                                placeholder="them@example.com"
                                            />
                                            <span className="text-[13px] text-muted-foreground">
                                                The invitation is open for 7 days.
                                            </span>
                                        </span>
                                        <span className="flex items-center gap-2.5 text-sm">
                                            <span className="size-[18px] rounded-xs border border-field bg-card" />
                                            Let them manage the family
                                        </span>
                                    </span>
                                </Dialog>
                                <Toast
                                    compact={compact}
                                    show={s.joined}
                                    title={`Sam is in ${FAMILY}`}
                                />
                            </>
                        }
                    >
                        <Title
                            actions={
                                <FauxButton
                                    variant={s.waiting ? 'outline' : 'default'}
                                    target="invite"
                                >
                                    Invite someone
                                </FauxButton>
                            }
                            description={`${s.joined ? 3 : 2} of 4 places taken.`}
                        >
                            {FAMILY}
                        </Title>
                        <span className="flex flex-col">
                            <Reveal open={s.waiting}>
                                <Section title="Waiting to join" className="pb-5">
                                    <PersonRow person={SAM} className="border-b-0">
                                        {!compact && (
                                            <FauxButton variant="ghost">Not now</FauxButton>
                                        )}
                                        <FauxButton target="let-in">Let them in</FauxButton>
                                    </PersonRow>
                                </Section>
                            </Reveal>
                            <Section title="Members">
                                <PersonRow person={MAYA} you badge="Organizer" />
                                <PersonRow person={JONAS}>
                                    <Checked verified />
                                </PersonRow>
                                <Reveal open={s.joined}>
                                    <PersonRow person={SAM}>
                                        <Checked verified={false} />
                                    </PersonRow>
                                </Reveal>
                            </Section>
                            <Reveal open={s.invited}>
                                <Section title="Invitations" className="pt-5">
                                    <PersonRow
                                        person={{ ...SAM, name: SAM.email }}
                                        mark={<InviteMark />}
                                        line="Open until 12 Nov"
                                        className="border-b-0"
                                    >
                                        {!compact && (
                                            <FauxButton variant="destructive-ghost">
                                                Cancel invitation
                                            </FauxButton>
                                        )}
                                    </PersonRow>
                                </Section>
                            </Reveal>
                            <TechnicalSection />
                        </span>
                    </AppWindow>
                );
            }}
        </Scene>
    );
}
