import { PlayIcon, SquareIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Stage, type StageProps } from '@/components/stageshow/stage';
import type { Act } from '@/components/stageshow/act';
import { useReducedMotion } from '@/components/stageshow/reduced-motion';

/*
 * One scene of the family plans post: a Stageshow stage of the app's own furniture, played once
 * each time it scrolls into view and then holding its last frame, never looping in the reader's
 * eye line; scrolled away (under a quarter showing), it plays from the start when it comes back. It is one image to assistive technology, its story said in `label`. Under reduced motion
 * it is its poster, the frame that tells the story alone, and nothing moves. Otherwise a quiet
 * button under it stops it at that poster, or plays it again (WCAG 2.2.2: anything that moves
 * for more than five seconds can be stopped).
 */

/* The reading column's width on a desk; narrower columns scale it down, phones get `compact`. */
const WIDE = 760;

export function Scene<S extends object>({
    label,
    height,
    compact,
    initial,
    poster,
    script,
    cursor,
    children,
}: {
    /* What the scene shows, for a screen reader: the whole story in a sentence or two. */
    label: string;
    height: number;
    /* The phone column's own design (Stageshow's compact), 358 wide. */
    compact: { height: number };
    initial: S;
    /* With no script the scene is a still: its initial frame, with no button under it. */
    poster?: S;
    script?: (act: Act<S>) => Promise<void>;
    cursor?: StageProps<S>['cursor'];
    children: StageProps<S>['children'];
}) {
    const reduced = useReducedMotion();
    // Each play is its own stage, so playing again starts from the first frame.
    const [take, setTake] = useState(0);
    const [phase, setPhase] = useState<'ready' | 'playing' | 'done' | 'stopped'>('ready');
    const played = useMemo(
        () =>
            script &&
            (async (act: Act<S>) => {
                setPhase('playing');
                await script(act);
                setPhase('done');
            }),
        // A new take is a new script, which the stage starts afresh.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
        [script, take],
    );
    const moving = phase === 'ready' || phase === 'playing';
    return (
        <figure className="mt-6 flex flex-col gap-2">
            {/* A drawn scene, not a picture file, read as one image with its story in words. */}
            {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
            <div role="img" aria-label={label}>
                <Stage<S>
                    key={take}
                    width={WIDE}
                    height={height}
                    compact={{ below: 560, width: 358, height: compact.height }}
                    initial={initial}
                    poster={poster}
                    script={phase === 'stopped' ? undefined : played}
                    cursor={cursor}
                    play="replay"
                >
                    {children}
                </Stage>
            </div>
            {script && !reduced && (
                <button
                    type="button"
                    onClick={() => {
                        if (moving) setPhase('stopped');
                        else {
                            setPhase('ready');
                            setTake((value) => value + 1);
                        }
                    }}
                    className="flex h-9 w-fit cursor-pointer items-center gap-1.5 self-end rounded-md px-3 text-sm font-semibold text-primary outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11"
                >
                    {moving ? (
                        <SquareIcon className="size-3.5" aria-hidden="true" />
                    ) : (
                        <PlayIcon className="size-3.5" aria-hidden="true" />
                    )}
                    {moving ? 'Stop' : 'Play again'}
                </button>
            )}
        </figure>
    );
}
