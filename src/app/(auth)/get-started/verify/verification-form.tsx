'use client';

import { useRouter } from 'next/navigation';
import { ErrorMessage } from '@hookform/error-message';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { trackEvent } from '@/components/analytics';
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
import {
    InputOTP,
    InputOTPGroup,
    InputOTPSeparator,
    InputOTPSlot,
} from '@/components/ui/input-otp';
import { PasswordInput } from '@/components/ui/password-input';
import { Routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { initiateOpaqueRegistrationResponseSchema } from '@/schemas/auth';
import { client } from '@/server/client';
import { CryptoWorkerInstance } from '@/services/comlink-crypto';
import { OpaqueWorkerInstance } from '@/services/comlink-opaque';
import { useCryptoStore } from '@/stores/crypto-store';

const schemaWithPassword = z.intersection(
    initiateOpaqueRegistrationResponseSchema.omit({
        request: true,
    }),
    z.object({
        password: z
            .string()
            .min(8, { message: 'Password must be at least 8 characters.' })
            .max(64, { message: 'Password must be at most 64 characters.' }),
    })
);

type SchemaWithPassword = z.infer<typeof schemaWithPassword>;

export function VerificationForm({ email }: { email: string }) {
    const form = useForm<SchemaWithPassword>({
        resolver: zodResolver(schemaWithPassword),
        defaultValues: {
            confirmationCode: '',
            email,
            password: '',
        },
        criteriaMode: 'all',
    });

    const setData = useCryptoStore(state => state.setData);
    const router = useRouter();
    const { mutate, isPending } = useMutation<unknown, Error, SchemaWithPassword>({
        mutationKey: ['user-verification'],
        mutationFn: async ({ confirmationCode, email, password }) => {
            const opaque = OpaqueWorkerInstance;
            const { mHex, secHex } = await opaque.createRegistrationRequest(password);

            const resp = await client.api.auth.register['create-registration-response'].$post({
                json: {
                    email,
                    confirmationCode,
                    request: mHex,
                },
            });
            const { response } = await resp.json();

            const { exportKeyHex: _, recHex } = await opaque.finalizeRequest(
                secHex,
                response,
                email
            );

            const crypto = CryptoWorkerInstance;
            const keyBundle = await crypto.generateRequiredKeys(password);

            await client.api.auth.register['store-user-record'].$post({
                json: {
                    record: recHex,
                    email,
                    confirmationCode,
                    userKeys: keyBundle.cryptoProperties,
                },
            });

            setData({
                masterKey: keyBundle.mainKey,
                privateKey: keyBundle.asymmetricPrivateKey,
                signingPrivateKey: keyBundle.signingPrivateKey,
                recoveryKeyMnemonic: keyBundle.recoveryMnemonic,
                publicKey: keyBundle.cryptoProperties.asymmetricKeyBundle.publicKey,
                signingPublicKey: keyBundle.cryptoProperties.signingKeyBundle.publicKey,
            });

            trackEvent('Signup');

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
                                    <InputOTP maxLength={8} {...field}>
                                        <InputOTPGroup>
                                            <InputOTPSlot index={0} />
                                            <InputOTPSlot index={1} />
                                            <InputOTPSlot index={2} />
                                            <InputOTPSlot index={3} />
                                        </InputOTPGroup>
                                        <InputOTPSeparator />
                                        <InputOTPGroup>
                                            <InputOTPSlot index={4} />
                                            <InputOTPSlot index={5} />
                                            <InputOTPSlot index={6} />
                                            <InputOTPSlot index={7} />
                                        </InputOTPGroup>
                                    </InputOTP>
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
