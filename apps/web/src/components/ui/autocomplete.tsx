import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete';
import { cn } from 'cn';

/*
 * A text field that suggests as you type and still takes whatever is typed:
 * picking a suggestion fills the field, nothing has to be picked. Arrow keys
 * move through the list, Enter picks, Escape closes it.
 */
const Autocomplete = AutocompletePrimitive.Root;

/* Looks and sizes like Input. */
function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
    return (
        <AutocompletePrimitive.Input
            data-slot="autocomplete-input"
            className={cn(
                'h-11 w-full min-w-0 rounded-md border border-input bg-card px-3.5 font-sans text-base text-foreground sm:text-sm transition-[border-color,background-color,box-shadow] duration-150 ease-out-soft outline-none placeholder:text-muted-foreground/70 hover:bg-muted/40 focus-visible:border-ring focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/40 aria-invalid:ring-inset motion-reduce:transition-none',
                className,
            )}
            {...props}
        />
    );
}

/* Above dialogs (z-50), the width of the field, scrolling within the space there is. */
function AutocompleteContent({
    className,
    children,
    side = 'bottom',
    sideOffset = 4,
    align = 'start',
    ...props
}: AutocompletePrimitive.Popup.Props &
    Pick<AutocompletePrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset'>) {
    return (
        <AutocompletePrimitive.Portal>
            <AutocompletePrimitive.Positioner
                side={side}
                sideOffset={sideOffset}
                align={align}
                className="isolate z-60 outline-none"
            >
                <AutocompletePrimitive.Popup
                    data-slot="autocomplete-content"
                    className={cn(
                        'max-h-[min(var(--available-height),20rem)] w-(--anchor-width) max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-overlay outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none',
                        className,
                    )}
                    {...props}
                >
                    {children}
                </AutocompletePrimitive.Popup>
            </AutocompletePrimitive.Positioner>
        </AutocompletePrimitive.Portal>
    );
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
    return (
        <AutocompletePrimitive.List
            data-slot="autocomplete-list"
            className={cn('flex flex-col gap-0.5 outline-none', className)}
            {...props}
        />
    );
}

/* 36px, 44px on touch, as a menu row. */
function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
    return (
        <AutocompletePrimitive.Item
            data-slot="autocomplete-item"
            className={cn(
                'flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 font-sans text-sm outline-hidden select-none pointer-coarse:min-h-11 data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50',
                className,
            )}
            {...props}
        />
    );
}

function AutocompleteStatus({ className, ...props }: AutocompletePrimitive.Status.Props) {
    return (
        <AutocompletePrimitive.Status
            data-slot="autocomplete-status"
            className={cn('px-3 py-2 text-sm text-muted-foreground empty:p-0', className)}
            {...props}
        />
    );
}

export {
    Autocomplete,
    AutocompleteContent,
    AutocompleteInput,
    AutocompleteItem,
    AutocompleteList,
    AutocompleteStatus,
};
