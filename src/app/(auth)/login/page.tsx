import { Metadata } from 'next';
import Link from 'next/link';

import { LoginForm } from '@/app/(auth)/login/login-form';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { clientEnvs } from '@/env/client';
import { Routes } from '@/lib/routes';

export const metadata: Metadata = {
    title: 'Login',
    keywords: ['HushOS', 'Login'],
    description: 'Welcome back!',
    openGraph: {
        title: 'Login',
        url: `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}${Routes.getStarted()}`,
        description: 'Welcome back!',
        type: 'website',
    },
    twitter: {
        title: 'Login',
        description: 'Welcome back!',
        card: 'summary_large_image',
    },
};

export default function GetStartedPage() {
    return (
        <div className='flex h-full items-center'>
            <Card className='mx-auto w-[32rem] max-w-lg'>
                <CardHeader>
                    <CardTitle>Login</CardTitle>
                    <CardDescription>Welcome back!</CardDescription>
                </CardHeader>
                <CardContent>
                    <LoginForm />
                </CardContent>
                <CardFooter className='flex-col items-start gap-2 text-sm'>
                    <div>
                        <span>Don&apos;t have an account? </span>
                        <Link className='text-blue-600 underline' href={Routes.getStarted()}>
                            Get Started
                        </Link>
                    </div>
                    <div>
                        <Link className='text-blue-600 underline' href={Routes.resetPassword()}>
                            Forgot your password?
                        </Link>
                    </div>
                </CardFooter>
            </Card>
        </div>
    );
}
