import { createContext, use, useState, useTransition, type ReactNode } from 'react';

import { isTheme, setContrastServerFn, setThemeServerFn, type Theme } from '@/lib/theme';

const ThemeContext = createContext<{
    theme: Theme;
    setTheme: (value: unknown) => void;
    /* High contrast forced on here; off follows the computer's own setting. */
    contrast: boolean;
    setContrast: (value: boolean) => void;
    isPending: boolean;
    error: string | null;
} | null>(null);

export function ThemeProvider({
    children,
    theme: initial,
    contrast: initialContrast,
}: {
    children: ReactNode;
    theme: Theme;
    contrast: boolean;
}) {
    const [isPending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    // The local choice wins until the loader hands over a different cookie value.
    const [chosen, setChosen] = useState<{ theme: Theme; initial: Theme } | null>(null);
    const theme = chosen?.initial === initial ? chosen.theme : initial;
    const [contrastChoice, setContrastChoice] = useState<{
        contrast: boolean;
        initial: boolean;
    } | null>(null);
    const contrast =
        contrastChoice?.initial === initialContrast ? contrastChoice.contrast : initialContrast;

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

    function setContrast(value: boolean) {
        if (isPending || value === contrast) return;
        setError(null);
        startTransition(async () => {
            try {
                await setContrastServerFn({ data: value });
                setContrastChoice({ contrast: value, initial: initialContrast });
            } catch {
                setError('Could not save contrast. Please try again.');
            }
        });
    }

    return (
        <ThemeContext value={{ theme, setTheme, contrast, setContrast, isPending, error }}>
            {children}
        </ThemeContext>
    );
}

export function useTheme() {
    const context = use(ThemeContext);
    if (!context) throw new Error('useTheme must be used within ThemeProvider.');
    return context;
}
