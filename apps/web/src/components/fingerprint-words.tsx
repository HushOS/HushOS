import { fingerprintWords } from '@hushos/auth/client';
import { useState } from 'react';

/*
 * A fingerprint as the twelve words two people read to each other. "Show as
 * code" gives the same fingerprint as hex, for checking against an app that
 * still shows it that way; the words are drawn from that code, so either
 * matching means the same. `pairs` lays them out in two columns, numbered
 * down each, as Check it's Maya reads them, with the code under its
 * Technical details instead of a toggle.
 */
export function FingerprintWords({
    fingerprint,
    pairs = false,
}: {
    fingerprint: string;
    pairs?: boolean;
}) {
    const words = fingerprintWords(fingerprint);
    const [code, setCode] = useState(false);
    return (
        <div className="flex flex-col items-start gap-2.5">
            {code && !pairs ? (
                <p
                    data-fingerprint={fingerprint}
                    className="w-full rounded-xl bg-muted px-4 py-3 font-mono text-[15px] leading-relaxed tracking-wide wrap-anywhere"
                >
                    {fingerprint}
                </p>
            ) : (
                // As many 7rem tiles as fit (four on a desk, two on a phone): no word reaches its tile's edge.
                <ol
                    data-fingerprint-words={words.join(' ')}
                    aria-label="Twelve words"
                    className={
                        pairs
                            ? 'grid w-full grid-flow-col grid-cols-2 grid-rows-6 gap-1.5'
                            : 'grid w-full grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1.5'
                    }
                >
                    {words.map((word, index) => (
                        <li
                            key={index}
                            className="flex items-baseline gap-1.5 rounded-md bg-muted px-2.5 py-2"
                        >
                            <span
                                aria-hidden="true"
                                className="w-4 text-right text-[11px] text-muted-foreground tabular-nums"
                            >
                                {index + 1}
                            </span>
                            <span className="text-[15px] font-medium">{word}</span>
                        </li>
                    ))}
                </ol>
            )}
            {!pairs && (
                <button
                    type="button"
                    onClick={() => setCode((on) => !on)}
                    className="cursor-pointer text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                >
                    {code ? 'Show as words' : 'Show as code'}
                </button>
            )}
        </div>
    );
}
