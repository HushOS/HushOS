/* eslint-disable jsx-a11y/heading-has-content, jsx-a11y/anchor-has-content -- MDX passes content through props */
import { MDXProvider } from '@mdx-js/react';
import { Link } from '@tanstack/react-router';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps, ComponentType, ReactNode } from 'react';

/*
 * The one component map for every MDX document. Headings read as ledger
 * eyebrows, paragraphs stay in sans for reading comfort, and internal links
 * route client-side. Documents may also import their own components.
 */
export const mdxComponents: MDXComponents = {
    h1: (props) => (
        <h1 className="mt-10 text-3xl font-medium tracking-tight text-balance" {...props} />
    ),
    h2: (props) => <h2 className="eyebrow mt-10 text-foreground" {...props} />,
    h3: (props) => <h3 className="mt-6 text-base font-medium tracking-tight" {...props} />,
    p: (props) => <p className="mt-3 leading-relaxed" {...props} />,
    ul: (props) => (
        <ul className="mt-3 list-['–_'] space-y-1.5 pl-5 text-muted-foreground" {...props} />
    ),
    ol: (props) => (
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground" {...props} />
    ),
    li: (props) => <li className="pl-1 leading-relaxed" {...props} />,
    strong: (props) => <strong className="font-medium text-foreground" {...props} />,
    hr: () => <hr className="my-8" />,
    blockquote: (props) => (
        <blockquote className="mt-4 border-l-2 pl-4 text-muted-foreground" {...props} />
    ),
    code: (props) => <code className="bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props} />,
    pre: (props) => (
        <pre
            className="mt-4 overflow-x-auto border bg-card p-4 font-mono text-[13px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit"
            {...props}
        />
    ),
    table: (props) => (
        <div className="mt-4 overflow-x-auto border">
            <table className="w-full font-mono text-[13px]" {...props} />
        </div>
    ),
    th: (props) => (
        <th className="eyebrow border-b px-3 py-2 text-left text-muted-foreground" {...props} />
    ),
    td: (props) => <td className="border-b px-3 py-2 align-top" {...props} />,
    a: ({ href = '', ...props }: ComponentProps<'a'>) =>
        href.startsWith('/') ? (
            <Link to={href} className="text-link" {...props} />
        ) : (
            <a href={href} className="text-link" rel="noreferrer" {...props} />
        ),
};

/* A key/value ledger for use inside MDX: <Ledger rows={[['Protocol', 'OPAQUE']]} /> */
export function Ledger({ rows }: { rows: [string, string][] }) {
    return (
        <dl className="mt-4 border bg-card font-mono text-[13px]">
            {rows.map(([key, value]) => (
                <div
                    key={key}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] border-b last:border-b-0"
                >
                    <dt className="eyebrow flex items-center border-r px-3 py-2.5 text-muted-foreground">
                        {key}
                    </dt>
                    <dd className="px-3 py-2.5">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

/* A bordered note inside MDX. */
export function Note({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <aside className="mt-4 border bg-card">
            {title && <p className="eyebrow border-b px-4 py-2.5 text-muted-foreground">{title}</p>}
            <div className="px-4 py-3 text-sm leading-relaxed text-muted-foreground [&>p]:mt-0">
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
