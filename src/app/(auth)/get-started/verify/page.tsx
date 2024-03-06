import { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { VerificationForm } from '@/app/(auth)/get-started/verify/verification-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { clientEnvs } from '@/env/client';
import { Routes } from '@/lib/routes';

export const metadata: Metadata = {
    title: 'Verify Your Email',
    keywords: ['HushOS', 'Verify Your Email'],
    description: 'Almost there!',
    openGraph: {
        title: 'Verify Your Email',
        url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}${Routes.verify()}`,
        description: 'Almost there!',
        type: 'website',
    },
    twitter: {
        title: 'Verify Your Email',
        description: 'Almost there!',
        card: 'summary_large_image',
    },
};

export default function VerifyPage({
    searchParams: { email },
}: {
    searchParams: { email: string | string[] | undefined };
}) {
    if (!email || Array.isArray(email)) {
        return redirect(Routes.getStarted());
    }

    return (
        <div className='flex h-full items-center'>
            <Card className='mx-auto w-[32rem] max-w-[32rem]'>
                <CardHeader>
                    <CardTitle>Almost there!</CardTitle>
                    <CardDescription>You won&apos;t be disappointed, we promise!</CardDescription>
                </CardHeader>
                <CardContent>
                    <VerificationForm email={email} />
                </CardContent>
            </Card>
        </div>
    );
}
