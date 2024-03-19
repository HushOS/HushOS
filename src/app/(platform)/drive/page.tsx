import { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { clientEnvs } from '@/env/client';
import { Routes } from '@/lib/routes';
import { ensureAuthenticated } from '@/lib/utils.server';
import { client } from '@/server/client';

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

export default async function DrivePage() {
    const user = await ensureAuthenticated();

    return (
        <div className='flex h-full items-center'>
            <Card className='mx-auto w-[32rem] max-w-lg'>
                <CardHeader>
                    <CardTitle>Hey, {user.email}!</CardTitle>
                </CardHeader>
                <CardContent>
                    <div>
                        <div>Thank you checking us out!</div>
                        <div>Drive will be available soon.</div>
                    </div>
                </CardContent>
                <CardFooter>
                    <Button asChild>
                        <Link href={client.api.auth.logout.$url().pathname}>Logout</Link>
                    </Button>
                </CardFooter>
            </Card>
        </div>
    );
}
