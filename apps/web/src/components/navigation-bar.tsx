import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { cn } from 'cn';

type Phase = 'idle' | 'loading' | 'done';

/*
 * A hairline across the top of the window while the router loads the next
 * page. It waits a moment before showing, so a navigation that resolves at
 * once never flashes it; it creeps toward the end while loading, then fills
 * and fades. Fixed and inert, it takes no room and catches no clicks.
 */
export function NavigationBar() {
    const pending = useRouterState({ select: (state) => state.status === 'pending' });
    const [phase, setPhase] = useState<Phase>('idle');
    // Settling finishes a bar that showed; one still waiting on its delay never appears.
    // A load that begins while the last bar fades starts again from nothing: left
    // in place, the full-width bar would reappear and shrink back to its resting point.
    const [wasPending, setWasPending] = useState(pending);
    if (wasPending !== pending) {
        setWasPending(pending);
        if (pending && phase === 'done') setPhase('idle');
        if (!pending && phase === 'loading') setPhase('done');
    }
    useEffect(() => {
        if (!pending) return;
        const timer = window.setTimeout(() => setPhase('loading'), 150);
        return () => window.clearTimeout(timer);
    }, [pending]);
    useEffect(() => {
        if (phase !== 'done') return;
        const timer = window.setTimeout(() => setPhase('idle'), 500);
        return () => window.clearTimeout(timer);
    }, [phase]);
    return (
        <div
            aria-hidden="true"
            className={cn(
                'pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-primary',
                phase === 'idle' && 'scale-x-0 opacity-0',
                phase === 'loading' &&
                    'scale-x-[0.85] opacity-100 transition-transform duration-[8s] ease-out-expo',
                phase === 'done' &&
                    'scale-x-100 opacity-0 transition-[scale,opacity] delay-[0ms,150ms] duration-200 ease-out-soft',
            )}
        />
    );
}
