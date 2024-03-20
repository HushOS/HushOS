import { ReactNode } from 'react';
import { cookies } from 'next/headers';

import { PlatformShell } from '@/components/platform-shell';
import { ensureAuthenticated } from '@/lib/utils.server';

export default async function PlatformLayout({ children }: { children: ReactNode }) {
    const user = await ensureAuthenticated();

    const defaultLayoutString = cookies().get('react-resizable-panels:layout')?.value ?? '[20, 80]';
    let defaultLayout = JSON.parse(defaultLayoutString) as Array<number>;
    if (!Array.isArray(defaultLayout) || defaultLayout.length !== 2) {
        defaultLayout = [20, 80];
    }

    const isCollapsed = cookies().get('react-resizable-panels:collapsed')?.value === 'true';

    return (
        <PlatformShell
            navCollapsedSize={4}
            defaultLayout={defaultLayout}
            defaultCollapsed={isCollapsed}>
            {children}
        </PlatformShell>
    );
}
