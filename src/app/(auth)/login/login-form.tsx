'use client';

import { useRouter } from 'next/navigation';
import { ErrorMessage } from '@hookform/error-message';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import * as z from 'zod';

import { Button } from '@/components/ui/button';
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { initiateOpaqueCredentialResponseSchema } from '@/schemas/auth';
import { client } from '@/server/client';
import { CryptoWorkerInstance } from '@/services/comlink-crypto';
import { OpaqueWorkerInstance } from '@/services/comlink-opaque';
import { useCryptoStore } from '@/stores/crypto-store';

const schemaWithPassword = z.intersection(
    initiateOpaqueCredentialResponseSchema.omit({
        request: true,
    }),
    z.object({
        password: z.string().min(1, { message: 'Password is required.' }),
    })
);

type SchemaWithPassword = z.infer<typeof schemaWithPassword>;

export function LoginForm() {
    const { push } = useRouter();
    const setData = useCryptoStore(state => state.setData);
    const { mutate, isPending } = useMutation<unknown, Error, SchemaWithPassword, unknown>({
        mutationKey: ['register'],
        mutationFn: async () => {},
        onSuccess: async (_, { email, password }) => {
            const opaque = OpaqueWorkerInstance;
            const { pubHex, secHex } = await opaque.createCredentialRequest(password);

            const serverResp = await client.api.auth.login['create-credential-response'].$post({
                json: { email, request: pubHex },
            });
            const { response } = await serverResp.json();

            const { authUHex } = await opaque.recoverCredentials(email, secHex, response);

            const userKeysResp = await client.api.auth.login['user-auth'].$post({
                json: {
                    email,
                    authU: authUHex,
                },
            });
            const userKeys = await userKeysResp.json();

            const crypto = CryptoWorkerInstance;
            const keyBundle = await crypto.decryptRequiredKeys(password, userKeys);

            setData({
                masterKey: keyBundle.mainKey,
                privateKey: keyBundle.asymmetricPrivateKey,
                signingPrivateKey: keyBundle.signingPrivateKey,
            });

            push(Routes.drive());
        },
        onError: () => {
            toast.error('Login failed.');
        },
    });

    const form = useForm<SchemaWithPassword>({
        resolver: zodResolver(schemaWithPassword),
        defaultValues: {
            email: '',
            password: '',
        },
        criteriaMode: 'all',
    });

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(values => mutate(values))} className='space-y-4'>
                <FormField
                    control={form.control}
                    name='email'
                    render={({ field }) => (
                        <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                                <Input
                                    autoComplete='email'
                                    placeholder='hey@hushos.com'
                                    {...field}
                                />
                            </FormControl>
                            <FormMessage />
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
                                </div>
                                <FormControl>
                                    <PasswordInput
                                        placeholder='Your password'
                                        autoComplete='current-password'
                                        {...field}
                                    />
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
                    Login
                </Button>
            </form>
        </Form>
    );
}
