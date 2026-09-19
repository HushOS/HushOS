import { createContext, use, useState, useTransition, type ReactNode } from 'react';

import { isTheme, setThemeServerFn, type Theme } from '@/lib/theme';

const ThemeContext = createContext<{
    theme: Theme;
    setTheme: (value: unknown) => void;
    isPending: boolean;
    error: string | null;
} | null>(null);

export function ThemeProvider({ children, theme: initial }: { children: ReactNode; theme: Theme }) {
    const [isPending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    // The local choice wins until the loader hands over a different cookie value.
    const [chosen, setChosen] = useState<{ theme: Theme; initial: Theme } | null>(null);
    const theme = chosen?.initial === initial ? chosen.theme : initial;

    function setTheme(value: unknown) {
        if (!isTheme(value) || isPending || value === theme) return;
        setError(null);
        startTransition(async () => {
            try {
                await setThemeServerFn({ data: value });
                setChosen({ theme: value, initial });
            } catch {
                setError('Could not save appearance. Please try again.');
            }
        });
    }

    return <ThemeContext value={{ theme, setTheme, isPending, error }}>{children}</ThemeContext>;
}

export function useTheme() {
    const context = use(ThemeContext);
    if (!context) throw new Error('useTheme must be used within ThemeProvider.');
    return context;
}
