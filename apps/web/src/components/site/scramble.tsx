import { cn } from 'cn';
import { useRef, type ElementType, type PointerEvent } from 'react';

/*
 * Text that locks and unlocks: pointing at a word turns its characters into
 * random ones and settles them back left to right, the way a file looks to us
 * and then to you. One word at a time and quickly, in the same face, so it
 * reads as a flicker rather than a show.
 * Screen readers get the plain text once; the drawn characters are hidden from them. Each character keeps its
 * width while it is scrambled, so the line never reflows. With reduced motion
 * nothing happens.
 */

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789+/=';

export function randomGlyph() {
    return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;
}

export function Scramble({
    text,
    as: Tag = 'span',
    className,
    duration = 450,
}: {
    text: string;
    as?: ElementType;
    className?: string;
    duration?: number;
}) {
    // Words already scrambling, so passing back over one does not restart it.
    const busy = useRef(new Set<Element>());

    function run(scope: Element | null) {
        if (!scope || busy.current.has(scope)) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const glyphs = [...scope.querySelectorAll<HTMLElement>('[data-char]')];
        busy.current.add(scope);
        // Hold every character at its own width, so a wide random glyph cannot push the line.
        for (const glyph of glyphs) glyph.style.width = `${glyph.getBoundingClientRect().width}px`;
        const start = performance.now();
        let last = 0;
        const frame = (now: number) => {
            const elapsed = now - start;
            const reroll = now - last > 70;
            if (reroll) last = now;
            glyphs.forEach((glyph, index) => {
                const original = glyph.dataset.char!;
                if (original === ' ') return;
                const settle = 80 + (index / glyphs.length) * (duration - 120);
                if (elapsed >= settle) {
                    if (glyph.dataset.locked !== undefined) {
                        glyph.textContent = original;
                        delete glyph.dataset.locked;
                    }
                } else if (reroll) {
                    glyph.textContent = randomGlyph();
                    glyph.dataset.locked = '';
                }
            });
            if (elapsed < duration) return requestAnimationFrame(frame);
            for (const glyph of glyphs) {
                glyph.textContent = glyph.dataset.char!;
                glyph.style.width = '';
                delete glyph.dataset.locked;
            }
            busy.current.delete(scope);
        };
        requestAnimationFrame(frame);
    }

    // Words stay unbreakable, so a line wraps between words as the plain text would.
    const words = text.split(/(\s+)/);
    return (
        <Tag
            className={cn('cursor-default', className)}
            onPointerOver={(event: PointerEvent) =>
                run((event.target as Element).closest('[data-word]'))
            }
        >
            <span className="sr-only">{text}</span>
            <span aria-hidden="true">
                {words.map((word, w) =>
                    /^\s+$/.test(word) ? (
                        word
                    ) : (
                        <span key={w} data-word="" className="inline-block whitespace-nowrap">
                            {/* The headline is ASCII, so code units are characters. */}
                            {word.split('').map((char, c) => (
                                <span key={c} data-char={char} className="scramble-glyph">
                                    {char}
                                </span>
                            ))}
                        </span>
                    ),
                )}
            </span>
        </Tag>
    );
}
