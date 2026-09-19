import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const buttonVariants = cva(
    "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border font-sans text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,transform] duration-150 ease-out-soft outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    {
        variants: {
            variant: {
                default:
                    'border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover',
                secondary:
                    'border-ink bg-ink text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--ink),var(--background)_12%)]',
                outline:
                    'border-input bg-card text-foreground hover:bg-muted aria-expanded:bg-muted',
                ghost: 'border-transparent bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted',
                row: 'w-full justify-between border-transparent bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted [&>svg]:text-primary',
                destructive:
                    'border-destructive bg-destructive text-destructive-foreground hover:bg-[color-mix(in_oklch,var(--destructive),var(--ink)_10%)] focus-visible:outline-destructive',
                'destructive-outline':
                    'border-destructive/35 bg-transparent text-destructive hover:bg-destructive-soft focus-visible:outline-destructive',
                link: 'h-auto rounded-none border-transparent px-0 font-normal text-primary underline decoration-1 underline-offset-4 hover:text-primary-hover',
            },
            size: {
                default: 'h-10 px-4',
                xs: "h-7 gap-1.5 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3",
                sm: "h-8 px-3 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
                lg: 'h-12 px-5 text-[15px]',
                row: 'h-14 px-5 sm:px-6',
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

function Button({
    className,
    variant = 'default',
    size = 'default',
    ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
    return (
        <ButtonPrimitive
            data-slot="button"
            className={cn(buttonVariants({ variant, size, className }))}
            {...props}
        />
    );
}

export { Button, buttonVariants };
