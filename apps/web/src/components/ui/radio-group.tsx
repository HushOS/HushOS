import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from 'cn';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
    return (
        <RadioGroupPrimitive
            data-slot="radio-group"
            className={cn('flex items-center gap-5', className)}
            {...props}
        />
    );
}

/* One choice: the circle with its dot, and the label beside it. */
function RadioItem({ className, children, ...props }: RadioPrimitive.Root.Props) {
    return (
        <label className="flex h-11 cursor-pointer items-center gap-2 text-sm">
            <RadioPrimitive.Root
                data-slot="radio"
                className={cn(
                    'relative flex size-[18px] shrink-0 items-center justify-center rounded-full border border-input bg-card transition-[background-color,border-color] duration-150 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-primary',
                    className,
                )}
                {...props}
            >
                <RadioPrimitive.Indicator
                    data-slot="radio-indicator"
                    className="size-2.5 rounded-full bg-primary animate-in zoom-in-50 duration-150 ease-out-expo"
                />
            </RadioPrimitive.Root>
            {children}
        </label>
    );
}

export { RadioGroup, RadioItem };
