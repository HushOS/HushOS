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

/* Radio items for the appearance choice, shared by the header and the profile menu. */
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
                    className="whitespace-nowrap"
                >
                    <OptionIcon aria-hidden="true" />{' '}
                    {value === 'system' ? 'Same as this computer' : label}
                </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
    );
}

/* The site header's appearance control: one quiet icon button. */
export function ThemeToggle() {
    const { theme, isPending, error } = useTheme();
    const Icon = themeOptions[theme].icon;

    return (
        <div className="relative flex">
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="flex size-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-expanded:bg-muted aria-expanded:text-foreground disabled:opacity-50"
                    aria-label={`Appearance: ${theme === 'system' ? 'Same as this computer' : themeOptions[theme].label}`}
                    title="Appearance"
                    disabled={isPending}
                    aria-busy={isPending}
                >
                    <Icon className="size-[18px]" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="w-auto min-w-44">
                    <ThemeRadioItems />
                </DropdownMenuContent>
            </DropdownMenu>
            {error && (
                <Alert
                    variant="destructive"
                    className="absolute top-12 right-0 z-50 w-64 shadow-overlay"
                >
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
        </div>
    );
}
