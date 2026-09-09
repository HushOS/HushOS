import type { SessionUser } from '@hushos/auth/protocol';
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
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

const nameFields = z.object({
    name: z.string().trim().min(1, 'Enter your name.').max(100, 'Use no more than 100 characters.'),
});

/* Inline name change: the one profile field the server lets you edit. */
export function ProfileNameForm({
    user,
    onCancel,
    onPending,
    onSuccess,
}: {
    user: SessionUser;
    onCancel: () => void;
    onPending: (pending: boolean) => void;
    onSuccess: () => void;
}) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const form = useForm({
        defaultValues: { name: user.name },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: nameFields },
        onSubmit: async ({ value }) => {
            setError('');
            setPending(true);
            onPending(true);
            try {
                await authClient.updateProfile(value.name);
                cue('success');
                // The session user lives in root route context; invalidating refetches it everywhere.
                await router.invalidate();
                onSuccess();
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
                <form.Field name="name">
                    {(field) => (
                        <AuthInput
                            label="Name"
                            hint="Shown to you and, later, to people you share with."
                            id="profile-name"
                            name={field.name}
                            type="text"
                            autoComplete="name"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onBlur={field.handleBlur}
                            errors={field.state.meta.errors}
                            disabled={pending}
                            required
                            maxLength={100}
                        />
                    )}
                </form.Field>
                {error && <FormNote tone="destructive">{error}</FormNote>}
                <FormActions
                    action={
                        <Button
                            type="submit"
                            size="lg"
                            disabled={pending}
                            data-cuelume-press="pulse"
                        >
                            <PendingLabel pending={pending} idle="Save name" busy="Saving…" />
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
