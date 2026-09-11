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
            <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8 sm:py-16">
                <p className="eyebrow text-muted-foreground">{eyebrow}</p>
                <h1 className="mt-4 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
                    {title}
                </h1>
                {summary && (
                    <p className="mt-4 text-base leading-relaxed text-pretty text-muted-foreground">
                        {summary}
                    </p>
                )}
                <div className="mt-8 border-t pt-2 text-[0.9375rem]">{children}</div>
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
