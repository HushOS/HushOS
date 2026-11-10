import { Component, useEffect, useRef, type ReactNode } from 'react';
import {
    forgetPhrase,
    PHRASE_ABOUT,
    PHRASE_TITLE,
    type HeldPhrase,
} from '@/lib/unconfirmed-phrase';

/*
 * What the root document draws while a new recovery phrase is held (lib/unconfirmed-phrase):
 * the screen that came with it, and everything that keeps the only copy in front of the
 * person. The tab is named for it and the heading takes the focus, so a screen reader says
 * what replaced the page. The browser asks before closing or reloading the tab, and a page
 * put away keeps no phrase. Should the screen itself fail to draw, the words are still
 * printed, plainly, by markup that has nothing in it to fail.
 */

class Boundary extends Component<
    { fallback: ReactNode; children: ReactNode },
    { failed: boolean }
> {
    override state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    override render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

const focusHeading = (within: HTMLElement | null) => {
    const heading = within?.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
};

/* The words as a numbered list and a way on: plain elements, no components, no styles of state. */
function PlainPhrase({ phrase, onDone }: { phrase: string; onDone: () => void }) {
    const frame = useRef<HTMLElement>(null);
    useEffect(() => focusHeading(frame.current), []);
    return (
        <main
            ref={frame}
            className="mx-auto flex min-h-svh w-full max-w-[600px] flex-col gap-5 bg-background px-4 py-12 text-foreground"
        >
            <h1 className="text-[26px] leading-[1.15] font-extrabold tracking-[-0.03em]">
                {PHRASE_TITLE}
            </h1>
            <p className="text-[15px] leading-snug text-muted-foreground">{PHRASE_ABOUT}</p>
            <ol
                aria-label="Recovery phrase"
                className="grid list-inside list-decimal grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[15px] sm:grid-cols-3"
            >
                {phrase.split(' ').map((word, index) => (
                    <li key={`${index}-${word}`}>{word}</li>
                ))}
            </ol>
            <button
                type="button"
                onClick={onDone}
                className="h-9 w-fit cursor-pointer rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground pointer-coarse:h-11"
            >
                Finish
            </button>
        </main>
    );
}

export function HeldPhraseScreen({ held, onDone }: { held: HeldPhrase; onDone: () => void }) {
    const frame = useRef<HTMLDivElement>(null);
    useEffect(() => {
        /*
         * A title element of this screen's own, kept first in the head, where the browser
         * reads the tab's name from. The router's own title stays its own underneath, to
         * change as it will and to be the name again once this one is removed.
         */
        const title = document.createElement('title');
        title.textContent = `${PHRASE_TITLE} · HushOS`;
        const keepFirst = () => {
            if (document.head.querySelector('title') !== title) document.head.prepend(title);
        };
        keepFirst();
        const head = new MutationObserver(keepFirst);
        head.observe(document.head, { childList: true });
        focusHeading(frame.current);
        const ask = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            // What older engines ask for instead.
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', ask);
        window.addEventListener('pagehide', forgetPhrase);
        return () => {
            head.disconnect();
            title.remove();
            window.removeEventListener('beforeunload', ask);
            window.removeEventListener('pagehide', forgetPhrase);
        };
    }, []);
    return (
        <div ref={frame} className="contents">
            <Boundary fallback={<PlainPhrase phrase={held.phrase} onDone={onDone} />}>
                <held.Screen
                    account={held.account}
                    phrase={held.phrase}
                    recovery={held.recovery}
                    onDone={onDone}
                />
            </Boundary>
        </div>
    );
}
