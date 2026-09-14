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
 * Someone shared something with you. Same Ledger as the verification mail;
 * the server knows who shared and what role, never what the item is called.
 *
 * The Ledger, in email form: paper and ink, one ink rule around a table of
 * cells, mono uppercase labels, and a single blue block for the action. Dark
 * mode swaps to the black terminal. Everything is inline-safe for mail clients.
 */
const mono = '"Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const sans = 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
const eyebrow = {
    margin: 0,
    fontFamily: mono,
    fontSize: '11px',
    lineHeight: '16px',
    fontWeight: 500,
    letterSpacing: '1.3px',
    textTransform: 'uppercase' as const,
    color: '#6b6a63',
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
    /** The light mark; it sits on the blue brand cell in both colour schemes. */
    logoUrl?: string;
}) {
    const ledger: [string, string][] = [
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
                <style>{`
                    :root { color-scheme: light dark; supported-color-schemes: light dark; }
                    html { background-color: #f4f3ee; }
                    @media (prefers-color-scheme: dark) {
                        html { background-color: #000000 !important; }
                        .email-body { background-color: #000000 !important; color: #e6e8ee !important; }
                        .email-card { background-color: #0f1014 !important; border-color: #3a3d45 !important; }
                        .email-cell { border-color: #3a3d45 !important; }
                        .email-heading, .email-value { color: #e6e8ee !important; }
                        .email-muted { color: #9a9ea8 !important; }
                        .email-link { color: #8fb4ff !important; }
                        .email-button { background-color: #8fb4ff !important; color: #000000 !important; }
                    }
                    [data-ogsc] .email-body { background-color: #000000 !important; color: #e6e8ee !important; }
                    [data-ogsc] .email-card { background-color: #0f1014 !important; border-color: #3a3d45 !important; }
                    [data-ogsc] .email-cell { border-color: #3a3d45 !important; }
                    [data-ogsc] .email-heading, [data-ogsc] .email-value { color: #e6e8ee !important; }
                    [data-ogsc] .email-muted { color: #9a9ea8 !important; }
                    [data-ogsc] .email-link { color: #8fb4ff !important; }
                    [data-ogsc] .email-button { background-color: #8fb4ff !important; color: #000000 !important; }
                    @media (max-width: 480px) {
                        .email-body { padding: 16px 8px !important; }
                        .email-pad { padding: 20px 18px !important; }
                    }
                `}</style>
            </Head>
            <Preview>{granterName} shared something with you on HushOS.</Preview>
            <Body
                className="email-body"
                style={{
                    backgroundColor: '#f4f3ee',
                    margin: 0,
                    padding: '40px 16px',
                    fontFamily: sans,
                    color: '#1f1f1d',
                }}
            >
                <Container
                    className="email-card"
                    style={{
                        maxWidth: '560px',
                        margin: '0 auto',
                        backgroundColor: '#fbfaf6',
                        border: '1px solid #1f1f1d',
                    }}
                >
                    <Row>
                        <Column
                            style={{
                                width: '132px',
                                backgroundColor: '#3b6acc',
                                padding: '12px 16px',
                                verticalAlign: 'middle',
                            }}
                        >
                            <Row>
                                <Column style={{ width: '22px', verticalAlign: 'middle' }}>
                                    <Img src={logoUrl} alt="" width="14" height="20" />
                                </Column>
                                <Column style={{ verticalAlign: 'middle' }}>
                                    <Text
                                        style={{
                                            margin: 0,
                                            fontFamily: mono,
                                            fontSize: '13px',
                                            lineHeight: '20px',
                                            fontWeight: 600,
                                            letterSpacing: '1.8px',
                                            color: '#ffffff',
                                        }}
                                    >
                                        HUSHOS
                                    </Text>
                                </Column>
                            </Row>
                        </Column>
                        <Column
                            className="email-cell"
                            style={{
                                padding: '12px 16px',
                                borderBottom: '1px solid #1f1f1d',
                                verticalAlign: 'middle',
                                textAlign: 'right',
                            }}
                        >
                            <Text style={eyebrow}>Shared with you</Text>
                        </Column>
                    </Row>
                    <Section className="email-pad" style={{ padding: '28px 28px 8px' }}>
                        <Heading
                            className="email-heading"
                            style={{
                                margin: '0 0 12px',
                                fontSize: '26px',
                                lineHeight: '32px',
                                fontWeight: 500,
                                letterSpacing: '-0.4px',
                                color: '#1f1f1d',
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
                                color: '#6b6a63',
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
                            className="email-cell"
                            style={{ border: '1px solid #1f1f1d', borderCollapse: 'collapse' }}
                        >
                            <tbody>
                                {ledger.map(([key, value], index) => (
                                    <tr key={key}>
                                        <td
                                            className="email-cell"
                                            style={{
                                                width: '44%',
                                                padding: '10px 14px',
                                                borderRight: '1px solid #1f1f1d',
                                                borderBottom:
                                                    index === ledger.length - 1
                                                        ? undefined
                                                        : '1px solid #1f1f1d',
                                            }}
                                        >
                                            <Text style={eyebrow}>{key}</Text>
                                        </td>
                                        <td
                                            className="email-cell"
                                            style={{
                                                padding: '10px 14px',
                                                borderBottom:
                                                    index === ledger.length - 1
                                                        ? undefined
                                                        : '1px solid #1f1f1d',
                                            }}
                                        >
                                            <Text
                                                className="email-value"
                                                style={{
                                                    margin: 0,
                                                    fontFamily: mono,
                                                    fontSize: '13px',
                                                    lineHeight: '18px',
                                                    fontWeight: 400,
                                                    color: '#1f1f1d',
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
                    <Section className="email-cell" style={{ borderTop: '1px solid #1f1f1d' }}>
                        <Button
                            className="email-button"
                            href={sharedUrl}
                            style={{
                                display: 'block',
                                backgroundColor: '#3b6acc',
                                color: '#ffffff',
                                padding: '20px 28px',
                                fontFamily: mono,
                                fontSize: '13px',
                                lineHeight: '16px',
                                fontWeight: 500,
                                letterSpacing: '1.3px',
                                textTransform: 'uppercase',
                                textDecoration: 'none',
                                textAlign: 'left',
                            }}
                        >
                            Open shared with me →
                        </Button>
                    </Section>
                    <Section
                        className="email-pad email-cell"
                        style={{ padding: '20px 28px', borderTop: '1px solid #1f1f1d' }}
                    >
                        <Text
                            className="email-muted"
                            style={{
                                margin: 0,
                                fontSize: '13px',
                                lineHeight: '20px',
                                color: '#6b6a63',
                            }}
                        >
                            Not expecting this? Nothing happens until you open it, and you can
                            remove it from Shared with me at any time.{' '}
                            <Link
                                className="email-link"
                                href={sharedUrl}
                                style={{ color: '#3b6acc' }}
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
