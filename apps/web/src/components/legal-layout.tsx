import { cn } from 'cn';
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { Operator } from '@/lib/social';
import { Mdx } from '@/components/mdx';
import { Contents } from '@/components/security-page';
import { container, H1, Lede } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { formatDate } from '@/lib/content';

/*
 * A document page (about, the legal pages, the blog): laid out like the
 * security page, the heading and the text held to the same width at the
 * site's left edge, with no box around them.
 */
export type Heading = { id: string; title: string };

export function ReadingPage({
    eyebrow,
    title,
    summary,
    headings = [],
    children,
}: {
    eyebrow: ReactNode;
    title: string;
    summary?: string;
    /* The document's sections; two or more get a contents list, as on the security page. */
    headings?: Heading[];
    children: ReactNode;
}) {
    const contents = headings.length >= 2;
    return (
        <div className="flex min-h-svh flex-col bg-card">
            <SiteHeader />
            <main className="flex-1">
                <div className={cn(container, 'pt-12 pb-10 sm:pt-16 lg:pt-20 lg:pb-14')}>
                    <div className="flex max-w-[780px] flex-col gap-5">
                        <p className="text-[15px] text-muted-foreground">{eyebrow}</p>
                        <H1>{title}</H1>
                        {summary && <Lede>{summary}</Lede>}
                    </div>
                </div>
                <div
                    className={cn(
                        container,
                        'pb-16 lg:pb-24',
                        contents &&
                            'lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start lg:gap-16',
                    )}
                >
                    {contents && (
                        <Contents
                            items={Object.fromEntries(
                                headings.map((heading) => [heading.id, heading.title]),
                            )}
                        />
                    )}
                    <article className="max-w-[760px] min-w-0 text-[17px] [&>h2:first-child]:mt-0">
                        {children}
                    </article>
                </div>
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
    headings,
    operator = null,
}: {
    document: ComponentType;
    frontmatter: Record<string, unknown>;
    headings?: Heading[];
    operator?: Operator;
}) {
    const updated = String(frontmatter.updated);
    return (
        <OperatorContext.Provider value={operator}>
            <ReadingPage
                eyebrow={`Last updated ${formatDate(updated)}`}
                title={String(frontmatter.title)}
                summary={String(frontmatter.summary)}
                headings={headings}
            >
                <Mdx document={document} />
            </ReadingPage>
        </OperatorContext.Provider>
    );
}
