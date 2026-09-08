import type { SecurityAction, SessionUser } from '@hushos/auth/protocol';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AccountSecurityForm, securityLabels } from '@/components/account-security-form';
import { AuthInput } from '@/components/auth-input';
import { CopyValue } from '@/components/copy-value';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { Collapse, PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/app/account')({
    head: () => ({ meta: [{ title: 'Account settings · HushOS' }] }),
    component: AccountPage,
});

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
    return (
        <div className="grid border-b last:border-b-0 sm:grid-cols-[10rem_1fr]">
            <dt className="eyebrow flex items-center px-5 pt-3.5 text-muted-foreground sm:border-r sm:px-8 sm:pt-0">
                {label}
            </dt>
            <dd className="flex items-center px-5 py-3.5 font-mono text-[13px] wrap-anywhere sm:px-6">
                {copy ? <CopyValue value={value} label={label} /> : value}
            </dd>
        </div>
    );
}

function Section({
    id,
    title,
    description,
    tone = 'default',
    children,
}: {
    id: string;
    title: string;
    description: string;
    tone?: 'default' | 'destructive';
    children: React.ReactNode;
}) {
    return (
        <section aria-labelledby={id} className="border-b">
            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="px-5 py-6 lg:border-r sm:px-8">
                    <h2
                        id={id}
                        className={`eyebrow flex items-center gap-2 ${tone === 'destructive' ? 'text-destructive' : ''}`}
                    >
                        {tone === 'destructive' && (
                            <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                        )}
                        {title}
                    </h2>
                    <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                        {description}
                    </p>
                </div>
                <div className="border-t lg:border-t-0">{children}</div>
            </div>
        </section>
    );
}

/*
 * A security action: one ghost row that opens into its inline form, using the
 * same collapse as the delete confirmation so every section moves alike.
 */
function SecurityRow({
    action,
    user,
    open,
    disabled,
    className,
    onOpen,
    onClose,
    onSuccess,
    onPending,
}: {
    action: SecurityAction;
    user: SessionUser;
    open: boolean;
    disabled: boolean;
    className?: string;
    onOpen: () => void;
    onClose: () => void;
    onSuccess: () => void;
    onPending: (pending: boolean) => void;
}) {
    return (
        <>
            <Collapse open={!open} className={className}>
                <Button variant="row" size="row" disabled={disabled} onClick={onOpen}>
                    {securityLabels[action]} <ArrowRightIcon aria-hidden="true" />
                </Button>
            </Collapse>
            <Collapse open={open} className={className}>
                <AccountSecurityForm
                    user={user}
                    action={action}
                    onCancel={onClose}
                    onPending={onPending}
                    onSuccess={onSuccess}
                />
            </Collapse>
        </>
    );
}

function AccountPage() {
    const { user } = Route.useRouteContext();
    const router = useRouter();
    const [securityAction, setSecurityAction] = useState<SecurityAction | null>(null);
    const [securityPending, setSecurityPending] = useState(false);
    const [securitySuccess, setSecuritySuccess] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    function openSecurity(action: SecurityAction) {
        setSecurityAction(action);
        setSecuritySuccess('');
        setConfirming(false);
    }
    const deleteFields = z.object({
        email: z
            .string()
            .trim()
            .refine(
                (value) => value.toLowerCase() === user.email.toLowerCase(),
                'Enter your account email to confirm.',
            ),
        password: z.string().min(1, 'Enter your password.').max(128),
    });
    const form = useForm({
        defaultValues: { email: '', password: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: deleteFields },
        onSubmit: async ({ value }) => {
            setPending(true);
            setError('');
            try {
                await authClient.deleteAccount(value.password);
                form.reset();
                router.options.context.queryClient.clear();
                await router.invalidate();
                await router.navigate({ to: '/account-deleted', replace: true });
            } catch (error) {
                cue('error');
                setError(authError(error));
            } finally {
                setPending(false);
            }
        },
    });
    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Account"
                title="Account settings"
                description="Manage your password, encryption keys, and account."
            />
            <Section
                id="profile-title"
                title="Profile"
                description="Your name, email, and account ID."
            >
                <dl>
                    <Row label="Name" value={user.name} />
                    <Row label="Email" value={user.email} />
                    <Row label="Account ID" value={user.id} copy />
                </dl>
            </Section>
            <Section
                id="password-title"
                title="Password"
                description="The password you use to sign in and unlock your account key on this device."
            >
                <Collapse open={Boolean(securitySuccess)} className="border-b">
                    <output className="block">
                        <FormNote>{securitySuccess}</FormNote>
                    </output>
                </Collapse>
                <SecurityRow
                    action="password"
                    user={user}
                    open={securityAction === 'password'}
                    disabled={securityPending || pending}
                    onOpen={() => openSecurity('password')}
                    onClose={() => setSecurityAction(null)}
                    onPending={setSecurityPending}
                    onSuccess={() => {
                        setSecurityAction(null);
                        setSecuritySuccess(
                            'Password changed. Other sessions have been signed out.',
                        );
                    }}
                />
            </Section>
            <Section
                id="recovery-title"
                title="Recovery phrase"
                description="Your 24 words are the only way to reset a forgotten password without losing your account key. Review them any time this device is unlocked."
            >
                <Button
                    variant="row"
                    size="row"
                    render={<Link to="/app/recovery-key" />}
                    nativeButton={false}
                >
                    View recovery phrase <ArrowRightIcon aria-hidden="true" />
                </Button>
                <SecurityRow
                    action="recovery-key"
                    user={user}
                    className="border-t"
                    open={securityAction === 'recovery-key'}
                    disabled={securityPending || pending}
                    onOpen={() => openSecurity('recovery-key')}
                    onClose={() => setSecurityAction(null)}
                    onPending={setSecurityPending}
                    onSuccess={() => setSecurityAction(null)}
                />
            </Section>
            <Section
                id="master-key-title"
                title="Master key"
                description="The root key that protects your account’s private keys. Rotating it also creates a new recovery phrase."
            >
                <SecurityRow
                    action="master-key"
                    user={user}
                    open={securityAction === 'master-key'}
                    disabled={securityPending || pending}
                    onOpen={() => openSecurity('master-key')}
                    onClose={() => setSecurityAction(null)}
                    onPending={setSecurityPending}
                    onSuccess={() => setSecurityAction(null)}
                />
            </Section>
            <Section
                id="delete-title"
                tone="destructive"
                title="Permanently delete account"
                description="This deletes your profile, personal workspace, storage allowance, encryption-key bundles, and all sessions. Your recovery phrase cannot restore a deleted account."
            >
                <Collapse open={!confirming}>
                    <Button
                        variant="row"
                        size="row"
                        className="text-destructive hover:bg-destructive/10 [&>svg]:text-destructive"
                        disabled={securityPending}
                        onClick={() => {
                            setConfirming(true);
                            setSecurityAction(null);
                            setSecuritySuccess('');
                        }}
                    >
                        Delete account… <ArrowRightIcon aria-hidden="true" />
                    </Button>
                </Collapse>
                <Collapse open={confirming}>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void form.handleSubmit();
                        }}
                        noValidate
                        aria-busy={pending}
                    >
                        <FormTable className="border-0">
                            <form.Field name="email">
                                {(field) => (
                                    <AuthInput
                                        label="Email"
                                        hint="Type your account email to confirm."
                                        id="delete-email"
                                        name={field.name}
                                        type="email"
                                        autoComplete="off"
                                        placeholder={user.email}
                                        value={field.state.value}
                                        onChange={(event) => field.handleChange(event.target.value)}
                                        onBlur={field.handleBlur}
                                        errors={field.state.meta.errors}
                                        disabled={pending}
                                        required
                                    />
                                )}
                            </form.Field>
                            <form.Field name="password">
                                {(field) => (
                                    <AuthInput
                                        label="Password"
                                        id="delete-password"
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
                            {error && <FormNote tone="destructive">{error}</FormNote>}
                            <FormActions
                                action={
                                    <Button
                                        variant="destructive"
                                        size="lg"
                                        type="submit"
                                        disabled={pending}
                                    >
                                        <PendingLabel
                                            pending={pending}
                                            idle="Delete forever"
                                            busy="Deleting…"
                                        />
                                        <TriangleAlertIcon aria-hidden="true" />
                                    </Button>
                                }
                            >
                                <button
                                    type="button"
                                    className="text-link"
                                    disabled={pending}
                                    data-cuelume-press=""
                                    data-cuelume-release=""
                                    onClick={() => {
                                        setConfirming(false);
                                        form.reset();
                                        setError('');
                                    }}
                                >
                                    Cancel
                                </button>
                            </FormActions>
                        </FormTable>
                    </form>
                </Collapse>
            </Section>
        </div>
    );
}
