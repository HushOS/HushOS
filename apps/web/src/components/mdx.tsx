/* eslint-disable jsx-a11y/heading-has-content, jsx-a11y/anchor-has-content, jsx-a11y/alt-text -- MDX passes content and alt text through props */
import { MDXProvider } from '@mdx-js/react';
import { Link, useRouteContext } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

/*
 * The one component map for every MDX document. Headings are in the text
 * face and set apart by space, so a long page scans; internal links route
 * client-side. Documents may also import their own components.
 */
export const mdxComponents: MDXComponents = {
    h1: (props) => (
        <h1 className="mt-10 text-3xl font-bold tracking-tight text-balance" {...props} />
    ),
    h2: (props) => (
        <h2
            className="mt-12 text-2xl font-bold tracking-tight text-balance first:mt-4"
            {...props}
        />
    ),
    h3: (props) => <h3 className="mt-8 text-lg font-bold" {...props} />,
    p: (props) => <p className="mt-4 leading-relaxed" {...props} />,
    img: (props) => (
        <img
            className="mt-6 block w-full rounded-xs border border-rule"
            loading="lazy"
            {...props}
        />
    ),
    ul: (props) => (
        <ul className="mt-3 list-['–_'] space-y-1.5 pl-5 text-muted-foreground" {...props} />
    ),
    ol: (props) => (
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground" {...props} />
    ),
    li: (props) => <li className="pl-1 leading-relaxed" {...props} />,
    strong: (props) => <strong className="font-bold text-foreground" {...props} />,
    hr: () => <hr className="my-8 border-rule" />,
    blockquote: (props) => (
        <blockquote className="mt-4 border-l-2 border-rule pl-4 text-muted-foreground" {...props} />
    ),
    code: (props) => (
        <code className="rounded-xs bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props} />
    ),
    pre: (props) => (
        <pre
            className="mt-4 overflow-x-auto rounded-md border border-rule bg-muted p-4 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
            {...props}
        />
    ),
    table: (props) => (
        <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" {...props} />
        </div>
    ),
    th: (props) => (
        <th
            className="eyebrow border-b border-rule py-2 pr-4 text-left text-muted-foreground"
            {...props}
        />
    ),
    td: (props) => <td className="border-b border-rule py-2 pr-4 align-top" {...props} />,
    a: ({ href = '', ...props }: ComponentProps<'a'>) =>
        href.startsWith('/') ? (
            <Link to={href} className="text-link" {...props} />
        ) : (
            <a href={href} className="text-link" rel="noreferrer" {...props} />
        ),
};

/*
 * A call to action inside a document: one sentence and the one blue button.
 * A reader with a session goes to Drive; everyone else to sign-up.
 */
export function Cta({ children, title = 'Try it' }: { children: ReactNode; title?: string }) {
    const { hasSession } = useRouteContext({ from: '__root__' });
    return (
        <aside className="sheet mt-8 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 border border-rule px-5 py-5">
            <div className="min-w-0 flex-1 basis-64">
                <p className="eyebrow text-muted-foreground">{title}</p>
                {/* MDX wraps the text in its own paragraph, so this must not be one. */}
                <div className="mt-2 text-base leading-relaxed text-pretty [&>p]:mt-0">
                    {children}
                </div>
            </div>
            <Button
                render={<Link to={hasSession ? '/app/drive' : '/register'} />}
                nativeButton={false}
                size="lg"
            >
                {hasSession ? 'Open Drive' : 'Get started'} <ArrowRightIcon aria-hidden="true" />
            </Button>
        </aside>
    );
}

/* A key/value list with dotted leaders, for use inside MDX: <Ledger rows={[['Protocol', 'OPAQUE']]} /> */
export function Ledger({ rows }: { rows: [string, string][] }) {
    return (
        <dl className="mt-4 rounded-md bg-muted px-4 py-1.5 text-sm">
            {rows.map(([key, value]) => (
                <div
                    key={key}
                    className="grid gap-x-6 gap-y-1 border-b border-dotted border-rule py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
                >
                    <dt className="font-semibold">{key}</dt>
                    <dd className="leading-relaxed text-muted-foreground">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

/* A soft-filled aside inside MDX. */
export function Note({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <aside className="mt-4 rounded-md border border-rule bg-muted px-4 py-3">
            {title && <p className="eyebrow pt-1 text-foreground">{title}</p>}
            <div className="mt-2 text-sm leading-relaxed text-muted-foreground [&>p]:mt-0">
                {children}
            </div>
        </aside>
    );
}

export function Mdx({
    document: Document,
}: {
    document: ComponentType<{ components?: MDXComponents }>;
}) {
    return (
        <MDXProvider components={mdxComponents}>
            <Document />
        </MDXProvider>
    );
}
