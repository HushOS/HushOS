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
 * The site's look, in email form: the light ground, one white card with a
 * hairline edge and 16px corners, ink text, facts in ruled rows, the logo
 * square, and a single blue button. Mono only for the link to copy.
 * Dark mode swaps to the dark ground and card. Inline-safe for mail clients.
 */
const mono = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
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

export default function VerifyEmail({
    purpose = 'register',
    logoUrl = '/static/hushos-logo-square.png',
    marker = 'preview',
    verificationUrl = 'http://localhost:5173/register/complete#verify=preview',
}: {
    purpose?: 'register' | 'recover';
    verificationUrl?: string;
    /** The logo: the brand square as one image, the same in both colour schemes. */
    logoUrl?: string;
    /** Different in every message; see the end of the body. */
    marker?: string;
}) {
    const recover = purpose === 'recover';
    const facts: [string, string][] = [
        ['Purpose', recover ? 'Recover account' : 'Create account'],
        ['Expires', '30 minutes'],
        ['Uses', 'Once'],
        ['Password sent', 'Never'],
    ];
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
            <Preview>
                {recover
                    ? 'Verify your email to recover your HushOS account.'
                    : 'Verify your email to create your HushOS account.'}
            </Preview>
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
                                    {recover ? 'Recovery' : 'Registration'}
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
                            {recover
                                ? 'Let’s get you back in.'
                                : 'Confirm your email to get started.'}
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
                            {recover
                                ? 'Verify your email, then use your 24-word recovery phrase to choose a new password. This link alone cannot unlock your account.'
                                : 'Verify your email, then choose your name and password to finish creating your account.'}
                        </Text>
                    </Section>
                    <Section className="email-pad" style={{ padding: '0 28px 24px' }}>
                        <Button
                            className="email-button"
                            href={verificationUrl}
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
                            Verify email
                        </Button>
                    </Section>
                    <Section className="email-pad" style={{ padding: '0 28px 28px' }}>
                        <table
                            role="presentation"
                            cellPadding={0}
                            cellSpacing={0}
                            width="100%"
                            style={{ borderCollapse: 'collapse' }}
                        >
                            <tbody>
                                {facts.map(([key, value]) => (
                                    <tr key={key}>
                                        <td
                                            className="email-cell"
                                            style={{
                                                width: '44%',
                                                padding: '9px 0',
                                                borderTop: '1px solid #e2e5ee',
                                            }}
                                        >
                                            <Text className="email-muted" style={label}>
                                                {key}
                                            </Text>
                                        </td>
                                        <td
                                            className="email-cell"
                                            style={{
                                                padding: '9px 0',
                                                borderTop: '1px solid #e2e5ee',
                                                textAlign: 'right',
                                            }}
                                        >
                                            <Text
                                                className="email-value"
                                                style={{
                                                    margin: 0,
                                                    fontSize: '14px',
                                                    lineHeight: '20px',
                                                    fontWeight: value === 'Never' ? 700 : 400,
                                                    color: '#17203a',
                                                }}
                                            >
                                                {value}
                                            </Text>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </Section>
                    <Section
                        className="email-pad email-cell"
                        style={{ padding: '20px 28px', borderTop: '1px solid #e2e5ee' }}
                    >
                        <Text
                            className="email-muted"
                            style={{
                                fontSize: '13px',
                                lineHeight: '20px',
                                margin: '0 0 12px',
                                color: '#5a6380',
                            }}
                        >
                            If you didn’t request this, you can ignore this email. Nothing changes
                            until the link is opened.
                        </Text>
                        <Text className="email-muted" style={{ ...label, margin: '0 0 6px' }}>
                            Link
                        </Text>
                        <Link
                            className="email-link"
                            href={verificationUrl}
                            style={{
                                fontFamily: mono,
                                fontSize: '12px',
                                lineHeight: '18px',
                                color: '#2c428e',
                                wordBreak: 'break-all',
                            }}
                        >
                            {verificationUrl}
                        </Link>
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
