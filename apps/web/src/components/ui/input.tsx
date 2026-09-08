import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from 'cn';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
    return (
        <InputPrimitive
            type={type}
            data-slot="input"
            className={cn(
                'h-11 w-full min-w-0 border border-input bg-card px-3.5 font-mono text-base text-foreground sm:text-sm transition-[border-color,background-color,box-shadow] duration-150 ease-out-soft outline-none placeholder:text-muted-foreground/60 hover:bg-muted/40 focus-visible:border-ring focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/40 aria-invalid:ring-inset motion-reduce:transition-none',
                className,
            )}
            {...props}
        />
    );
}

export { Input };
