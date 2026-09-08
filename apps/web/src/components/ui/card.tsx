import * as React from 'react';
import { cn } from 'cn';

function Card({
    className,
    size = 'default',
    ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm' }) {
    return (
        <div
            data-slot="card"
            data-size={size}
            className={cn(
                'group/card flex flex-col border bg-card text-sm text-card-foreground [--card-spacing:--spacing(5)] data-[size=sm]:[--card-spacing:--spacing(4)]',
                className,
            )}
            {...props}
        />
    );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="card-header"
            className={cn(
                'group/card-header @container/card-header grid auto-rows-min items-start gap-1.5 border-b p-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto]',
                className,
            )}
            {...props}
        />
    );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="card-title"
            className={cn('eyebrow flex items-center gap-2 text-foreground', className)}
            {...props}
        />
    );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="card-description"
            className={cn('text-sm leading-relaxed text-muted-foreground', className)}
            {...props}
        />
    );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="card-action"
            className={cn(
                'col-start-2 row-span-2 row-start-1 self-start justify-self-end',
                className,
            )}
            {...props}
        />
    );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div data-slot="card-content" className={cn('p-(--card-spacing)', className)} {...props} />
    );
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="card-footer"
            className={cn(
                'mt-auto flex items-center gap-3 border-t bg-muted/40 px-(--card-spacing) py-3.5',
                className,
            )}
            {...props}
        />
    );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
