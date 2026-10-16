import { cn } from 'cn';

/* What the server learns from a family, said once at the foot of the families pages (the 1c plan, section 3). */
export function ServerKnowsLine({ className }: { className?: string }) {
    return (
        <p className={cn('px-5 py-6 text-[13px] text-muted-foreground sm:px-8', className)}>
            HushOS’s server knows who is in your family and the family’s name. It can’t open family
            folders.
        </p>
    );
}
