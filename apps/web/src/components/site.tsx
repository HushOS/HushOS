import { useQuery } from '@tanstack/react-query';
import { Link, useRouteContext, type LinkProps } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { formatQuota } from '@/lib/queries';
import { salesContactQueryOptions } from '@/lib/social';

/*
 * The public site's furniture, shared by every page: one centred column, the
 * headings and lede, the quiet arrow link, the one primary action said the same
 * way everywhere, "Talk to us", and questions that open in place.
 */

/* The column the header, the footer and every section keep to. */
export const container = 'mx-auto w-full max-w-6xl px-4 sm:px-8';

export function H1({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <h1
            className={cn(
                'text-[40px] leading-[1.05] font-extrabold tracking-[-0.035em] text-balance sm:text-[56px] lg:text-[64px] lg:leading-[1.02] lg:tracking-[-0.04em]',
                className,
            )}
        >
            {children}
        </h1>
    );
}

export function H2({
    children,
    className,
    id,
}: {
    children: ReactNode;
    className?: string;
    id?: string;
}) {
    return (
        <h2
            id={id}
            className={cn(
                'text-[26px] leading-[1.15] font-extrabold tracking-[-0.025em] text-balance sm:text-[36px] sm:leading-[1.1] sm:tracking-[-0.03em]',
                className,
            )}
        >
            {children}
        </h2>
    );
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <p
            className={cn(
                'max-w-[62ch] text-[17px] leading-[1.55] text-pretty text-muted-foreground sm:text-xl',
                className,
            )}
        >
            {children}
        </p>
    );
}

/* A quiet link with an arrow: the secondary action of a section. */
export function TextLink({
    children,
    className,
    ...link
}: { children: ReactNode; className?: string } & (
    | { to: LinkProps['to']; href?: never; search?: LinkProps['search'] }
    | { href: string; to?: never; search?: never }
)) {
    const classes = cn(
        'inline-flex w-fit items-center gap-1.5 text-base font-semibold text-primary underline-offset-4 hover:underline',
        className,
    );
    const inside = (
        <>
            {children}
            <ArrowRightIcon className="size-4" strokeWidth={2.3} aria-hidden="true" />
        </>
    );
    return link.href ? (
        <a href={link.href} target="_blank" rel="noreferrer" className={classes}>
            {inside}
        </a>
    ) : (
        <Link to={link.to} search={link.search} className={classes}>
            {inside}
        </Link>
    );
}

/*
 * The site's one primary action, said the same way everywhere: start free with
 * the free allowance, or, where this server sells nothing, create an account;
 * and when this browser is already signed in, go to the drive.
 */
export function StartFree({
    short = false,
    className,
}: {
    /* "Start free" in the header; "Start free with 2 GB" everywhere else. */
    short?: boolean;
    className?: string;
}) {
    const { hasSession, billingEnabled, freeQuotaBytes } = useRouteContext({ from: '__root__' });
    const size = short ? 'default' : 'lg';
    if (hasSession)
        return (
            <Link to="/app/drive" className={buttonVariants({ size, className })}>
                Go to Drive
            </Link>
        );
    const label = !billingEnabled
        ? short
            ? 'Create account'
            : 'Create an account'
        : short
          ? 'Start free'
          : `Start free with ${formatQuota(freeQuotaBytes)}`;
    return (
        <Link to="/register" className={buttonVariants({ size, className })}>
            {label}
        </Link>
    );
}

/*
 * "Talk to us": an email to SALES_CONTACT with the subject already written.
 * Nothing is drawn when no address is set, as on most self-hosted servers.
 */
export function TalkToUs({
    className,
    variant = 'default',
}: {
    className?: string;
    variant?: 'default' | 'outline';
}) {
    const { data: contact } = useQuery(salesContactQueryOptions);
    if (!contact) return null;
    return (
        <a
            href={`mailto:${contact}?subject=${encodeURIComponent('HushOS for teams')}`}
            className={buttonVariants({ size: 'lg', variant, className })}
        >
            Talk to us
        </a>
    );
}

/* Questions that open in place: the shadcn accordion, styled for the site. */
export { Faq, type FaqItem as Question } from '@/components/faq';

/* Two or three choices in one switch; the chosen one is raised and bold. */
export function SiteSwitch<T extends string>({
    label,
    options,
    value,
    onChange,
    className,
}: {
    label: string;
    options: { value: T; label: ReactNode }[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}) {
    return (
        <fieldset
            className={cn('m-0 flex min-w-0 gap-1 rounded-md border-0 bg-muted p-1', className)}
        >
            <legend className="sr-only">{label}</legend>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    aria-pressed={value === option.value}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        'flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-4 text-[15px] whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring',
                        value === option.value
                            ? 'bg-card font-bold text-foreground shadow-sm'
                            : 'font-medium text-muted-foreground hover:text-foreground',
                    )}
                >
                    {option.label}
                </button>
            ))}
        </fieldset>
    );
}
