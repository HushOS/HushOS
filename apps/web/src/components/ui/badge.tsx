import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const badgeVariants = cva(
    'eyebrow inline-flex h-5.5 w-fit shrink-0 items-center justify-center gap-1.5 rounded-xs border border-transparent px-2 whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!',
    {
        variants: {
            variant: {
                default: 'bg-accent text-accent-foreground',
                secondary: 'bg-muted text-foreground',
                outline: 'border-rule bg-transparent text-muted-foreground',
                success: 'bg-success-soft text-success',
                warning: 'bg-warning-soft text-warning',
                destructive: 'bg-destructive-soft text-destructive',
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
