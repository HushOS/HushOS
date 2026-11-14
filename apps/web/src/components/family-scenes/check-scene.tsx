import { cn } from 'cn';
import { EllipsisIcon } from 'lucide-react';
import type { Act } from '@/components/stageshow/act';
import {
    AppWindow,
    Checked,
    FAMILY,
    FauxButton,
    MAYA,
    PersonRow,
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
 * Checking each other. Maya opens Check it's Sam, Sam opens Check it's Maya on their own screen,
 * and the twelve words are read across, one at a time on both, until They match. Then Sam's row
 * says Verified. The poster is the comparison itself: the same twelve words on both screens,
 * which is the point; the label says how it ends.
 */

/* Twelve words from the list the app draws them from (BIP-39's English words). */
const WORDS = [
    'orchard',
    'velvet',
    'timber',
    'glance',
    'harbor',
    'pencil',
    'autumn',
    'rescue',
    'lunar',
    'cabin',
    'shallow',
    'cotton',
];

type S = { menu: boolean; open: boolean; reading: number; matched: boolean };

const initial: S = { menu: false, open: false, reading: -1, matched: false };
const poster: S = { menu: false, open: true, reading: -1, matched: false };

async function script(a: Act<S>) {
    await a.wait(600);
    await a.click({ at: 'more', x: 0.5, y: 0.5 });
    await a.set({ menu: true });
    await a.wait(400);
    await a.click({ at: 'check', x: 0.35, y: 0.5 });
    await a.set({ menu: false, open: true });
    await a.wait(900);
    // Read aloud, a word at a time, the same word lit on both screens.
    for (let index = 0; index < WORDS.length; index++) {
        await a.set({ reading: index });
        await a.wait(260);
    }
    await a.set({ reading: -1 });
    await a.wait(400);
    await a.click({ at: 'match', x: 0.5, y: 0.55 });
    await a.set({ open: false, matched: true });
    await a.wait(2600);
}

function Words({ reading, small = false }: { reading: number; small?: boolean }) {
    return (
        <span className={cn('grid gap-1.5', small ? 'grid-cols-2' : 'grid-cols-3')}>
            {WORDS.map((word, index) => (
                <span
                    key={word}
                    className={cn(
                        'flex items-baseline gap-1.5 rounded-md px-2 transition-colors duration-150',
                        small ? 'py-1' : 'py-1.5',
                        index === reading ? 'bg-tint text-on-tint' : 'bg-muted',
                    )}
                >
                    <span className="w-3.5 text-right text-[10px] text-muted-foreground tabular-nums">
                        {index + 1}
                    </span>
                    <span className={cn('font-medium', small ? 'text-[12px]' : 'text-[13px]')}>
                        {word}
                    </span>
                </span>
            ))}
        </span>
    );
}

/* A check's dialog surface: its title, a sentence, the words and its two answers. */
function CheckCard({
    title,
    description,
    reading,
    small = false,
    open,
    className,
    target,
}: {
    title: string;
    description?: string;
    reading: number;
    small?: boolean;
    open: boolean;
    className: string;
    target?: string;
}) {
    return (
        <span
            className={cn(
                'absolute flex flex-col gap-3.5 rounded-2xl border border-edge bg-popover text-popover-foreground shadow-xl transition-[opacity,scale] duration-200 ease-out-soft',
                small ? 'p-4' : 'p-5',
                open ? 'scale-100 opacity-100' : 'scale-[0.98] opacity-0',
                className,
            )}
        >
            <span className="flex flex-col gap-1.5">
                <span
                    className={cn(
                        'leading-tight font-bold tracking-[-0.015em]',
                        small ? 'text-[16px]' : 'text-[19px]',
                    )}
                >
                    {title}
                </span>
                {description && (
                    <span className="text-[13px] leading-snug text-muted-foreground">
                        {description}
                    </span>
                )}
            </span>
            <Words reading={reading} small={small} />
            {/*
             * The small card is the other person's screen, narrow as a phone's sheet: its two
             * answers stack full width, the blue one on top, as the app's dialogs do on a phone,
             * so neither ever reaches past the card's edge.
             */}
            <span
                className={cn(
                    'flex gap-2',
                    small ? 'flex-col-reverse' : 'items-center justify-end',
                )}
            >
                <FauxButton
                    variant="outline"
                    size={small ? 'sm' : 'default'}
                    className={small ? 'w-full' : undefined}
                >
                    They don’t match
                </FauxButton>
                <FauxButton
                    size={small ? 'sm' : 'default'}
                    target={target}
                    className={small ? 'w-full' : undefined}
                >
                    They match
                </FauxButton>
            </span>
        </span>
    );
}

export function CheckScene() {
    return (
        <Scene<S>
            label={`Maya and Sam check each other. On Maya's screen, Check it's Sam shows twelve words, numbered; on Sam's, Check it's Maya shows the same twelve: orchard, velvet, timber, glance, harbor, pencil, autumn, rescue, lunar, cabin, shallow, cotton. They read them to each other, and Maya chooses They match. Sam's row under Members then reads Verified: “You and Sam checked each other”.`}
            height={390}
            compact={{ height: 470 }}
            initial={initial}
            poster={poster}
            script={script}
            cursor={{ at: { wide: { x: 560, y: 330 }, compact: { x: 280, y: 330 } } }}
        >
            {(s, _rect, layout) => {
                const compact = layout === 'compact';
                return (
                    <AppWindow
                        className="absolute inset-0"
                        sidebar={compact ? undefined : <Sidebar active="family" />}
                        overlay={
                            <>
                                <span
                                    className={cn(
                                        'absolute inset-0 bg-scrim transition-opacity duration-200',
                                        s.open ? 'opacity-100' : 'opacity-0',
                                    )}
                                />
                                <CheckCard
                                    title="Check it’s Sam"
                                    description={`Ask Sam to open ${FAMILY} and choose Check it’s Maya beside your name. If the twelve words on both screens match, you’ve checked each other.`}
                                    reading={s.reading}
                                    open={s.open}
                                    target="match"
                                    className={
                                        compact ? 'inset-x-3 top-10' : 'top-7 left-10 w-[400px]'
                                    }
                                />
                                {!compact && (
                                    <CheckCard
                                        title="Check it’s Maya"
                                        reading={s.reading}
                                        small
                                        open={s.open}
                                        className="top-10 right-6 w-[240px]"
                                    />
                                )}
                                <Toast
                                    compact={compact}
                                    show={s.matched}
                                    title="You and Sam checked each other"
                                />
                            </>
                        }
                    >
                        <Title description="3 of 4 places taken.">{FAMILY}</Title>
                        <Section title="Members">
                            <PersonRow person={MAYA} you badge="Organizer" />
                            <PersonRow person={JONAS}>
                                <Checked verified />
                            </PersonRow>
                            <PersonRow person={SAM}>
                                <Checked verified={s.matched} />
                                <span
                                    data-target="more"
                                    data-open={s.menu || undefined}
                                    className="relative grid size-8 place-items-center rounded-md text-foreground data-hover:bg-highlight data-open:bg-highlight"
                                >
                                    <EllipsisIcon className="size-4" aria-hidden="true" />
                                    {/* The row's menu, under its button, as the app opens it. */}
                                    <span
                                        className={cn(
                                            'absolute top-9 right-0 z-10 flex w-56 origin-top-right flex-col rounded-xl border border-edge bg-popover p-1 text-sm shadow-overlay transition-[opacity,scale] duration-150 ease-out-soft',
                                            s.menu ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
                                        )}
                                    >
                                        <span
                                            data-target="check"
                                            className="flex h-9 items-center rounded-md px-2.5 data-hover:bg-highlight"
                                        >
                                            Check it’s Sam
                                        </span>
                                        <span className="flex h-9 items-center rounded-md px-2.5">
                                            Let them manage the family
                                        </span>
                                        <span className="flex h-9 items-center rounded-md px-2.5 text-destructive">
                                            Remove from family
                                        </span>
                                    </span>
                                </span>
                            </PersonRow>
                        </Section>
                        <TechnicalSection />
                    </AppWindow>
                );
            }}
        </Scene>
    );
}
