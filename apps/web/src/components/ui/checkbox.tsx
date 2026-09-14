import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from 'cn';
import { CheckIcon } from 'lucide-react';
import { cue } from '@/lib/sounds';

function Checkbox({ className, onCheckedChange, ...props }: CheckboxPrimitive.Root.Props) {
    return (
        <CheckboxPrimitive.Root
            data-slot="checkbox"
            className={cn(
                'peer relative flex size-[18px] shrink-0 cursor-pointer items-center justify-center border border-input bg-card transition-[background-color,border-color] duration-150 outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground',
                className,
            )}
            onCheckedChange={(checked, eventDetails) => {
                // Sound lives here, not on the element, so label clicks toggle audibly too.
                cue('toggle', { volume: 0.6 });
                onCheckedChange?.(checked, eventDetails);
            }}
            {...props}
        >
            <CheckboxPrimitive.Indicator
                data-slot="checkbox-indicator"
                className="grid place-content-center text-current animate-in zoom-in-50 duration-150 ease-out-expo [&>svg]:size-3.5"
            >
                <CheckIcon strokeWidth={3} />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}

export { Checkbox };
