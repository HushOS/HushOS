import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { Operator } from '@/lib/social';
import { Mdx } from '@/components/mdx';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { formatDate } from '@/lib/content';

export function ReadingPage({
    eyebrow,
    title,
    summary,
    children,
}: {
    eyebrow: ReactNode;
    title: string;
    summary?: string;
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-8 sm:py-14">
                {/* One sheet for the whole document, the text held to a reading measure inside it. */}
                <article className="sheet px-6 py-10 sm:px-12 sm:py-14">
                    <div className="mx-auto max-w-[70ch]">
                        <p className="eyebrow text-muted-foreground">{eyebrow}</p>
                        <h1 className="mt-4 text-3xl font-bold tracking-tight text-balance sm:text-4xl">
                            {title}
                        </h1>
                        {summary && (
                            <p className="mt-4 text-lg leading-relaxed text-pretty text-muted-foreground">
                                {summary}
                            </p>
                        )}
                        <div className="mt-8 border-t border-rule pt-4">{children}</div>
                    </div>
                </article>
            </main>
            <SiteFooter />
        </div>
    );
}

const OperatorContext = createContext<Operator>(null);

/* Names the Operator inside the legal documents, or the generic phrase when unset. */
export function OperatorName({ generic }: { generic: string }) {
    const operator = useContext(OperatorContext);
    if (!operator) return <>{generic}</>;
    return (
        <>
            {operator.name}
            {operator.jurisdiction && `, ${operator.jurisdiction}`}
        </>
    );
}

/* How to reach the Operator: a mailto link when configured, else the generic phrase. */
export function OperatorContact({ generic }: { generic: string }) {
    const operator = useContext(OperatorContext);
    if (!operator?.contact) return <>{generic}</>;
    return <a href={`mailto:${operator.contact}`}>{operator.contact}</a>;
}

export function LegalLayout({
    document,
    frontmatter,
    operator = null,
}: {
    document: ComponentType;
    frontmatter: Record<string, unknown>;
    operator?: Operator;
}) {
    const updated = String(frontmatter.updated);
    return (
        <OperatorContext.Provider value={operator}>
            <ReadingPage
                eyebrow={`Last updated ${formatDate(updated)}`}
                title={String(frontmatter.title)}
                summary={String(frontmatter.summary)}
            >
                <Mdx document={document} />
            </ReadingPage>
        </OperatorContext.Provider>
    );
}
