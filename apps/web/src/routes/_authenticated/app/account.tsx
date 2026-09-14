import type { SecurityAction, SessionUser } from '@hushos/auth/protocol';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon, PencilIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AccountSecurityForm, securityLabels } from '@/components/account-security-form';
import { ProfileNameForm } from '@/components/profile-name-form';
import { AuthInput } from '@/components/auth-input';
import { CopyValue } from '@/components/copy-value';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { Collapse, PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/account')({
    head: () => ({ meta: [{ title: 'Account settings · HushOS' }] }),
    component: AccountPage,
});

/* A ledger row on the same 152px grid as the form tables, so rows and forms line up. */
const rowGrid = 'grid sm:grid-cols-[9.5rem_minmax(0,1fr)]';
const rowLabel =
    'eyebrow flex items-center px-4 pt-3.5 text-muted-foreground sm:h-12 sm:border-r sm:pt-0';
const rowValue =
    'flex min-w-0 items-center py-3.5 pr-5 pl-4 font-mono text-[13px] wrap-anywhere sm:h-12 sm:py-0 sm:pr-6';

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
    return (
        <div className={`${rowGrid} border-b last:border-b-0`}>
            <dt className={rowLabel}>{label}</dt>
            <dd className={rowValue}>{copy ? <CopyValue value={value} label={label} /> : value}</dd>
        </div>
    );
}

/* An editable row: the whole row is the control, and the blue pencil says so. */
function EditableRow({
    label,
    value,
    disabled,
    onEdit,
}: {
    label: string;
    value: string;
    disabled?: boolean;
    onEdit: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onEdit}
            aria-label={`Edit ${label.toLowerCase()}`}
            data-cuelume-press="press"
            data-cuelume-release="release"
            className={`${rowGrid} w-full cursor-pointer border-b text-left transition-colors outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50`}
        >
            <span className={rowLabel}>{label}</span>
            <span className={`${rowValue} justify-between gap-4`}>
                <span className="truncate">{value}</span>
                <PencilIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            </span>
        </button>
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
    const [editingName, setEditingName] = useState(false);
    const [nameSuccess, setNameSuccess] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    /* One inline form at a time: opening any of them closes the others. */
    function openSecurity(action: SecurityAction) {
        setSecurityAction(action);
        setSecuritySuccess('');
        setEditingName(false);
        setNameSuccess('');
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
                <Collapse open={Boolean(nameSuccess)} className="border-b">
                    <output className="block">
                        <FormNote>{nameSuccess}</FormNote>
                    </output>
                </Collapse>
                <Collapse open={!editingName}>
                    <EditableRow
                        label="Name"
                        value={user.name}
                        disabled={securityPending || pending}
                        onEdit={() => {
                            setEditingName(true);
                            setNameSuccess('');
                            setSecurityAction(null);
                            setSecuritySuccess('');
                            setConfirming(false);
                        }}
                    />
                </Collapse>
                <Collapse open={editingName} className="border-b">
                    <ProfileNameForm
                        user={user}
                        onCancel={() => setEditingName(false)}
                        onPending={setSecurityPending}
                        onSuccess={() => {
                            setEditingName(false);
                            setNameSuccess('Name updated.');
                        }}
                    />
                </Collapse>
                <dl>
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
                            setEditingName(false);
                            setNameSuccess('');
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
