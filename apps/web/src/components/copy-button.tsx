import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { cue } from '@/lib/sounds';

const spring = { type: 'spring', duration: 0.35, bounce: 0 } as const;

/* The copy glyph folds away while the check draws itself: one gesture, not two icons. */
export function CopyCheckIcon({ done, className = '' }: { done: boolean; className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <motion.rect
                x="9"
                y="9"
                width="13"
                height="13"
                rx="0"
                style={{ transformOrigin: '15.5px 15.5px' }}
                animate={done ? { opacity: 0, scale: 0.4 } : { opacity: 1, scale: 1 }}
                transition={spring}
            />
            <motion.path
                d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                style={{ transformOrigin: '8px 8px' }}
                animate={done ? { opacity: 0, scale: 0.4 } : { opacity: 1, scale: 1 }}
                transition={spring}
            />
            <motion.path
                d="M4 12.5 9.5 18 20 6.5"
                initial={false}
                animate={done ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
                transition={{ pathLength: spring, opacity: { duration: 0.1 } }}
            />
        </svg>
    );
}

/* A small copy affordance for values in a ledger row (IDs, emails, phrases). */
export function CopyButton({
    value,
    label,
    className = '',
}: {
    value: string;
    label: string;
    className?: string;
}) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1_600);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
        }
    }
    return (
        <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? 'Copied' : label}
            title={label}
            data-cuelume-press="press"
            data-cuelume-release="release"
            className={`grid size-8 shrink-0 cursor-pointer place-items-center border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${copied ? 'text-foreground' : ''} ${className}`}
        >
            <CopyCheckIcon done={copied} className="size-3.5" />
        </button>
    );
}
