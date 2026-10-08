import type { ReactNode } from 'react';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

export type FaqItem = { q: string; a: ReactNode };

/*
 * Questions people ask, opening in place, a hairline between them. Several can
 * be open at once; the first starts open, so the page shows what it is for.
 */
export function Faq({
    items,
    open = [0],
    className = '',
}: {
    items: FaqItem[];
    /* The questions open to begin with, by position. */
    open?: number[];
    className?: string;
}) {
    return (
        <Accordion
            multiple
            defaultValue={open.map((index) => items[index]?.q).filter(Boolean)}
            className={`border-t border-rule ${className}`}
        >
            {items.map(({ q, a }) => (
                <AccordionItem key={q} value={q} className="border-b border-rule">
                    <AccordionTrigger className="min-h-[60px] gap-6 py-3 text-left text-[17px] font-bold text-balance hover:no-underline sm:min-h-[68px] sm:py-4 sm:text-lg">
                        {q}
                    </AccordionTrigger>
                    <AccordionContent className="max-w-[64ch] pb-5 text-base leading-[1.6] text-pretty text-muted-foreground sm:text-[17px]">
                        {a}
                    </AccordionContent>
                </AccordionItem>
            ))}
        </Accordion>
    );
}
