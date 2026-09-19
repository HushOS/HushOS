import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

export type FaqItem = { q: string; a: string };

/*
 * Questions people ask, one per row with a hairline between, the answer
 * folded under its question. Used on the home page and inside posts.
 */
export function Faq({ items, className = '' }: { items: FaqItem[]; className?: string }) {
    return (
        <Accordion multiple className={className}>
            {items.map(({ q, a }) => (
                <AccordionItem key={q} value={q}>
                    <AccordionTrigger className="gap-6 py-4 text-base font-semibold text-balance">
                        {q}
                    </AccordionTrigger>
                    <AccordionContent className="max-w-[65ch] pb-5 text-[15px] leading-relaxed text-pretty text-muted-foreground">
                        {a}
                    </AccordionContent>
                </AccordionItem>
            ))}
        </Accordion>
    );
}
