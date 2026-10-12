import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { cue } from '@/lib/sounds';
import { copySecret } from '@/lib/clipboard';

/*
 * A value you can click to copy: underlined like a link, with a tooltip that
 * says so. The confirmation is a toast, because the tooltip closes on click.
 */
export function CopyValue({
    value,
    label,
    wrap = false,
    secret = false,
    className = '',
}: {
    value: string;
    label: string;
    /* Break a long value (a link) across lines instead of clipping it. */
    wrap?: boolean;
    /* A key: cleared from the clipboard again, and never repeated in the toast. */
    secret?: boolean;
    className?: string;
}) {
    async function copy() {
        try {
            if (secret) await copySecret(value);
            else await navigator.clipboard.writeText(value);
            cue('success', { volume: 0.4 });
            toast.add({
                type: 'success',
                title: `${label} copied`,
                description: secret ? 'Cleared from the clipboard in two minutes.' : value,
            });
        } catch {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Copy failed',
                description:
                    'Your browser blocked clipboard access. Select the value and copy it instead.',
            });
        }
    }
    return (
        <Tooltip>
            <TooltipTrigger
                render={<button type="button" aria-label={`Copy ${label}`} />}
                onClick={() => void copy()}
                className={`inline-block max-w-full cursor-copy text-left align-bottom font-mono underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary ${className} ${wrap ? 'wrap-anywhere whitespace-normal' : 'truncate'}`}
            >
                {value}
            </TooltipTrigger>
            <TooltipContent side="top">Click to copy</TooltipContent>
        </Tooltip>
    );
}
