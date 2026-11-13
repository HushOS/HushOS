import { lazy, Suspense, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { forgetNewPhrase, newPhrase } from '@/lib/new-phrase';

/*
 * Shows a recovery phrase that a rotation just made and that nothing else will show
 * (lib/new-phrase.ts), over whatever page is on screen: the dialog that made it, the sign-in
 * page it sends the person to, or the page a still-valid session redirects them to instead.
 * It does not depend on where they land, because every one of those can be a page that asks
 * for the very words it would hide. It stays until the person says they have saved them, and
 * that is the moment the words are forgotten. The panel is loaded on demand: the dialog that
 * keeps a phrase loads it first, before it changes anything.
 */
const Panel = lazy(() =>
    import('@/components/new-phrase').then((module) => ({ default: module.NewPhrase })),
);

export function NewPhraseGate() {
    const made = useStore(newPhrase, (state) => state.made);
    const layer = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        if (made) layer.current?.focus();
    }, [made]);
    if (!made) return null;
    return (
        <dialog
            ref={layer}
            open
            aria-modal="true"
            aria-label="Save your new recovery phrase"
            tabIndex={-1}
            data-new-phrase
            // The whole viewport, above every page, dialog and notice.
            className="fixed inset-0 z-[1000] m-0 size-full max-h-none max-w-none overflow-y-auto border-0 bg-background p-0 text-foreground outline-none"
        >
            <Suspense fallback={null}>
                <Panel
                    made={made}
                    action={
                        <Button type="button" size="lg" onClick={forgetNewPhrase}>
                            I’ve saved these words
                        </Button>
                    }
                />
            </Suspense>
        </dialog>
    );
}
