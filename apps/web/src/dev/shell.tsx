import { Outlet, useLocation, useRouter } from '@tanstack/react-router';
import { cn } from 'cn';
import { DialRoot } from 'dialkit';
import 'dialkit/styles.css';
import '@/dev/playground.css';
import { domMax, LazyMotion } from 'motion/react';
import { useEffect, type MouseEvent } from 'react';

import { useIsMobile, useIsTablet } from '@/hooks/use-mobile';
import { PlaygroundState, usePlayground } from '@/dev/playground-state';
import { forcePseudoStates } from '@/dev/pseudo-states';

/*
 * The playground (development only, see routes.tsx): a compact header with its two pages,
 * the page, and DialKit's one root, whose first panel holds the playground's own settings.
 * The marker attribute and the marker class (a utility only Tailwind's scan of src/dev would
 * make) are what `bun run build` looks for in the output (scripts/check-dev-only.ts).
 */

const PAGES = [
    { href: '/dev/components', label: 'Components' },
    { href: '/dev/layers', label: 'Layers' },
] as const;

export function PlaygroundShell() {
    useEffect(forcePseudoStates, []);
    // A desk gives DialKit a column of its own; narrower, it floats, closed until opened.
    const mobile = useIsMobile();
    const tablet = useIsTablet();
    const wide = !mobile && !tablet;
    return (
        <PlaygroundState>
            <div
                data-hushos-dev-playground=""
                className="min-h-svh bg-card text-foreground [--hushos-dev-playground:1]"
            >
                <Header />
                <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
                    <main className="w-full max-w-6xl min-w-0">
                        <Outlet />
                    </main>
                    {wide && (
                        <aside
                            aria-label="Live controls"
                            className="sticky top-[calc(3.3125rem+env(safe-area-inset-top))] h-[calc(100svh-3.3125rem-env(safe-area-inset-top))] overflow-y-auto border-l border-rule p-3"
                        >
                            <Dials mode="inline" />
                        </aside>
                    )}
                </div>
                {!wide && <Dials mode="popover" />}
            </div>
        </PlaygroundState>
    );
}

function Header() {
    const { pathname } = useLocation();
    const router = useRouter();
    function go(event: MouseEvent<HTMLAnchorElement>, href: string) {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        void router.navigate({ href });
    }
    return (
        <header className="sticky top-0 z-40 flex items-center gap-4 border-b border-rule bg-card px-5 pt-[calc(0.625rem+env(safe-area-inset-top))] pb-2.5 sm:px-8">
            <h1 className="text-[17px] font-extrabold tracking-[-0.02em]">Playground</h1>
            <nav aria-label="Playground pages" className="flex gap-1">
                {PAGES.map((page) => (
                    <a
                        key={page.href}
                        href={page.href}
                        aria-current={pathname === page.href ? 'page' : undefined}
                        onClick={(event) => go(event, page.href)}
                        className={cn(
                            'flex h-8 items-center rounded-md px-3 text-sm font-semibold outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                            pathname === page.href && 'bg-accent text-accent-foreground',
                        )}
                    >
                        {page.label}
                    </a>
                ))}
            </nav>
        </header>
    );
}

/*
 * The app's MotionProvider is LazyMotion in strict mode, which refuses the full `motion`
 * components DialKit draws its panel with; a LazyMotion of its own lets them render.
 */
function Dials({ mode }: { mode: 'inline' | 'popover' }) {
    const { scheme } = usePlayground();
    return (
        <LazyMotion features={domMax}>
            <DialRoot
                mode={mode}
                position="bottom-right"
                defaultOpen={mode === 'inline'}
                theme={scheme.startsWith('dark') ? 'dark' : 'light'}
            />
        </LazyMotion>
    );
}
