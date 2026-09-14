import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

export type FaqItem = { q: string; a: string };

/*
 * Questions people ask, one per row, the answer folded under it. Ledger
 * style: every row a bordered cell, the question in sans, the answer opening
 * beneath without moving the rest. Used on the home page and inside posts.
 */
export function Faq({ items, className = '' }: { items: FaqItem[]; className?: string }) {
    return (
        <Accordion multiple className={className}>
            {items.map(({ q, a }, index) => (
                <AccordionItem key={q} value={q} className="border-b last:border-b-0">
                    <AccordionTrigger className="gap-6 rounded-none border-0 px-5 py-5 text-base font-medium tracking-tight text-balance hover:bg-muted sm:px-10 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:text-primary">
                        <span className="flex items-baseline gap-4">
                            <span className="eyebrow shrink-0 text-muted-foreground">
                                Q{index + 1}
                            </span>
                            {q}
                        </span>
                    </AccordionTrigger>
                    <AccordionContent className="max-w-2xl px-5 pb-6 text-sm leading-relaxed text-pretty text-muted-foreground sm:px-10 sm:pl-[4.75rem]">
                        {a}
                    </AccordionContent>
                </AccordionItem>
            ))}
        </Accordion>
    );
}
