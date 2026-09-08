import type { ReactNode } from 'react';

/* Page title block: a mono eyebrow, the title in sans, a sentence of context. */
export function PageHeader({
    eyebrow,
    title,
    description,
    children,
}: {
    eyebrow?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b px-5 py-6 sm:px-8 sm:py-8">
            <div className="min-w-0">
                {eyebrow && <p className="eyebrow mb-3 text-muted-foreground">{eyebrow}</p>}
                <h1 className="text-2xl font-medium tracking-tight wrap-anywhere sm:text-3xl">
                    {title}
                </h1>
                {description && (
                    <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
            {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
        </div>
    );
}
