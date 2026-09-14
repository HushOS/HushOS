import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, TriangleAlertIcon } from 'lucide-react';

const alertVariants = cva(
    "group/alert relative grid w-full gap-1 border px-4 py-3 text-left text-sm animate-in fade-in slide-in-from-top-1 duration-200 ease-out-expo has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-3 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
    {
        variants: {
            variant: {
                default: 'border-border bg-card text-card-foreground',
                info: 'border-primary bg-accent text-accent-foreground *:data-[slot=alert-description]:text-accent-foreground/85',
                success:
                    'border-border bg-success/25 text-foreground *:data-[slot=alert-description]:text-foreground/85',
                warning:
                    'border-border bg-warning/35 text-foreground *:data-[slot=alert-description]:text-foreground/85',
                destructive:
                    'border-destructive bg-destructive/15 text-foreground *:data-[slot=alert-description]:text-foreground/90',
            },
        },
        defaultVariants: {
            variant: 'default',
        },
    },
);

const icons = {
    default: null,
    info: InfoIcon,
    success: CheckCircle2Icon,
    warning: TriangleAlertIcon,
    destructive: AlertCircleIcon,
};

function Alert({
    className,
    variant = 'default',
    children,
    ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
    const Icon = icons[variant ?? 'default'];
    return (
        <div
            data-slot="alert"
            role="alert"
            className={cn(alertVariants({ variant }), className)}
            {...props}
        >
            {Icon && <Icon aria-hidden="true" />}
            {children}
        </div>
    );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="alert-title"
            className={cn('eyebrow group-has-[>svg]/alert:col-start-2', className)}
            {...props}
        />
    );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="alert-description"
            className={cn(
                'text-sm leading-relaxed text-pretty text-muted-foreground group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
                className,
            )}
            {...props}
        />
    );
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="alert-action"
            className={cn('absolute top-2.5 right-2.5', className)}
            {...props}
        />
    );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
