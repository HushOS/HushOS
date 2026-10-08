import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { isInAppPage, useInApp } from '@/lib/in-app';

/*
 * An internal link on a page the apps may open. Opened from an app, it keeps
 * ?app=1 between the policy pages and is plain text to anywhere else.
 */
export function PageLink({
    to,
    className,
    children,
}: {
    /* A site path, with a #fragment if it points into the page. */
    to: string;
    className?: string;
    children?: ReactNode;
}) {
    const inApp = useInApp();
    const [path = '', hash] = to.split('#');
    if (!inApp) {
        return (
            <Link to={path} hash={hash} className={className}>
                {children}
            </Link>
        );
    }
    if (!isInAppPage(path)) return <>{children}</>;
    return (
        <Link to={path} hash={hash} search={{ app: 1 } as never} className={className}>
            {children}
        </Link>
    );
}
