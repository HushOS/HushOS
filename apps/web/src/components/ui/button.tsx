import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const buttonVariants = cva(
    "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 border font-mono text-xs font-medium tracking-[0.1em] whitespace-nowrap uppercase transition-[color,background-color,border-color,transform] duration-150 ease-out-soft outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    {
        variants: {
            variant: {
                default:
                    'border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover',
                secondary:
                    'border-ink bg-ink text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--ink),var(--background)_12%)]',
                outline:
                    'border-border bg-card text-foreground hover:bg-muted aria-expanded:bg-muted',
                ghost: 'border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
                destructive:
                    'border-destructive bg-destructive text-destructive-foreground hover:bg-[color-mix(in_oklch,var(--destructive),var(--ink)_10%)] focus-visible:outline-destructive',
                'destructive-outline':
                    'border-destructive bg-transparent text-destructive hover:bg-destructive/10 focus-visible:outline-destructive',
                link: 'h-auto border-transparent px-0 text-foreground underline decoration-1 underline-offset-4 hover:text-primary',
            },
            size: {
                default: 'h-10 px-4',
                xs: "h-7 gap-1.5 px-2.5 text-[10px] [&_svg:not([class*='size-'])]:size-3",
                sm: "h-8 px-3 text-[11px] [&_svg:not([class*='size-'])]:size-3.5",
                lg: 'h-12 px-5 text-[13px]',
                icon: 'size-10',
                'icon-xs': "size-7 [&_svg:not([class*='size-'])]:size-3",
                'icon-sm': 'size-8',
                'icon-lg': 'size-12',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'default',
        },
    },
);

/*
 * Every button carries a quiet press/release cue. Link-styled buttons are the
 * exception so inline text never clicks. Pass `data-cuelume-press={undefined}`
 * to opt out.
 */
function Button({
    className,
    variant = 'default',
    size = 'default',
    ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
    const cues =
        variant === 'link'
            ? {}
            : { 'data-cuelume-press': 'press', 'data-cuelume-release': 'release' };
    return (
        <ButtonPrimitive
            data-slot="button"
            className={cn(buttonVariants({ variant, size, className }))}
            {...cues}
            {...props}
        />
    );
}

export { Button, buttonVariants };
