import { useEffect, useState } from 'react';
import { TextSwap } from '@/components/motion';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cue } from '@/lib/sounds';

/* A value you can click to copy: underlined like a link, with a tooltip that says so. */
export function CopyValue({ value, className = '' }: { value: string; className?: string }) {
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
        <Tooltip>
            <TooltipTrigger
                render={<button type="button" aria-label={`Copy ${value}`} />}
                onClick={() => void copy()}
                data-cuelume-press="press"
                data-cuelume-release="release"
                className={`cursor-copy truncate text-left font-mono underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary ${className}`}
            >
                {value}
            </TooltipTrigger>
            <TooltipContent side="top" className="eyebrow">
                <TextSwap>{copied ? 'Copied' : 'Click to copy'}</TextSwap>
            </TooltipContent>
        </Tooltip>
    );
}
