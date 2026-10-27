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

/*
 * The identity a marketing page wears over the shared spine (see identities.css
 * and DESIGN.md → Dither). A page without one is plain Alpine, on the ground rather than
 * the raised surface in the dark.
 */
export type Identity =
    | 'home'
    | 'blog'
    | 'about'
    | 'security'
    | 'pricing'
    | 'teams'
    | 'roadmap'
    | 'offer'
    | 'invite'
    | 'compare';

/* A public page's outermost element: the full-height column, in its identity's colours. */
export function SitePage({ identity, children }: { identity?: Identity; children: ReactNode }) {
    return (
        <div
            data-site=""
            data-identity={identity}
            className="flex min-h-svh flex-col bg-card text-foreground"
        >
            {children}
        </div>
    );
}

/* How far through a long page you are: a hairline across the top, driven by the scroll alone. */
export function ReadProgress() {
    return <div aria-hidden="true" className="read-progress" />;
}

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

/*
 * Measures are in em, not ch: a ch is the width of the font's zero, so a ch-wide box shrank 12%
 * while the fallback font showed and the text re-wrapped when Geist arrived. 1ch of Geist = 0.663em.
 */
export function Lede({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <p
            className={cn(
                'max-w-[41.1em] text-[17px] leading-[1.55] text-pretty text-muted-foreground sm:text-xl',
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
    // The header's button stays 36px on touch screens too, where buttons grow to 44: at 44 it
    // filled the 56px header and outweighed the page's own call to action. The tap area keeps 44.
    const compact = short
        ? "relative pointer-coarse:h-9! pointer-coarse:px-3.5! after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']"
        : undefined;
    if (hasSession)
        return (
            <Link
                to="/app/drive"
                className={buttonVariants({ size, className: cn(compact, className) })}
            >
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
        <Link
            to="/register"
            className={buttonVariants({ size, className: cn(compact, className) })}
        >
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

/*
 * Two or three choices in one switch; the chosen one is raised and bold. `showLabel`
 * draws the legend above it as the visible label, so the name is said once; `disabled`
 * holds every choice while a change is saving.
 */
export function SiteSwitch<T extends string>({
    label,
    options,
    value,
    onChange,
    showLabel = false,
    disabled = false,
    className,
}: {
    label: string;
    options: { value: T; label: ReactNode }[];
    value: T;
    onChange: (value: T) => void;
    showLabel?: boolean;
    disabled?: boolean;
    className?: string;
}) {
    const choices = (
        <fieldset
            disabled={disabled}
            aria-busy={disabled || undefined}
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
                        // 40px drawn, 44px to a finger: the tap area reaches into the track's padding.
                        "relative flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-4 text-[15px] whitespace-nowrap outline-none after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:cursor-default disabled:opacity-60",
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
    if (!showLabel) return choices;
    // The visible label is a heading over the switch, hidden from screen readers, who hear the legend.
    return (
        <div className="flex flex-col gap-2">
            <span aria-hidden="true" className="text-sm font-semibold">
                {label}
            </span>
            {choices}
        </div>
    );
}
