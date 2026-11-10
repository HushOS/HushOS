import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { LostReplyPhrase } from '@/components/recovery-phrase';
import { forgetPhrase, heldPhrase, useHeldPhrase } from '@/lib/unconfirmed-phrase';

/*
 * Where a new recovery phrase is saved when the reply to the change that made it never
 * arrived (docs/two-step-design.md 4, "When the reply is lost"). A public page: by then the
 * person may be signed out, so the signed-in page that shows a new phrase (/setup/recovery-key)
 * cannot be reached, and it reads the phrase from the server besides. This one shows what
 * the dialog left in this tab's memory (lib/unconfirmed-phrase) and forgets it when it is
 * left. Opened any other way (a reload, a typed address) there is nothing to show, and the
 * sign-in page says what is known.
 */
const signIn = {
    to: '/login',
    search: { securityChanged: 'uncertain-phrase' },
    replace: true,
} as const;

export const Route = createFileRoute('/new-phrase')({
    beforeLoad: () => {
        if (!heldPhrase()) throw redirect(signIn);
    },
    onLeave: forgetPhrase,
    headers: () => ({
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
    }),
    head: () => ({
        meta: [
            { title: 'Save your new recovery phrase · HushOS' },
            { name: 'referrer', content: 'no-referrer' },
            { name: 'robots', content: 'noindex' },
        ],
    }),
    staleTime: 0,
    gcTime: 0,
    component: NewPhrasePage,
});

function NewPhrasePage() {
    const router = useRouter();
    const held = useHeldPhrase();
    // A page put away (closed, or kept by the browser for Back) keeps no phrase to come back to.
    useEffect(() => {
        window.addEventListener('pagehide', forgetPhrase);
        return () => window.removeEventListener('pagehide', forgetPhrase);
    }, []);
    // Forgotten while still on screen (the page came back from the browser's cache): the
    // sign-in page says what is known. Not when the person is leaving anyway, phrase saved.
    const done = useRef(false);
    useEffect(() => {
        if (!held && !done.current) void router.navigate(signIn);
    }, [held, router]);
    if (!held) return null;
    return (
        <LostReplyPhrase
            account={held.account}
            phrase={held.phrase}
            recovery={held.recovery}
            // Saved: on to the sign-in page. Leaving this page forgets the phrase (onLeave).
            onDone={() => {
                done.current = true;
                void router.navigate({ to: '/login', replace: true });
            }}
        />
    );
}
