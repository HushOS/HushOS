import { tokenize } from '@hushos/drive/client';
import { Fragment, useMemo } from 'react';

/* The parts of a name a query landed on, marked; whole words first, then prefixes inside words. */
export function Highlight({ text, query }: { text: string; query: string }) {
    const parts = useMemo(() => {
        const words = tokenize(query);
        if (!words.length) return [{ text, hit: false }];
        const lower = text.toLowerCase();
        const ranges: [number, number][] = [];
        for (const word of words) {
            let from = 0;
            for (;;) {
                const at = lower.indexOf(word, from);
                if (at < 0) break;
                ranges.push([at, at + word.length]);
                from = at + word.length;
            }
        }
        ranges.sort((a, b) => a[0] - b[0]);
        const out: { text: string; hit: boolean }[] = [];
        let cursor = 0;
        for (const [start, end] of ranges) {
            if (end <= cursor) continue;
            const begin = Math.max(start, cursor);
            if (begin > cursor) out.push({ text: text.slice(cursor, begin), hit: false });
            out.push({ text: text.slice(begin, end), hit: true });
            cursor = end;
        }
        if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
        return out;
    }, [text, query]);
    return (
        <>
            {parts.map((part, index) => (
                <Fragment key={index}>
                    {part.hit ? (
                        <mark className="rounded-xs bg-warning-soft text-foreground">
                            {part.text}
                        </mark>
                    ) : (
                        part.text
                    )}
                </Fragment>
            ))}
        </>
    );
}
