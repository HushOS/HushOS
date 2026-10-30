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
 * A security notice about the account's devices: a new sign-in with the
 * password, a device removed, or every other device removed. Always sent; it
 * cannot be turned off. It never names the device: a device's name is what the
 * device said about itself, so whoever signed in would choose the words. Nor the
 * address or browser. When, and where to look.
 *
 * The same sheet as the share notice: the cool ground, one white card, the
 * facts as ruled rows, one blue button.
 */
export type SecurityNoticeKind =
    | 'new-device'
    | 'device-removed'
    | 'devices-removed'
    | 'password-attempts';

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

const copy: Record<
    SecurityNoticeKind,
    { preview: string; heading: string; body: string; facts: [string, string][]; foot: string }
> = {
    'new-device': {
        preview: 'Your HushOS account was signed in to on a new device.',
        heading: 'A new device signed in to your account.',
        body: 'Someone signed in with your email and password on a device HushOS hadn’t seen before. It now appears in your list of devices.',
        facts: [
            ['When', '{{when}}'],
            ['Signed in with', 'Your password'],
        ],
        foot: 'If this was you, there’s nothing to do. If it wasn’t, remove the device from your account and change your password.',
    },
    'device-removed': {
        preview: 'A device was removed from your HushOS account.',
        heading: 'A device was removed from your account.',
        body: 'One of your devices removed another from your account. It was signed out and needs your password to sign in again.',
        facts: [['When', '{{when}}']],
        foot: 'If you didn’t do this, someone else may be signed in to your account. Check your devices and change your password.',
    },
    'password-attempts': {
        preview: 'Someone signed in to your HushOS account kept starting to confirm your password.',
        heading: 'Someone kept trying to confirm your password.',
        body: 'A device signed in to your account started confirming your password several times in an hour without finishing. That can mean someone is guessing it.',
        facts: [['When', '{{when}}']],
        foot: 'If this wasn’t you, change your password and remove any device you don’t recognise.',
    },
    'devices-removed': {
        preview: 'Devices were removed from your HushOS account.',
        heading: 'Your other devices were removed.',
        body: 'One of your devices removed every other device from your account. They were signed out and need your password to sign in again.',
        facts: [
            ['When', '{{when}}'],
            ['Devices removed', '{{count}}'],
        ],
        foot: 'If you didn’t do this, someone else may be signed in to your account. Check your devices and change your password.',
    },
};

export default function SecurityNotice({
    kind = 'new-device',
    when = 'Today, 14:02 UTC',
    count = '2',
    accountUrl = 'http://localhost:5173/app/account#devices',
    logoUrl = '/static/hushos-logo-square.png',
    marker = 'preview',
}: {
    kind?: SecurityNoticeKind;
    when?: string;
    count?: string;
    accountUrl?: string;
    logoUrl?: string;
    /** Different in every message; see the end of the body. */
    marker?: string;
}) {
    const text = copy[kind];
    const fill = (value: string) => value.replace('{{when}}', when).replace('{{count}}', count);
    return (
        <Html lang="en">
            <Head>
                <meta name="color-scheme" content="light dark" />
                <meta name="supported-color-schemes" content="light dark" />
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
            <Preview>{text.preview}</Preview>
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
                                    Security notice
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
                            {text.heading}
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
                            {text.body}
                        </Text>
                    </Section>
                    <Section className="email-pad" style={{ padding: '0 28px 24px' }}>
                        <Button
                            className="email-button"
                            href={accountUrl}
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
                            Review your devices
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
                                {text.facts.map(([key, value]) => (
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
                                                    fontWeight: 400,
                                                    color: '#17203a',
                                                }}
                                            >
                                                {fill(value)}
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
                                margin: 0,
                                fontSize: '13px',
                                lineHeight: '20px',
                                color: '#5a6380',
                            }}
                        >
                            {text.foot} These notices can’t be turned off.{' '}
                            <Link
                                className="email-link"
                                href={accountUrl}
                                style={{ color: '#2c428e' }}
                            >
                                {accountUrl}
                            </Link>
                        </Text>
                    </Section>
                </Container>
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
