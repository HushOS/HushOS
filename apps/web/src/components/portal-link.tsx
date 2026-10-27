import { cn } from 'cn';
import { ArrowUpRightIcon } from 'lucide-react';
import { Spinner } from '@/components/motion';

/*
 * Card and invoices: Polar's billing portal, where the card is changed and invoices are read,
 * as a link rather than a button (DESIGN.md: a link's words are muted beside its blue icon),
 * since it opens Polar's page and changes nothing on the plan. It is a button underneath, as
 * it asks the server for a fresh portal address first. Where the portal is the person's next
 * step (a failed payment, a paused plan), the pages keep a real button instead.
 */
export function PortalLink({
    onOpen,
    busy,
    disabled,
    className,
}: {
    onOpen: () => void;
    busy: boolean;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onOpen}
            disabled={disabled || busy}
            data-portal-link
            className={cn(
                'inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm text-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 pointer-coarse:h-11',
                className,
            )}
        >
            {busy ? 'Opening' : 'Card and invoices'}
            {busy ? (
                <Spinner className="size-4" />
            ) : (
                <ArrowUpRightIcon className="size-4 text-primary" aria-hidden="true" />
            )}
            <span className="sr-only">, on Polar’s site</span>
        </button>
    );
}
