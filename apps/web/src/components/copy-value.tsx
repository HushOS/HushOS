import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { cue } from '@/lib/sounds';

/*
 * A value you can click to copy: underlined like a link, with a tooltip that
 * says so. The confirmation is a toast, because the tooltip closes on click.
 */
export function CopyValue({
    value,
    label,
    className = '',
}: {
    value: string;
    label: string;
    className?: string;
}) {
    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
            cue('success', { volume: 0.4 });
            toast.add({ type: 'success', title: `${label} copied`, description: value });
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
                data-cuelume-press="press"
                data-cuelume-release="release"
                className={`cursor-copy truncate text-left font-mono underline decoration-dotted decoration-1 underline-offset-4 transition-colors hover:text-primary ${className}`}
            >
                {value}
            </TooltipTrigger>
            <TooltipContent side="top" className="eyebrow">
                Click to copy
            </TooltipContent>
        </Tooltip>
    );
}
