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
 * Someone shared something with you. Same sheet as the verification mail;
 * the server knows who shared and what role, never what the item is called.
 *
 * Paper, in email form: a desk-coloured ground, one sheet with a hairline
 * edge, ink-blue text, dotted leaders between the facts, and a single blue
 * button. Dark mode swaps to the dark desk. Everything is inline-safe for
 * mail clients.
 */
const sans = '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Arial, sans-serif';
const label = {
    margin: 0,
    fontSize: '13px',
    lineHeight: '20px',
    fontWeight: 600,
    color: '#5a6483',
};

export default function ShareNotice({
    granterName = 'Ada Lovelace',
    granterEmail = 'ada@example.com',
    role = 'viewer',
    sharedUrl = 'http://localhost:5173/app/shared',
    logoUrl = '/static/hushos-logo-dark.png',
}: {
    granterName?: string;
    granterEmail?: string;
    role?: 'viewer' | 'editor';
    sharedUrl?: string;
    /** The light mark; it sits on the brand blue in both colour schemes. */
    logoUrl?: string;
}) {
    const facts: [string, string][] = [
        ['From', granterName],
        ['Email', granterEmail],
        ['You can', role === 'editor' ? 'View and edit' : 'View and download'],
        ['Name of item', 'Encrypted'],
    ];
    return (
        <Html lang="en">
            <Head>
                <meta name="color-scheme" content="light dark" />
                <meta name="supported-color-schemes" content="light dark" />
                {/* React Email moves the body's inline styles onto a cell inside it; the class stays on the body. */}
                <style>{`
                    :root { color-scheme: light dark; supported-color-schemes: light dark; }
                    html { background-color: #e6e2d9; }
                    @media (prefers-color-scheme: dark) {
                        html { background-color: #13151b !important; }
                        .email-body { background-color: #13151b !important; color: #dfe3f2 !important; }
                        .email-body > table > tbody > tr > td { background-color: #13151b !important; color: #dfe3f2 !important; }
                        .email-card { background-color: #1c1f28 !important; border-color: #30343f !important; }
                        .email-cell { border-color: #30343f !important; }
                        .email-heading, .email-value { color: #dfe3f2 !important; }
                        .email-muted { color: #969eb8 !important; }
                        .email-link { color: #aab8f4 !important; }
                        .email-button { background-color: #aab8f4 !important; color: #121833 !important; }
                    }
                    [data-ogsc] .email-body { background-color: #13151b !important; color: #dfe3f2 !important; }
                    [data-ogsc] .email-body > table > tbody > tr > td { background-color: #13151b !important; color: #dfe3f2 !important; }
                    [data-ogsc] .email-card { background-color: #1c1f28 !important; border-color: #30343f !important; }
                    [data-ogsc] .email-cell { border-color: #30343f !important; }
                    [data-ogsc] .email-heading, [data-ogsc] .email-value { color: #dfe3f2 !important; }
                    [data-ogsc] .email-muted { color: #969eb8 !important; }
                    [data-ogsc] .email-link { color: #aab8f4 !important; }
                    [data-ogsc] .email-button { background-color: #aab8f4 !important; color: #121833 !important; }
                    @media (max-width: 480px) {
                        .email-body > table > tbody > tr > td { padding: 16px 8px !important; }
                        .email-pad { padding: 20px 18px !important; }
                    }
                `}</style>
            </Head>
            <Preview>{granterName} shared something with you on HushOS.</Preview>
            <Body
                className="email-body"
                style={{
                    backgroundColor: '#e6e2d9',
                    margin: 0,
                    padding: '40px 16px',
                    fontFamily: sans,
                    color: '#1c2848',
                }}
            >
                <Container
                    className="email-card"
                    style={{
                        maxWidth: '560px',
                        margin: '0 auto',
                        backgroundColor: '#fcfbf7',
                        border: '1px solid #d3d1ca',
                        borderRadius: '3px',
                    }}
                >
                    <Section
                        className="email-pad email-cell"
                        style={{ padding: '18px 28px', borderBottom: '1px solid #d3d1ca' }}
                    >
                        <Row>
                            <Column style={{ width: '34px', verticalAlign: 'middle' }}>
                                {/* The light mark on the brand blue, the same in both colour schemes. */}
                                <table role="presentation" cellPadding={0} cellSpacing={0}>
                                    <tbody>
                                        <tr>
                                            <td
                                                style={{
                                                    width: '26px',
                                                    height: '26px',
                                                    backgroundColor: '#2c428e',
                                                    borderRadius: '3px',
                                                    textAlign: 'center',
                                                    verticalAlign: 'middle',
                                                }}
                                            >
                                                <Img
                                                    src={logoUrl}
                                                    alt=""
                                                    width="11"
                                                    height="16"
                                                    style={{ display: 'block', margin: '0 auto' }}
                                                />
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </Column>
                            <Column style={{ verticalAlign: 'middle' }}>
                                <Text
                                    className="email-heading"
                                    style={{
                                        margin: 0,
                                        fontSize: '16px',
                                        lineHeight: '26px',
                                        fontWeight: 700,
                                        color: '#1c2848',
                                    }}
                                >
                                    HushOS
                                </Text>
                            </Column>
                            <Column style={{ verticalAlign: 'middle', textAlign: 'right' }}>
                                <Text className="email-muted" style={label}>
                                    Shared with you
                                </Text>
                            </Column>
                        </Row>
                    </Section>
                    <Section className="email-pad" style={{ padding: '28px 28px 8px' }}>
                        <Heading
                            className="email-heading"
                            style={{
                                margin: '0 0 12px',
                                fontSize: '26px',
                                lineHeight: '32px',
                                fontWeight: 700,
                                letterSpacing: '-0.3px',
                                color: '#1c2848',
                            }}
                        >
                            {granterName} shared something with you.
                        </Heading>
                        <Text
                            className="email-muted"
                            style={{
                                fontSize: '15px',
                                lineHeight: '24px',
                                margin: '0 0 20px',
                                color: '#5a6483',
                            }}
                        >
                            The key was sealed to your account on their device. HushOS cannot read
                            what it is; you will see its name once you open it.
                        </Text>
                    </Section>
                    <Section className="email-pad" style={{ padding: '0 28px 20px' }}>
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
                                                borderBottom: '1px dotted #b9bccb',
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
                                                borderBottom: '1px dotted #b9bccb',
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
                                                    color: '#1c2848',
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
                    <Section className="email-pad" style={{ padding: '4px 28px 28px' }}>
                        <Button
                            className="email-button"
                            href={sharedUrl}
                            style={{
                                display: 'inline-block',
                                backgroundColor: '#2c428e',
                                color: '#fcfbf7',
                                padding: '13px 22px',
                                borderRadius: '3px',
                                fontSize: '15px',
                                lineHeight: '20px',
                                fontWeight: 700,
                                textDecoration: 'none',
                            }}
                        >
                            Open shared with me →
                        </Button>
                    </Section>
                    <Section
                        className="email-pad email-cell"
                        style={{ padding: '20px 28px', borderTop: '1px solid #d3d1ca' }}
                    >
                        <Text
                            className="email-muted"
                            style={{
                                margin: 0,
                                fontSize: '13px',
                                lineHeight: '20px',
                                color: '#5a6483',
                            }}
                        >
                            Not expecting this? Nothing happens until you open it, and you can
                            remove it from Shared with me at any time.{' '}
                            <Link
                                className="email-link"
                                href={sharedUrl}
                                style={{ color: '#2c428e' }}
                            >
                                {sharedUrl}
                            </Link>
                        </Text>
                    </Section>
                </Container>
            </Body>
        </Html>
    );
}
