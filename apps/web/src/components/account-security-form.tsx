import type { SecurityAction, SessionUser } from '@hushos/auth/protocol';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useRouter } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError, newPasswordValue } from '@/lib/form';
import { cue } from '@/lib/sounds';

export const securityLabels: Record<SecurityAction, string> = {
    password: 'Change password',
    'master-key': 'Rotate master key',
    'recovery-key': 'Rotate recovery phrase',
};

const notes: Record<SecurityAction, string> = {
    password:
        'Your master key and recovery phrase stay the same. Other sessions will be signed out.',
    'master-key':
        'This replaces your master key and recovery phrase. Your identity keys stay the same. Other sessions will be signed out, and you will save your new 24 words on the next page.',
    'recovery-key':
        'Your current recovery phrase stops working. Your password and master key stay the same. Other sessions will be signed out, and you will save your new 24 words on the next page.',
};

/*
 * One inline ledger form for the three security actions. Each asks for the
 * current password; changing the password also asks for the new one twice.
 */
export function AccountSecurityForm({
    user,
    action,
    onCancel,
    onPending,
    onSuccess,
}: {
    user: SessionUser;
    action: SecurityAction;
    onCancel: () => void;
    onPending: (pending: boolean) => void;
    onSuccess: () => void;
}) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const fields = z
        .object({
            password: z.string().min(1, 'Enter your current password.').max(128),
            newPassword: action === 'password' ? newPasswordValue : z.string(),
            confirmPassword: z.string(),
        })
        .superRefine((value, context) => {
            if (action !== 'password') return;
            if (value.newPassword !== value.confirmPassword)
                context.addIssue({
                    code: 'custom',
                    path: ['confirmPassword'],
                    message: 'Your passwords don’t match.',
                });
            if (value.newPassword === value.password)
                context.addIssue({
                    code: 'custom',
                    path: ['newPassword'],
                    message: 'Choose a password you haven’t used here.',
                });
        });
    const form = useForm({
        defaultValues: { password: '', newPassword: '', confirmPassword: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: fields },
        onSubmit: async ({ value }) => {
            setError('');
            setPending(true);
            onPending(true);
            try {
                const result = await authClient.changeSecurity(
                    user,
                    action,
                    value.password,
                    value.newPassword,
                );
                form.reset();
                cue('success');
                router.options.context.queryClient.clear();
                if (!result.signedIn) {
                    await router.navigate({
                        to: '/login',
                        search: { securityChanged: action },
                        replace: true,
                    });
                } else if (action === 'password') {
                    await router.invalidate();
                    onSuccess();
                } else {
                    await router.navigate({
                        to: '/setup/recovery-key',
                        search: { reason: action },
                        replace: true,
                    });
                }
            } catch (error) {
                cue('error');
                setError(authError(error));
            } finally {
                setPending(false);
                onPending(false);
            }
        },
    });
    return (
        <form
            noValidate
            aria-busy={pending}
            onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
            }}
        >
            <FormTable className="border-0">
                <FormNote>{notes[action]}</FormNote>
                <form.Field name="password">
                    {(field) => (
                        <AuthInput
                            label={action === 'password' ? 'Current' : 'Password'}
                            id={`${action}-password`}
                            name={field.name}
                            type="password"
                            autoComplete="current-password"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onBlur={field.handleBlur}
                            errors={field.state.meta.errors}
                            disabled={pending}
                            required
                            maxLength={128}
                        />
                    )}
                </form.Field>
                {action === 'password' && (
                    <>
                        <form.Field name="newPassword">
                            {(field) => (
                                <AuthInput
                                    label="New password"
                                    hint="12–128 characters. A long, unique passphrase works best."
                                    id="security-new-password"
                                    name={field.name}
                                    type="password"
                                    autoComplete="new-password"
                                    value={field.state.value}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    onBlur={field.handleBlur}
                                    errors={field.state.meta.errors}
                                    disabled={pending}
                                    required
                                    maxLength={128}
                                />
                            )}
                        </form.Field>
                        <form.Field name="confirmPassword">
                            {(field) => (
                                <AuthInput
                                    label="Confirm"
                                    id="security-confirm-password"
                                    name={field.name}
                                    type="password"
                                    autoComplete="new-password"
                                    value={field.state.value}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    onBlur={field.handleBlur}
                                    errors={field.state.meta.errors}
                                    disabled={pending}
                                    required
                                    maxLength={128}
                                />
                            )}
                        </form.Field>
                    </>
                )}
                {error && <FormNote tone="destructive">{error}</FormNote>}
                <FormActions
                    action={
                        <Button
                            type="submit"
                            size="lg"
                            disabled={pending}
                            data-cuelume-press="pulse"
                        >
                            <PendingLabel
                                pending={pending}
                                idle={securityLabels[action]}
                                busy="Updating…"
                            />
                            <ArrowRightIcon aria-hidden="true" />
                        </Button>
                    }
                >
                    <button
                        type="button"
                        className="text-link"
                        disabled={pending}
                        data-cuelume-press=""
                        data-cuelume-release=""
                        onClick={onCancel}
                    >
                        Cancel
                    </button>
                </FormActions>
            </FormTable>
        </form>
    );
}
