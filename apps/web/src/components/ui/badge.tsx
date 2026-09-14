import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const badgeVariants = cva(
    'eyebrow inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1.5 border px-2 whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!',
    {
        variants: {
            variant: {
                default: 'border-primary bg-primary text-primary-foreground',
                secondary: 'border-ink bg-ink text-secondary-foreground',
                outline: 'border-border bg-card text-muted-foreground',
                success: 'border-border bg-success text-success-foreground',
                warning: 'border-border bg-warning text-warning-foreground',
                destructive: 'border-border bg-destructive text-destructive-foreground',
            },
        },
        defaultVariants: {
            variant: 'default',
        },
    },
);

function Badge({
    className,
    variant = 'default',
    ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
    return (
        <span
            data-slot="badge"
            data-variant={variant}
            className={cn(badgeVariants({ variant }), className)}
            {...props}
        />
    );
}

export { Badge, badgeVariants };
