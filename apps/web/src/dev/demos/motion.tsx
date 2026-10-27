import { useDialKit, type TransitionConfig } from 'dialkit';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { AnimatePresence, m, type Transition } from 'motion/react';
import { useState } from 'react';

import { Collapse, IconSwap, PendingLabel, Spinner, TextSwap } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { Demo, Row, Sample } from '@/dev/demo';

/*
 * The app's Motion pieces (components/motion.tsx) beside copies driven by the Motion
 * panel, so a spring can be tried against the shipped one. The copies use DialKit's
 * spring, which is `visualDuration` and `bounce`; the app's constants use `duration`.
 */
/* DialKit's editor can switch a spring to an easing curve, which Motion spells without a type. */
function toMotion(config: TransitionConfig): Transition {
    return config.type === 'easing' ? { duration: config.duration, ease: config.ease } : config;
}

export function MotionDemo() {
    const [on, setOn] = useState(false);
    const dial = useDialKit(
        'Motion',
        {
            swap: { type: 'spring', visualDuration: 0.3, bounce: 0 },
            icon: { type: 'spring', visualDuration: 0.22, bounce: 0 },
            collapse: { type: 'spring', visualDuration: 0.4, bounce: 0 },
            rise: [10, 0, 24],
            blur: [2, 0, 8, 0.5],
            replay: { type: 'action', label: 'Play all' },
        },
        { id: 'motion', defaultCollapsed: true, onAction: () => setOn((value) => !value) },
    );
    const label = on ? 'Copied' : 'Copy link';
    return (
        <Demo
            id="motion"
            title="Motion"
            note="Only for exits, height to auto and interruptible swaps. Press a sample, or Play all in the Motion panel."
        >
            <Row label="Text swap">
                <Sample caption="Shipped">
                    <Button variant="outline" onClick={() => setOn(!on)}>
                        <TextSwap>{label}</TextSwap>
                    </Button>
                </Sample>
                <Sample caption="Tuned">
                    <Button variant="outline" onClick={() => setOn(!on)}>
                        <span className="relative inline-grid">
                            <AnimatePresence mode="popLayout" initial={false}>
                                <m.span
                                    key={label}
                                    initial={{
                                        opacity: 0,
                                        y: dial.rise,
                                        filter: `blur(${dial.blur}px)`,
                                    }}
                                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                                    exit={{
                                        opacity: 0,
                                        y: -dial.rise,
                                        filter: `blur(${dial.blur}px)`,
                                    }}
                                    transition={toMotion(dial.swap)}
                                    className="inline-block whitespace-nowrap"
                                >
                                    {label}
                                </m.span>
                            </AnimatePresence>
                        </span>
                    </Button>
                </Sample>
            </Row>
            <Row label="Icon swap">
                <Sample caption="Shipped">
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Copy"
                        onClick={() => setOn(!on)}
                    >
                        <IconSwap id={on ? 'done' : 'copy'}>
                            {on ? <CheckIcon /> : <CopyIcon />}
                        </IconSwap>
                    </Button>
                </Sample>
                <Sample caption="Tuned">
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Copy"
                        onClick={() => setOn(!on)}
                    >
                        <span className="relative grid place-items-center">
                            <AnimatePresence mode="wait" initial={false}>
                                <m.span
                                    key={on ? 'done' : 'copy'}
                                    initial={{ opacity: 0, scale: 0.6 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.6 }}
                                    transition={toMotion(dial.icon)}
                                    className="grid place-items-center"
                                >
                                    {on ? <CheckIcon /> : <CopyIcon />}
                                </m.span>
                            </AnimatePresence>
                        </span>
                    </Button>
                </Sample>
            </Row>
            <Row label="Pending label and spinner">
                <Button onClick={() => setOn(!on)}>
                    <PendingLabel pending={on} idle="Create" busy="Creating" />
                </Button>
                <Spinner />
            </Row>
            <Row label="Collapse">
                <div className="flex w-full max-w-sm flex-col gap-3">
                    <Button variant="outline" className="w-fit" onClick={() => setOn(!on)}>
                        {on ? 'Hide' : 'Show'} technical details
                    </Button>
                    <Collapse open={on}>
                        <p className="rounded-xl border border-rule p-4 text-sm">
                            Shipped: 0.4s, no bounce.
                        </p>
                    </Collapse>
                    <AnimatePresence initial={false}>
                        {on && (
                            <m.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{
                                    height: toMotion(dial.collapse),
                                    opacity: { duration: 0.2 },
                                }}
                                className="overflow-hidden"
                            >
                                <p className="rounded-xl border border-rule p-4 text-sm">
                                    Tuned from the Motion panel.
                                </p>
                            </m.div>
                        )}
                    </AnimatePresence>
                </div>
            </Row>
        </Demo>
    );
}
