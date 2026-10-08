import { fingerprintWords } from '@hushos/auth/client';
import { useState } from 'react';

/*
 * A fingerprint as the twelve words two people read to each other. "Show as
 * code" gives the same fingerprint as hex, for checking against an app that
 * still shows it that way; the words are drawn from that code, so either
 * matching means the same.
 */
export function FingerprintWords({ fingerprint }: { fingerprint: string }) {
    const words = fingerprintWords(fingerprint);
    const [code, setCode] = useState(false);
    return (
        <div className="flex flex-col items-start gap-2.5">
            {code ? (
                <p
                    data-fingerprint={fingerprint}
                    className="w-full rounded-xl bg-muted px-4 py-3 font-mono text-[15px] leading-relaxed tracking-wide wrap-anywhere"
                >
                    {fingerprint}
                </p>
            ) : (
                <ol
                    data-fingerprint-words={words.join(' ')}
                    aria-label="Twelve words"
                    className="grid w-full grid-cols-3 gap-1.5 sm:grid-cols-4"
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
            <button
                type="button"
                onClick={() => setCode((on) => !on)}
                className="cursor-pointer text-[13px] font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
            >
                {code ? 'Show as words' : 'Show as code'}
            </button>
        </div>
    );
}
