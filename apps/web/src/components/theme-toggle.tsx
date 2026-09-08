import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';

import { useTheme } from '@/components/theme-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export const themeOptions = {
    light: { label: 'Light', icon: SunIcon },
    dark: { label: 'Dark', icon: MoonIcon },
    system: { label: 'System', icon: MonitorIcon },
} as const;

/* Radio items for the appearance choice, shared by the header cell and the profile menu. */
export function ThemeRadioItems() {
    const { theme, setTheme } = useTheme();
    return (
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            {Object.entries(themeOptions).map(([value, { label, icon: OptionIcon }]) => (
                <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    closeOnClick
                    data-cuelume-toggle=""
                >
                    <OptionIcon aria-hidden="true" /> {label}
                </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
    );
}

/* The header's appearance cell: an uppercase label that reads as part of the bar. */
export function ThemeToggle() {
    const { theme, isPending, error } = useTheme();
    const Icon = themeOptions[theme].icon;

    return (
        <div className="relative flex">
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="eyebrow flex cursor-pointer items-center gap-2 border-l px-4 text-foreground transition-colors hover:bg-muted aria-expanded:bg-muted disabled:opacity-50"
                    aria-label={`Appearance: ${themeOptions[theme].label}`}
                    title={`Appearance: ${themeOptions[theme].label}`}
                    disabled={isPending}
                    aria-busy={isPending}
                    data-cuelume-press="press"
                >
                    <Icon className="size-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">{themeOptions[theme].label}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={0} className="min-w-44">
                    <ThemeRadioItems />
                </DropdownMenuContent>
            </DropdownMenu>
            {error && (
                <Alert variant="destructive" className="absolute top-12 right-0 z-50 w-64">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
        </div>
    );
}
