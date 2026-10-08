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
const sans = 'Geist, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const label = {
    margin: 0,
    fontSize: '13px',
    lineHeight: '20px',
    fontWeight: 600,
    color: '#5a6380',
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
        ['Its name', 'Not in this email'],
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
                        html { background-color: #0e111a !important; }
                        .email-body { background-color: #0e111a !important; color: #e4e8f4 !important; }
                        .email-body > table > tbody > tr > td { background-color: #0e111a !important; color: #e4e8f4 !important; }
                        .email-card { background-color: #161a26 !important; border-color: #262b3a !important; }
                        .email-logo { background-color: #343b52 !important; }
                        .email-cell { border-color: #262b3a !important; }
                        .email-heading, .email-value { color: #e4e8f4 !important; }
                        .email-muted { color: #9aa3be !important; }
                        .email-link { color: #aab8f4 !important; }
                        .email-button { background-color: #aab8f4 !important; color: #121833 !important; }
                    }
                    [data-ogsc] .email-body { background-color: #0e111a !important; color: #e4e8f4 !important; }
                    [data-ogsc] .email-body > table > tbody > tr > td { background-color: #0e111a !important; color: #e4e8f4 !important; }
                    [data-ogsc] .email-card { background-color: #161a26 !important; border-color: #262b3a !important; }
                    [data-ogsc] .email-logo { background-color: #343b52 !important; }
                    [data-ogsc] .email-cell { border-color: #262b3a !important; }
                    [data-ogsc] .email-heading, [data-ogsc] .email-value { color: #e4e8f4 !important; }
                    [data-ogsc] .email-muted { color: #9aa3be !important; }
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
                                 * The light mark on an ink square, monochrome as on the site. In the dark
                                 * the square lightens a step so it stays clear of the dark card; the mark,
                                 * an image, can't swap to the dark one as the site's does.
                                 */}
                                <table role="presentation" cellPadding={0} cellSpacing={0}>
                                    <tbody>
                                        <tr>
                                            <td
                                                className="email-logo"
                                                style={{
                                                    width: '26px',
                                                    height: '26px',
                                                    backgroundColor: '#17203a',
                                                    borderRadius: '8px',
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
                                        color: '#17203a',
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
                                fontWeight: 800,
                                letterSpacing: '-0.6px',
                                color: '#17203a',
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
                                color: '#5a6380',
                            }}
                        >
                            HushOS can’t see what it is either, so this email can’t name it. You’ll
                            see it once you open HushOS.
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
                                                borderBottom: '1px solid #e2e5ee',
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
                                                borderBottom: '1px solid #e2e5ee',
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
                                color: '#ffffff',
                                padding: '13px 22px',
                                borderRadius: '10px',
                                fontSize: '15px',
                                lineHeight: '20px',
                                fontWeight: 700,
                                textDecoration: 'none',
                            }}
                        >
                            Open HushOS
                        </Button>
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
