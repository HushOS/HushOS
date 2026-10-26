import {
    Body,
    Column,
    Container,
    Head,
    Heading,
    Html,
    Img,
    Preview,
    Row,
    Section,
    Text,
} from 'react-email';

/*
 * A family was dissolved: its last active member left. Sent to that member
 * (`dissolved`: when its folders are deleted, and that their own files are not
 * touched), and to everyone still joining it, who accepted and was not let in
 * (`accepted`) or held an invitation still open (`invited`): it no longer
 * exists, and nothing of theirs changed. The only value anyone typed is the
 * family's name, quoted as the organiser's; the date is written by the server,
 * in UTC. Same sheet as the plan ending, with no button: there is nothing to
 * open or do.
 *
 * Paper, in email form: a desk-coloured ground, one sheet with a hairline
 * edge, ink-blue text and dotted leaders between the facts. Dark mode swaps to
 * the dark desk. Everything is inline-safe for mail clients.
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

export type FamilyDissolvedKind = 'dissolved' | 'accepted' | 'invited';

export default function FamilyDissolved({
    kind = 'dissolved',
    groupName = 'The Lovelaces',
    deletesOn = '25 November 2026',
    logoUrl = '/static/hushos-logo-square.png',
    marker = 'preview',
}: {
    kind?: FamilyDissolvedKind;
    /** The family's name, as its organiser typed it. */
    groupName?: string;
    /** The day Drive's purge deletes the family's folders, written out in UTC (`dissolved` only). */
    deletesOn?: string;
    /** The logo: the brand square as one image, the same in both colour schemes. */
    logoUrl?: string;
    /** Different in every message; see the end of the body. */
    marker?: string;
}) {
    const copy = {
        dissolved: {
            preview: `Your HushOS family was dissolved. Its folders are deleted on ${deletesOn}.`,
            heading: 'Your family was dissolved.',
            body: `You were its last member, so leaving ended it. Its family folders and everything in them are deleted on ${deletesOn}. Until then nobody can open them, you included, and the family can’t be reopened.`,
            facts: [
                ['Family', `“${groupName}”`],
                ['Folders deleted', deletesOn],
                ['Your own files', 'Not touched'],
            ],
            footer: 'Your own files stay in your own space, on your own storage. If they’re over it, you can’t upload more until you make room. Nothing in your own space is deleted.',
        },
        accepted: {
            preview: 'The family you were joining on HushOS no longer exists.',
            heading: 'The family you were joining no longer exists.',
            body: 'Its last member left before you were let in, so the family was dissolved. Nothing in it was ever shared with you, and nothing of yours has changed.',
            facts: [
                // The organiser's own words, quoted as theirs: never HushOS speaking.
                ['Family, as they named it', `“${groupName}”`],
                ['Your acceptance', 'Closed'],
            ],
            footer: 'To join a family later, you need a new invitation.',
        },
        invited: {
            preview: 'The family you were invited to join on HushOS no longer exists.',
            heading: 'The family you were invited to join no longer exists.',
            body: 'Its last member left, so the family was dissolved. Your invitation was closed with it, and nothing of yours has changed.',
            facts: [
                ['Family, as they named it', `“${groupName}”`],
                ['Invitation', 'Closed'],
            ],
            footer: 'The link in the invitation no longer works. To join a family later, you need a new invitation.',
        },
    }[kind];
    const facts = copy.facts as [string, string][];
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
                                    Family
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
                            {copy.footer}
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
