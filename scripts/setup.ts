import { randomBytes } from 'node:crypto';

const destination = Bun.file('.env');
const template = await Bun.file('.env.example').text();
const existing = await destination.exists();
let contents = existing ? await destination.text() : fresh(template);
// Add new settings without changing any existing value, including database passwords.
// A new secret gets its own random value rather than the template's placeholder.
for (const line of template.split('\n')) {
    const name = line.match(/^([A-Z_]+)=/)?.[1];
    if (name && !new RegExp(`^${name}=`, 'm').test(contents))
        contents += `\n${line.replace('change-me', secret())}`;
}
if (
    !/^OPAQUE_SERVER_SETUP=.+$/m.test(contents) ||
    /^OPAQUE_SERVER_SETUP=["']{2}\s*$/m.test(contents)
) {
    const process = Bun.spawn(
        [
            'bun',
            '--eval',
            "import { ready, server } from '@hushos/crypto/server'; await ready; console.log(server.createSetup())",
        ],
        { cwd: 'packages/auth', stdout: 'pipe', stderr: 'pipe' },
    );
    const setup = (await new Response(process.stdout).text()).trim();
    if ((await process.exited) !== 0 || !/^[A-Za-z0-9_-]+$/.test(setup))
        throw new Error('Could not generate the OPAQUE server setup. Run bun install and retry.');
    contents = contents.replace(/^OPAQUE_SERVER_SETUP=.*$/m, `OPAQUE_SERVER_SETUP=${setup}`);
}
await Bun.write('.env', `${contents.trimEnd()}\n`);
console.info(
    existing
        ? 'Preserved existing settings and added any missing configuration.'
        : 'Created .env with a unique local database password and OPAQUE server setup.',
);
console.info(`
Next steps:
1. bun run infra:up
2. bun run db:migrate
3. bun run dev

App: http://localhost:5173
Local inbox: http://localhost:8025
Email previews (separate): bun run email:preview
`);

// Each secret gets its own value; DATABASE_URL carries the Postgres password.
function fresh(template: string) {
    const password = secret();
    return template
        .split('\n')
        .map((line) =>
            line.replace(
                'change-me',
                /^(POSTGRES_PASSWORD|DATABASE_URL)=/.test(line) ? password : secret(),
            ),
        )
        .join('\n');
}

// 32 bytes as hex: the length Garage requires of its RPC secret.
function secret() {
    return randomBytes(32).toString('hex');
}
