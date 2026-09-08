import { AnimatePresence, MotionConfig, motion, type Transition } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from 'cn';

/*
 * Motion for React is used only where CSS cannot: exit animations, height to
 * auto, and interruptible state swaps. Everything else (menus, entrances,
 * hover, press) stays in CSS. See DESIGN.md → Motion.
 */

/* Spring with no overshoot: the default for state swaps inside product UI. */
export const swap: Transition = { type: 'spring', duration: 0.3, bounce: 0 };
/* Slightly lively spring for content that arrives (reveals, confirmations). */
export const arrive: Transition = { type: 'spring', duration: 0.45, bounce: 0.15 };

export function MotionProvider({ children }: { children: ReactNode }) {
    return (
        <MotionConfig transition={swap} reducedMotion="user">
            {children}
        </MotionConfig>
    );
}

/*
 * Crossfades text when `children` changes: the old label lifts out as the new
 * one rises in. Keyed on the string, so identical labels never re-animate.
 */
export function TextSwap({ children, className }: { children: string; className?: string }) {
    return (
        <span className={cn('relative inline-grid', className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={children}
                    initial={{ opacity: 0, y: 10, filter: 'blur(2px)' }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, y: -10, filter: 'blur(2px)' }}
                    transition={swap}
                    className="inline-block whitespace-nowrap"
                >
                    {children}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}

/* Swaps an icon for another with a small scale crossfade; keep icons the same size. */
export function IconSwap({
    id,
    children,
    className,
}: {
    id: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <span className={cn('relative grid place-items-center', className)}>
            <AnimatePresence mode="wait" initial={false}>
                <motion.span
                    key={id}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ type: 'spring', duration: 0.22, bounce: 0 }}
                    className="grid place-items-center"
                >
                    {children}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}

/*
 * Reveals or removes a block by animating height from 0 to auto. Padding lives
 * on the child so the measured height includes it.
 */
export function Collapse({
    open,
    children,
    className,
}: {
    open: boolean;
    children: ReactNode;
    className?: string;
}) {
    return (
        <AnimatePresence initial={false}>
            {open && (
                <motion.div
                    key="collapse"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                        height: { type: 'spring', duration: 0.4, bounce: 0 },
                        opacity: { duration: 0.2 },
                    }}
                    className={cn('overflow-hidden', className)}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}

export function Spinner({ className }: { className?: string }) {
    return (
        <svg
            className={cn('size-4 animate-spin motion-reduce:animate-none', className)}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
            />
        </svg>
    );
}

/* A submit label that swaps to its pending text with a spinner. */
export function PendingLabel({
    pending,
    idle,
    busy,
}: {
    pending: boolean;
    idle: string;
    busy: string;
}) {
    return (
        <>
            <AnimatePresence initial={false}>
                {pending && (
                    <motion.span
                        key="spinner"
                        initial={{ opacity: 0, width: 0, scale: 0.6 }}
                        animate={{ opacity: 1, width: 'auto', scale: 1 }}
                        exit={{ opacity: 0, width: 0, scale: 0.6 }}
                        transition={swap}
                        className="grid place-items-center overflow-hidden"
                    >
                        <Spinner className="mr-1.5" />
                    </motion.span>
                )}
            </AnimatePresence>
            <TextSwap>{pending ? busy : idle}</TextSwap>
        </>
    );
}
