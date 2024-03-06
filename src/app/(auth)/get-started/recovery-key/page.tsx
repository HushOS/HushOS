import { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { RecoveryKey } from '@/app/(auth)/get-started/recovery-key/recovery-key';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { clientEnvs } from '@/env/client';
import { Routes } from '@/lib/routes';
import { getUser } from '@/lib/utils.server';

export const metadata: Metadata = {
    title: 'Recovery Key',
    keywords: ['HushOS', 'Recovery Key'],
    description: 'Download Your Recovery Key',
    openGraph: {
        title: 'Recovery Key',
        url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}${Routes.recoveryKey()}`,
        description: 'Download Your Recovery Key',
        type: 'website',
    },
    twitter: {
        title: 'Recovery Key',
        description: 'Download Your Recovery Key',
        card: 'summary_large_image',
    },
};

export default async function RecoveryKeyPage() {
    const user = await getUser();
    if (!user) {
        return redirect(Routes.login());
    }

    return (
        <div className='flex h-full items-center'>
            <Card className='mx-auto w-[32rem] max-w-[32rem]'>
                <CardHeader className='gap-2'>
                    <CardTitle>Recovery Key</CardTitle>
                    <div className='flex flex-col gap-2 text-sm text-muted-foreground'>
                        <div>
                            This is your recovery key, please download and save it somewhere safe.
                        </div>
                        <div>
                            Note: We do not have access to your password and your master key, so
                            this key is the only way to recover your account if you lose your
                            password.
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <RecoveryKey />
                </CardContent>
                <CardFooter>
                    <Button className='ml-auto w-full' asChild>
                        <Link href={Routes.drive()}>Complete Set Up</Link>
                    </Button>
                </CardFooter>
            </Card>
        </div>
    );
}
