import { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { clientEnvs } from '@/env/client';
import { Routes } from '@/lib/routes';
import { ensureAuthenticated } from '@/lib/utils.server';

export const metadata: Metadata = {
    title: 'Drive',
    keywords: ['HushOS', 'Drive'],
    description: 'HushDrive',
    openGraph: {
        title: 'Drive',
        url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}${Routes.getStarted()}`,
        description: 'HushDrive',
        type: 'website',
    },
    twitter: {
        title: 'Drive',
        description: 'HushDrive',
        card: 'summary_large_image',
    },
};

export default async function DrivePage({ params: { ids } }: { params: { ids?: string[] } }) {
    if ((ids?.length ?? 0) > 1) {
        return redirect(Routes.drive());
    }

    const user = await ensureAuthenticated();
    const currentFolderId = ids?.at(0) ?? null;

    return <div className='h-full p-2'></div>;
}
