'use client';

import { useRouter } from 'next/navigation';
import { ErrorMessage } from '@hookform/error-message';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { MultipleFieldErrors, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { OTPInput } from '@/components/otp-input';
import { Button } from '@/components/ui/button';
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { zxcvbn } from '@/lib/zxcvbn';
import { createRegistrationResponseInput } from '@/server/api/schemas/auth';
import { CryptoWorkerInstance } from '@/services/comlink-crypto';
import { OpaqueWorkerInstance } from '@/services/comlink-opaque';
import { useCryptoStore } from '@/stores/crypto-store';
import { api } from '@/trpc/react';

const schemaWithPassword = z.intersection(
    createRegistrationResponseInput.omit({
        request: true,
    }),
    z.object({
        password: z.string().min(1, { message: 'Password is required.' }),
    })
);

export function VerificationForm({ email }: { email: string }) {
    const form = useForm<z.infer<typeof schemaWithPassword>>({
        resolver: zodResolver(schemaWithPassword),
        defaultValues: {
            confirmationCode: '',
            email,
            password: '',
        },
        criteriaMode: 'all',
    });

    const createRegistrationResponse = api.auth.createRegistrationResponse.useMutation();
    const storeUserRecord = api.auth.storeUserRecord.useMutation();
    const setData = useCryptoStore(state => state.setData);
    const router = useRouter();
    const { mutate, isPending } = useMutation({
        mutationKey: ['user-verification'],
        mutationFn: async ({
            confirmationCode,
            email,
            password,
        }: z.infer<typeof schemaWithPassword>) => {
            const zxcvbnResult = zxcvbn(password, [email]);
            if (zxcvbnResult.score <= 2) {
                const types: MultipleFieldErrors = {};
                let lastId = 0;
                zxcvbnResult.feedback.suggestions.forEach((error, i) => {
                    lastId = i + 1;
                    types[`password${lastId}`] = error;
                });

                if (zxcvbnResult.feedback.warning) {
                    types[`password${lastId + 1}`] = zxcvbnResult.feedback.warning;
                }

                form.setError('password', {
                    types,
                });

                return;
            }

            const opaque = OpaqueWorkerInstance;
            const { mHex, secHex } = await opaque.createRegistrationRequest(password);

            const { response } = await createRegistrationResponse.mutateAsync({
                email,
                confirmationCode,
                request: mHex,
            });

            const { exportKeyHex: _, recHex } = await opaque.finalizeRequest(
                secHex,
                response,
                email
            );

            const crypto = CryptoWorkerInstance;
            const keyBundle = await crypto.generateRequiredKeys(password);

            await storeUserRecord.mutateAsync({
                record: recHex,
                email,
                confirmationCode,
                userKeys: keyBundle.cryptoProperties,
            });

            setData({
                masterKey: keyBundle.mainKey,
                privateKey: keyBundle.asymmetricPrivateKey,
                signingPrivateKey: keyBundle.signingPrivateKey,
                recoveryKeyMnemonic: keyBundle.recoveryMnemonic,
                publicKey: keyBundle.cryptoProperties.asymmetricKeyBundle.publicKey,
                signingPublicKey: keyBundle.cryptoProperties.signingKeyBundle.publicKey,
            });

            router.push(Routes.recoveryKey());
        },
        onError: () => {
            toast.error('Registration failed. Please try again.');
        },
    });

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(values => mutate(values))} className='space-y-4'>
                <FormField
                    control={form.control}
                    name='confirmationCode'
                    render={({ field }) => (
                        <FormItem>
                            <div className='space-y-2 leading-none'>
                                <div className='space-y-1'>
                                    <FormLabel>Confirmation Code</FormLabel>
                                    <FormDescription>Check your email.</FormDescription>
                                </div>
                                <FormControl>
                                    <OTPInput {...field} />
                                </FormControl>
                                <FormMessage />
                            </div>
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name='email'
                    render={({ field }) => (
                        <FormItem>
                            <div className='space-y-2 leading-none'>
                                <div className='space-y-1'>
                                    <FormLabel>Email</FormLabel>
                                </div>
                                <FormControl>
                                    <Input readOnly {...field} />
                                </FormControl>
                                <FormMessage />
                            </div>
                        </FormItem>
                    )}
                />
                <FormField
                    control={form.control}
                    name='password'
                    render={({ field }) => (
                        <FormItem>
                            <div className='space-y-2 leading-none'>
                                <div className='space-y-1'>
                                    <FormLabel>Password</FormLabel>
                                    <FormDescription>Choose a strong password.</FormDescription>
                                </div>
                                <FormControl>
                                    <PasswordInput {...field} />
                                </FormControl>
                                <ErrorMessage
                                    errors={form.formState.errors}
                                    name={field.name}
                                    render={({ messages }) =>
                                        messages &&
                                        Object.entries(messages).map(([type, message]) => (
                                            <p
                                                className='text-sm font-medium text-destructive'
                                                key={type}>
                                                {message}
                                            </p>
                                        ))
                                    }
                                />
                            </div>
                        </FormItem>
                    )}
                />
                <Button type='submit' disabled={isPending}>
                    <Loader2
                        className={cn('mr-2 size-4 animate-spin', {
                            [`inline`]: isPending,
                            [`hidden`]: !isPending,
                        })}
                    />
                    Continue
                </Button>
            </form>
        </Form>
    );
}
