import type { ReactNode } from 'react';

/*
 * A page's title row, as Files draws its folder path: the title large, the page's
 * actions on the right, and a sentence of context under it when the page needs one.
 * `back` is a quiet link above the title to the list a detail page came from.
 * `titleAction` sits right beside the title, for an action on the thing it names (Rename).
 */
export function PageHeader({
    back,
    title,
    titleAction,
    description,
    children,
}: {
    back?: ReactNode;
    title: ReactNode;
    titleAction?: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1 px-5 pt-1 pb-5 sm:px-8 sm:pb-6">
            {back && <p className="text-sm font-semibold text-muted-foreground">{back}</p>}
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="flex min-w-0 items-center gap-2">
                    <h1 className="flex min-h-11 min-w-0 items-center text-xl leading-tight font-extrabold tracking-[-0.03em] wrap-anywhere sm:text-[28px]">
                        {title}
                    </h1>
                    {titleAction}
                </div>
                {children && (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
                )}
            </div>
            {description && (
                <p className="max-w-[43.1em] text-[15px] leading-relaxed text-muted-foreground">
                    {description}
                </p>
            )}
        </div>
    );
}
