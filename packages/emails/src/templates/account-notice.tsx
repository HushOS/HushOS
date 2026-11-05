import {
    Body,
    Button,
    Column,
    Container,
    Head,
    Heading,
    Html,
    Img,
    Link,
    Preview,
    Row,
    Section,
    Text,
} from 'react-email';

/*
 * Sign-up or recovery was asked for an address where it can't finish: sign-up
 * for an address that already has an account (`exists`), recovery for one that
 * has none (`none`). The page answers the same either way, so the form can't be
 * asked who has an account; the mail goes only to the address itself, and says
 * what to do instead. Neither carries a token: there is nothing to verify.
 * Same sheet as the verification email.
 */
/* Hidden everywhere, Outlook included; a variable, since React's types lack mso-hide. */
const hidden = { display: 'none', msoHide: 'all' };
const sans = 'Geist, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const label = {
    margin: 0,
    fontSize: '13px',
    lineHeight: '20px',
    fontWeight: 600,
    color: '#5a6380',
};

export type AccountNoticeKind = 'exists' | 'none';

export default function AccountNotice({
    kind = 'exists',
    signInUrl = 'http://localhost:5173/login',
    recoverUrl = 'http://localhost:5173/recover',
    registerUrl = 'http://localhost:5173/register',
    logoUrl = '/static/hushos-logo-square.png',
    marker = 'preview',
}: {
    kind?: AccountNoticeKind;
    /** `exists` only. */
    signInUrl?: string;
    /** `exists` only. */
    recoverUrl?: string;
    /** `none` only. */
    registerUrl?: string;
    /** The logo: the brand square as one image, the same in both colour schemes. */
    logoUrl?: string;
    /** Different in every message; see the end of the body. */
    marker?: string;
}) {
    const copy = {
        exists: {
            preview:
                'Someone asked to create a HushOS account with this email. You already have one.',
            label: 'Registration',
            heading: 'You already have a HushOS account.',
            body: 'Someone, probably you, asked to create an account with this email. There already is one, so nothing new was created. Sign in with your password.',
            button: { text: 'Sign in', href: signInUrl },
            aside: {
                text: 'Forgot your password? You can choose a new one with your recovery phrase.',
                link: 'Recover your account',
                href: recoverUrl,
            },
            footer: 'If you didn’t ask for this, you can ignore this email. Nothing about your account has changed.',
        },
        none: {
            preview:
                'Someone asked to recover a HushOS account with this email, but there isn’t one.',
            label: 'Recovery',
            heading: 'There’s no HushOS account for this email.',
            body: 'Someone, probably you, asked to recover an account with this email, but no account uses it. If you signed up with a different email, recover with that one instead, or create an account with this one.',
            button: { text: 'Create an account', href: registerUrl },
            aside: null,
            footer: 'If you didn’t ask for this, you can ignore this email. Nothing was created.',
        },
    }[kind];
    return (
        <Html lang="en">
            <Head>
                <meta name="color-scheme" content="light dark" />
                <meta name="supported-color-schemes" content="light dark" />
                {/* React Email moves the body's inline styles onto a cell inside it; the class stays on the body. */}
                <style>{`
                    :root { color-scheme: light dark; supported-color-schemes: light dark; }
                    html { background-color: #f3f4f8; }
                    @media (prefers-color-scheme: dark) {
                        html { background-color: #000000 !important; }
                        .email-body { background-color: #000000 !important; color: #ecedf1 !important; }
                        .email-body > table > tbody > tr > td { background-color: #000000 !important; color: #ecedf1 !important; }
                        .email-card { background-color: #1c1c1e !important; border-color: #38383a !important; }
                        .email-cell { border-color: #38383a !important; }
                        .email-heading, .email-value { color: #ecedf1 !important; }
                        .email-muted { color: #9a9ea9 !important; }
                        .email-link { color: #aab8f4 !important; }
                        .email-button { background-color: #aab8f4 !important; color: #121833 !important; }
                    }
                    [data-ogsc] .email-body { background-color: #000000 !important; color: #ecedf1 !important; }
                    [data-ogsc] .email-body > table > tbody > tr > td { background-color: #000000 !important; color: #ecedf1 !important; }
                    [data-ogsc] .email-card { background-color: #1c1c1e !important; border-color: #38383a !important; }
                    [data-ogsc] .email-cell { border-color: #38383a !important; }
                    [data-ogsc] .email-heading, [data-ogsc] .email-value { color: #ecedf1 !important; }
                    [data-ogsc] .email-muted { color: #9a9ea9 !important; }
                    [data-ogsc] .email-link { color: #aab8f4 !important; }
                    [data-ogsc] .email-button { background-color: #aab8f4 !important; color: #121833 !important; }
                    @media (max-width: 480px) {
                        .email-body > table > tbody > tr > td { padding: 16px 8px !important; }
                        .email-pad { padding: 20px 18px !important; }
                    }
                `}</style>
            </Head>
            <Preview>{copy.preview}</Preview>
            <Body
                className="email-body"
                style={{
                    backgroundColor: '#f3f4f8',
                    margin: 0,
                    padding: '40px 16px',
                    fontFamily: sans,
                    color: '#17203a',
                }}
            >
                <Container
                    className="email-card"
                    style={{
                        maxWidth: '560px',
                        margin: '0 auto',
                        backgroundColor: '#ffffff',
                        border: '1px solid #e2e5ee',
                        borderRadius: '16px',
                    }}
                >
                    <Section
                        className="email-pad email-cell"
                        style={{ padding: '18px 28px', borderBottom: '1px solid #e2e5ee' }}
                    >
                        <Row>
                            <Column style={{ width: '34px', verticalAlign: 'middle' }}>
                                {/*
                                 * The black square and its mark are one image: Gmail on iOS repaints
                                 * CSS colours in the dark but never images, so a square drawn in CSS
                                 * behind the mark turned white under it.
                                 */}
                                <Img
                                    src={logoUrl}
                                    alt=""
                                    width="26"
                                    height="26"
                                    style={{ display: 'block' }}
                                />
                            </Column>
                            <Column style={{ verticalAlign: 'middle' }}>
                                <Text
                                    className="email-heading"
                                    style={{
                                        margin: 0,
                                        fontSize: '16px',
                                        lineHeight: '26px',
                                        fontWeight: 700,
                                        color: '#17203a',
                                    }}
                                >
                                    HushOS
                                </Text>
                            </Column>
                            <Column style={{ verticalAlign: 'middle', textAlign: 'right' }}>
                                <Text className="email-muted" style={label}>
                                    {copy.label}
                                </Text>
                            </Column>
                        </Row>
                    </Section>
                    <Section className="email-pad" style={{ padding: '28px 28px 24px' }}>
                        <Heading
                            className="email-heading"
                            style={{
                                margin: '0 0 12px',
                                fontSize: '26px',
                                lineHeight: '32px',
                                fontWeight: 800,
                                letterSpacing: '-0.6px',
                                color: '#17203a',
                            }}
                        >
                            {copy.heading}
                        </Heading>
                        <Text
                            className="email-muted"
                            style={{
                                fontSize: '15px',
                                lineHeight: '24px',
                                margin: 0,
                                color: '#5a6380',
                            }}
                        >
                            {copy.body}
                        </Text>
                    </Section>
                    <Section className="email-pad" style={{ padding: '0 28px 28px' }}>
                        <Button
                            className="email-button"
                            href={copy.button.href}
                            style={{
                                display: 'inline-block',
                                backgroundColor: '#2c428e',
                                color: '#ffffff',
                                padding: '13px 22px',
                                borderRadius: '10px',
                                fontSize: '15px',
                                lineHeight: '20px',
                                fontWeight: 700,
                                textDecoration: 'none',
                            }}
                        >
                            {copy.button.text}
                        </Button>
                        {copy.aside && (
                            <Text
                                className="email-muted"
                                style={{
                                    fontSize: '14px',
                                    lineHeight: '22px',
                                    margin: '20px 0 0',
                                    color: '#5a6380',
                                }}
                            >
                                {copy.aside.text}{' '}
                                <Link
                                    className="email-link"
                                    href={copy.aside.href}
                                    style={{
                                        color: '#2c428e',
                                        fontWeight: 600,
                                        textDecoration: 'underline',
                                    }}
                                >
                                    {copy.aside.link}
                                </Link>
                            </Text>
                        )}
                    </Section>
                    <Section
                        className="email-pad email-cell"
                        style={{ padding: '20px 28px', borderTop: '1px solid #e2e5ee' }}
                    >
                        <Text
                            className="email-muted"
                            style={{
                                margin: 0,
                                fontSize: '13px',
                                lineHeight: '20px',
                                color: '#5a6380',
                            }}
                        >
                            {copy.footer}
                        </Text>
                    </Section>
                </Container>
                <Text
                    className="email-muted"
                    style={{
                        ...label,
                        fontWeight: 400,
                        maxWidth: '560px',
                        margin: '16px auto 0',
                        textAlign: 'center',
                    }}
                >
                    HushOS · Open source · Easy to self-host
                </Text>
                {/*
                 * Different in every message, and last: Gmail folds the end of a message
                 * behind "•••" when it matches an earlier one in the thread.
                 */}
                <span data-marker="" style={hidden}>
                    {marker}
                </span>
            </Body>
        </Html>
    );
}
