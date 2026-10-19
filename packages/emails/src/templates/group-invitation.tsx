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
 * Someone invited you into a family. Same sheet as the share notice.
 * The family's name is whatever its organiser typed, so the mail leads with
 * who sent it (name and address), says plainly that HushOS never asks for a
 * password by email, and carries the one-time link in the fragment.
 *
 * Paper, in email form: a desk-coloured ground, one sheet with a hairline
 * edge, ink-blue text, dotted leaders between the facts, and a single blue
 * button. Dark mode swaps to the dark desk. Everything is inline-safe for
 * mail clients.
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

export default function GroupInvitation({
    inviterName = 'Ada Lovelace',
    inviterEmail = 'ada@example.com',
    groupName = 'The Lovelaces',
    joinUrl = 'http://localhost:5173/join#invite=token',
    logoUrl = '/static/hushos-logo-square.png',
    marker = 'preview',
}: {
    inviterName?: string;
    inviterEmail?: string;
    groupName?: string;
    joinUrl?: string;
    /** The logo: the brand square as one image, the same in both colour schemes. */
    logoUrl?: string;
    /** Different in every message; see the end of the body. */
    marker?: string;
}) {
    const facts: [string, string][] = [
        ['From', inviterName],
        ['Email', inviterEmail],
        // The organiser's own words, quoted as theirs: never HushOS speaking.
        ['Family, as they named it', `“${groupName}”`],
        ['Expires', 'In 7 days'],
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
                        html { background-color: #0f1013 !important; }
                        .email-body { background-color: #0f1013 !important; color: #ecedf1 !important; }
                        .email-body > table > tbody > tr > td { background-color: #0f1013 !important; color: #ecedf1 !important; }
                        .email-card { background-color: #17181c !important; border-color: #2a2c33 !important; }
                        .email-cell { border-color: #2a2c33 !important; }
                        .email-heading, .email-value { color: #ecedf1 !important; }
                        .email-muted { color: #9a9ea9 !important; }
                        .email-link { color: #aab8f4 !important; }
                        .email-button { background-color: #aab8f4 !important; color: #121833 !important; }
                    }
                    [data-ogsc] .email-body { background-color: #0f1013 !important; color: #ecedf1 !important; }
                    [data-ogsc] .email-body > table > tbody > tr > td { background-color: #0f1013 !important; color: #ecedf1 !important; }
                    [data-ogsc] .email-card { background-color: #17181c !important; border-color: #2a2c33 !important; }
                    [data-ogsc] .email-cell { border-color: #2a2c33 !important; }
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
            <Preview>{inviterName} invited you to join a family on HushOS.</Preview>
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
                                    Invitation
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
                            {inviterName} invited you to join a family.
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
                            {/*
                             * Who checks is any manager, not always the inviter, and the name may be
                             * the server's fallback ("A HushOS member"), so the check names nobody.
                             */}
                            Open the link to accept, signed in with this address. Then, on a call or
                            in person, you and a manager of the family check it’s really each other,
                            and you’re let in. Nothing in the family is shared with you before that.
                        </Text>
                    </Section>
                    <Section className="email-pad" style={{ padding: '0 28px 24px' }}>
                        <Button
                            className="email-button"
                            href={joinUrl}
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
                            See the invitation
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
                                                    fontWeight: 400,
                                                    color: '#17203a',
                                                    // A long address or name wraps rather than pushing the card off a phone.
                                                    overflowWrap: 'anywhere',
                                                    wordBreak: 'break-word',
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
                                margin: 0,
                                fontSize: '13px',
                                lineHeight: '20px',
                                color: '#5a6380',
                            }}
                        >
                            Not expecting this? Ignore it: nothing happens unless you accept, and
                            the link stops working in 7 days. HushOS never asks for your password by
                            email.{' '}
                            <Link
                                className="email-link"
                                href={joinUrl}
                                // The printed link is one long word: unbroken, it widened the card past a phone's edge.
                                style={{ color: '#2c428e', wordBreak: 'break-all' }}
                            >
                                {joinUrl}
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
