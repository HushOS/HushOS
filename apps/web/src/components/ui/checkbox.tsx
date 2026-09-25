import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from 'cn';
import { CheckIcon, MinusIcon } from 'lucide-react';

function Checkbox({ className, onCheckedChange, ...props }: CheckboxPrimitive.Root.Props) {
    return (
        <CheckboxPrimitive.Root
            data-slot="checkbox"
            className={cn(
                'peer relative flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-xs border border-input bg-card transition-[background-color,border-color] duration-150 outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground',
                className,
            )}
            onCheckedChange={onCheckedChange}
            {...props}
        >
            <CheckboxPrimitive.Indicator
                data-slot="checkbox-indicator"
                className="grid place-content-center text-current animate-in zoom-in-50 duration-150 ease-out-expo [&>svg]:size-3.5"
            >
                {/* Some but not all: a bar, not a tick. */}
                <CheckIcon strokeWidth={3} className="in-data-indeterminate:hidden" />
                <MinusIcon strokeWidth={3} className="hidden in-data-indeterminate:block" />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}

export { Checkbox };
